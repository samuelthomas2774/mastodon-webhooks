import createDebug from 'debug';
import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction, Client, GatewayIntentBits, Guild, Interaction, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, TextBasedChannel } from 'discord.js';
import { APIEmbed } from 'discord-api-types/v9';
import Turndown from 'turndown';
import { Database } from 'sqlite';
import sql from 'sql-template-strings';
import MastodonApi, { Account, SearchResults, Status } from './mastodon.js';
import { Webhook } from './webhook.js';

const debug = createDebug('discord');

const turndown = new Turndown();

const commands = [
    new SlashCommandBuilder()
        .setName('lookup')
        .setDescription('Search for an ActivityPub actor')
        .addStringOption(option => option
            .setName('id')
            .setDescription('username, account URI or local Mastodon account ID')
            .setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName('following')
        .setDescription('List ActivityPub actors posted to this channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks)
        .toJSON(),
    new SlashCommandBuilder()
        .setName('follow')
        .setDescription('Follow an ActivityPub actor and send their statuses in this channel')
        .addStringOption(option => option
            .setName('id')
            .setDescription('username, account URI or local Mastodon account ID')
            .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks)
        .toJSON(),
];

export default class DiscordBot {
    client: Client;
    api: REST;

    constructor(
        readonly db: Database,
        readonly mastodon: MastodonApi,
        token: string,
    ) {
        this.client = new Client({
            intents: [GatewayIntentBits.Guilds],
        });

        this.client.login(token);
        this.api = this.client.rest;

        this.client.on('ready', client => this.handleClientReady(client));
        this.client.on('interactionCreate', interaction => this.handleInteraction(interaction));
    }

    async handleClientReady(client: Client<true>) {
        debug('Logged in as %s', client.user.tag);

        this.registerCommands(client.application.id);
    }

    async registerCommands(client_id: string) {
        debug('Started refreshing application (/) commands');

        await this.api.put(Routes.applicationCommands(client_id), {
            body: commands,
        });

        debug('Successfully reloaded application (/) commands');
    }

    async handleInteraction(interaction: Interaction) {
        try {
            if (interaction.isChatInputCommand()) {
                if (interaction.commandName === 'lookup') {
                    const id = interaction.options.getString('id')!;
                    await this.handleLookupCommand(interaction, id);
                }

                if (interaction.commandName === 'following') {
                    await this.handleFollowingCommand(interaction);
                }

                if (interaction.commandName === 'follow') {
                    const id = interaction.options.getString('id')!;
                    await this.handleFollowCommand(interaction, id);
                }

                if (interaction.commandName === 'unfollow') {
                    const id = interaction.options.getString('id')!;
                    await this.handleUnfollowCommand(interaction, id);
                }
            }

            if (interaction.isButton()) {
                if (interaction.customId.startsWith('follow:')) {
                    const id = interaction.customId.substr(7);
                    await this.handleConfirmFollowButton(interaction, id);
                }
            }
        } catch (err) {
            debug('Error handling interaction', interaction, err);
        }
    }

    async handleLookupCommand(interaction: ChatInputCommandInteraction, id: string) {
        await interaction.deferReply();

        const accounts = await this.findAccounts(id);

        if (accounts.length > 1) {
            await interaction.editReply('Multiple results found');
        }

        for (const account of accounts.slice(0, 1)) {
            const embed = this.createAccountEmbed(account, true);

            const message = {
                content: account.url,
                embeds: [embed],
            };

            if (accounts.length === 1) await interaction.editReply(message);
            else await interaction.channel?.send(message);
        }

        if (!accounts.length) {
            await interaction.editReply('No result found');
        }
    }

    async handleFollowingCommand(interaction: ChatInputCommandInteraction) {
        if (!interaction.guild || !interaction.channel) {
            await interaction.reply('This action can only be performed in text channels in servers.');
            return;
        }

        const discord_webhooks = await this.getWebhooksForChannel(interaction.guild, interaction.channel);

        const webhooks = await Promise.all(discord_webhooks.map(w => this.db.all<Webhook[]>(
            sql`SELECT * FROM webhooks WHERE type = 'discord' AND url = ${w.url}`))).then(w => w.flat());

        const [filter_accts, filter_hosts] = await Promise.all([
            Promise.all(webhooks.map(w => this.db.all<{acct: string}>(
                sql`SELECT acct FROM webhook_filter_acct WHERE webhook_id = ${w.id} GROUP BY acct`
            ))).then(f => f.flat()),
            Promise.all(webhooks.map(w => this.db.all<{host: string}>(
                sql`SELECT host FROM webhook_filter_host WHERE webhook_id = ${w.id} GROUP BY host`
            ))).then(f => f.flat()),
        ]);

        debug('webhooks', webhooks);
        debug('accts', filter_accts);
        debug('hosts', filter_hosts);

        const embeds: APIEmbed[] = [];

        if (filter_accts.length) {
            embeds.push({
                title: 'Accounts',
                description: filter_accts.map(f => '- @' + f.acct).join('\n'),
            });
        }
        if (filter_hosts.length) {
            embeds.push({
                title: 'Hosts',
                description: filter_hosts.map(f => '- @\\*@' + f.host).join('\n'),
            });
        }

        if (filter_accts.length) {
            await interaction.reply({
                content: 'Following ' + filter_accts.length + ' ActivityPub actor' +
                    (filter_accts.length === 1 ? '' : 's') + ' in this channel',
                embeds,
            });
        } else await interaction.reply({content: 'Not following any ActivityPub actors in this channel', embeds});
    }

    async handleFollowCommand(interaction: ChatInputCommandInteraction, id: string) {
        if (!interaction.guild || !interaction.channel) {
            await interaction.reply('This action can only be performed in text channels in servers.');
            return;
        }

        await interaction.deferReply();

        const accounts = await this.findAccounts(id);

        if (accounts.length > 1) {
            await interaction.editReply('Multiple results found. Look up a user with the `/lookup` command and try again using a URL.');
            return;
        }
        if (!accounts.length) {
            await interaction.editReply('No results found.');
            return;
        }

        const account = accounts[0];

        const acct = account.acct.includes('@') ?
            account.acct : account.acct + '@' + this.mastodon.account_host;

        if (account.id !== id &&
            acct !== id &&
            '@' + acct !== id &&
            account.url !== id
        ) {
            // Ask for confirmation
            const row = new ActionRowBuilder()
                .addComponents(new ButtonBuilder()
                    .setCustomId('follow:' + account.id)
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Primary));

            const embed = this.createAccountEmbed(account);

            await interaction.editReply({
                content: 'Follow this user?\n\n' + account.url,
                embeds: [embed],
                components: [row as any],
            });
            return;
        }

        // Select this user
        await this.follow(interaction, interaction.guild, interaction.channel, account);
    }

    async handleConfirmFollowButton(interaction: ButtonInteraction, id: string) {
        if (!interaction.guild || !interaction.channel) {
            await interaction.reply('This action can only be performed in text channels in servers.');
            return;
        }

        await interaction.deferReply();

        const account: Account = await this.mastodon.fetch('/api/v1/accounts/' + id);

        await this.follow(interaction, interaction.guild, interaction.channel, account);
    }

    async follow(
        interaction: ChatInputCommandInteraction | ButtonInteraction,
        guild: Guild, channel: TextBasedChannel,
        account: Account
    ) {
        const acct = account.acct.includes('@') ?
            account.acct : account.acct + '@' + this.mastodon.account_host;

        // Check if a webhook already exists
        // Follow + create webhook

        const embed = this.createAccountEmbed(account);

        const message = {
            content: 'Following ' + account.url,
            embeds: [embed],
        };

        await interaction.editReply(message);
    }

    async findAccounts(q: string) {
        if (/^\d+$/.test(q)) {
            try {
                const account: Account = await this.mastodon.fetch('/api/v1/accounts/' + q);

                return [account];
            } catch (err) {
                debug('Error looking up user by local ID', err);
                return [];
            }
        }

        const result: SearchResults = await this.mastodon.fetch('/api/v2/search?' + new URLSearchParams({
            q,
            type: 'accounts',
            resolve: 'true',
            limit: '2',
        }).toString());

        return result.accounts;
    }

    async getWebhookForChannel(guild: Guild, channel: TextBasedChannel) {
        const webhooks = await this.getWebhooksForChannel(guild, channel);

        for (const [id, webhook] of webhooks) {
            debug('webhook', id, webhook, webhook.token, webhook.url);

            return webhook;
        }

        const webhook = await guild.channels.createWebhook({
            channel: channel.id,
            name: 'mastodon-webhooks',
        });

        debug('Created webhook', webhook.id, webhook, webhook.token);

        return webhook;
    }

    async getWebhooksForChannel(guild: Guild, channel: TextBasedChannel) {
        const webhooks = await guild.channels.fetchWebhooks(channel.id);

        return webhooks.filter(w => w.token);
    }

    createAccountEmbed(account: Account, include_fields = false) {
        const acct = account.acct.includes('@') ?
            account.acct : account.acct + '@' + this.mastodon.account_host;

        const embed: APIEmbed = {
            title: account.display_name,
            description: turndown.turndown(account.note),
            thumbnail: {
                url: account.avatar,
            },
            fields: [
                { name: 'Posts', value: '' + account.statuses_count, inline: true },
                { name: 'Following', value: '' + account.following_count, inline: true },
                { name: 'Followers', value: '' + account.followers_count, inline: true },

                ...include_fields ? account.fields.map(field => ({
                    name: field.name,
                    value: turndown.turndown(field.value),
                })) : [],
            ],
            timestamp: account.created_at,
            footer: {
                text:
                    account.id + ' • ' +
                    '@' + acct + (account.bot ? ' (bot)' : ''),
            },
        };

        return embed;
    }
}
