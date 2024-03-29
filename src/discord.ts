import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import createDebug from 'debug';
import { APIEmbed } from 'discord-api-types/v9';
import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction, Client, Events, ForumChannel, GatewayIntentBits, Guild, Interaction, PermissionFlagsBits, PrivateThreadChannel, PublicThreadChannel, REST, Routes, SlashCommandBuilder, TextBasedChannel } from 'discord.js';
import sql from 'sql-template-strings';
import { Database } from 'sqlite';
import Turndown from 'turndown';
import getImageColours from 'get-image-colors';
import MastodonApi from './mastodon.js';
import { Account, FollowResult, SearchResults } from './mastodon-types.js';
import { Webhook } from './webhook.js';
import { data_path, git, http_user_agent } from './util.js';

const debug = createDebug('discord');
const debugAvatarColours = createDebug('discord:colours');

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
    new SlashCommandBuilder()
        .setName('unfollow')
        .setDescription('Unfollow an ActivityPub actor and stop sending their statuses in this channel')
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

        this.client.on(Events.Error, err => {
            debug('client error', err);
        });
        this.client.on(Events.Debug, message => {
            debug('client debug', message);
        });

        this.client.on(Events.ClientReady, client => this.handleClientReady(client));
        this.client.on(Events.InteractionCreate, interaction => this.handleInteraction(interaction));

        this.client.on(Events.GuildCreate, guild => {
            debug('Joined guild %d %s', guild.id, guild.name);
        });
        this.client.on(Events.GuildDelete, guild => {
            debug('Left guild %d %s', guild.id, guild.name);
        });
        this.client.on(Events.WebhooksUpdate, channel => {
            debug('Received webhooks updated for channel %d %s in guild %d %s',
                channel.id, channel.name, channel.guild.id, channel.guild.name);
        });
    }

    async handleClientReady(client: Client<true>) {
        debug('Logged in as %s', client.user.tag);

        for (const [id, guild] of client.guilds.cache) {
            debug('Connected to guild %d %s', guild.id, guild.name);
        }

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

                if (interaction.customId.startsWith('unfollow:')) {
                    const id = interaction.customId.substr(9);
                    await this.handleConfirmUnfollowButton(interaction, id);
                }
            }
        } catch (err) {
            debug('Error handling interaction', interaction, err);

            this.handleErrorInInteraction(interaction, err).catch(err2 => {
                debug('Error handling error handling interaction', err2);
            });
        }
    }

    async handleErrorInInteraction(interaction: Interaction, error: unknown) {
        if (interaction.isRepliable()) {
            const embed: APIEmbed = {
                description: error instanceof Error ? error.name + ': ' + error.message : 'Unknown error',
                color: 0xff0000,
                footer: {
                    text: git?.revision.substr(0, 8) ?? 'unknown revision',
                },
            };

            interaction.replied || interaction.deferred ?
                await interaction.editReply({embeds: [embed]}) :
                await interaction.reply({embeds: [embed]});
        }
    }

    async handleLookupCommand(interaction: ChatInputCommandInteraction, id: string) {
        await interaction.deferReply();

        if (id === 'error') {
            throw new Error('oh no    :(');
        }

        const accounts = await this.findAccounts(id);

        if (!accounts.length) {
            await interaction.editReply('No results found.');
            return;
        }

        const embeds = await Promise.all(accounts
            .slice(0, 1)
            .map(a => this.createAccountEmbed(a, true)));

        await interaction.editReply({
            content: accounts.length === 1 ? accounts[0].url : 'Multiple results found.',
            embeds,
        });
    }

    async handleFollowingCommand(interaction: ChatInputCommandInteraction) {
        const channel = interaction.channel?.isThread() ? interaction.channel.parent : interaction.channel;
        const thread = interaction.channel?.isThread() ? interaction.channel : undefined;

        if (!interaction.guild || !channel) {
            await interaction.reply('This action can only be performed in text channels in servers.');
            return;
        }

        await interaction.deferReply();

        const discord_webhooks = await this.getWebhooksForChannel(interaction.guild, channel, thread);

        const webhooks = await Promise.all(discord_webhooks.map(([w, url]) => this.db.all<Webhook[]>(
            sql`SELECT * FROM webhooks WHERE type = 'discord' AND url = ${url}`))).then(w => w.flat());

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
            await interaction.editReply({
                content: 'Following ' + filter_accts.length + ' ActivityPub actor' +
                    (filter_accts.length === 1 ? '' : 's') + ' in this ' + (thread ? 'thread' : 'channel') + '.',
                embeds,
            });
        } else {
            await interaction.editReply({
                content: 'Not following any ActivityPub actors in this ' + (thread ? 'thread' : 'channel') + '.',
                embeds,
            });
        }
    }

    async handleFollowCommand(interaction: ChatInputCommandInteraction, id: string) {
        const channel = interaction.channel?.isThread() ? interaction.channel.parent : interaction.channel;
        const thread = interaction.channel?.isThread() ? interaction.channel : undefined;

        if (!interaction.guild || !channel) {
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
            const embed = await this.createAccountEmbed(account);

            // Check if a webhook already exists
            const {filter_accts} = await this.getWebhooksForChannelActor(interaction.guild, channel, thread, acct);

            if (filter_accts.length) {
                await interaction.editReply({
                    content: 'This actor is already being following in this channel.\n\n' + account.url,
                    embeds: [embed],
                });
                return;
            }

            // Ask for confirmation
            const row = new ActionRowBuilder()
                .addComponents(new ButtonBuilder()
                    .setCustomId('follow:' + account.id)
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Primary));

            await interaction.editReply({
                content: 'Follow this user?\n\n' + account.url,
                embeds: [embed],
                components: [row as any],
            });
            return;
        }

        // Select this user
        await this.follow(interaction, interaction.guild, channel, thread, account);
    }

    async handleConfirmFollowButton(interaction: ButtonInteraction, id: string) {
        const channel = interaction.channel?.isThread() ? interaction.channel.parent : interaction.channel;
        const thread = interaction.channel?.isThread() ? interaction.channel : undefined;

        if (!interaction.guild || !channel) {
            await interaction.reply('This action can only be performed in text channels in servers.');
            return;
        }

        await interaction.deferReply();

        const account: Account = await this.mastodon.fetch('/api/v1/accounts/' + id);

        await this.follow(interaction, interaction.guild, channel, thread, account);
    }

    async follow(
        interaction: ChatInputCommandInteraction | ButtonInteraction,
        guild: Guild, channel: TextBasedChannel | ForumChannel,
        thread: PrivateThreadChannel | PublicThreadChannel | undefined,
        account: Account
    ) {
        const acct = account.acct.includes('@') ?
            account.acct : account.acct + '@' + this.mastodon.account_host;

        // Check if a webhook already exists
        const {filter_accts} = await this.getWebhooksForChannelActor(guild, channel, thread, acct);

        if (filter_accts.length) {
            await interaction.editReply('This actor is already being following in this channel.');
            return;
        }

        // Create webhook
        const webhook_id = await this.getWebhookIdForChannel(guild, channel, thread);

        const result = await this.db.run(
            sql`INSERT INTO webhook_filter_acct (webhook_id, acct) VALUES (${webhook_id}, ${acct})`
        );

        debug('Create webhook result', result);

        // Follow
        let follow_result;
        try {
            if (this.mastodon.authenticated) {
                const result: FollowResult =
                    await this.mastodon.fetch('/api/v1/accounts/' + account.id + '/follow', 'POST');
                follow_result = {result};
            }
        } catch (error) {
            follow_result = {error};
        }

        debug('Follow result', follow_result);

        const content =
            // Not authenticated, will use public timeline
            !follow_result ? 'Following ' + account.url :
            // Actor requires follower approval, sent request
            'result' in follow_result && follow_result.result.requested ? 'A follow request has been sent to ' + account.url + '. Statuses may not be delivered until the request is accepted.' :
            // Error sending follow reqeust
            'error' in follow_result ? 'The Mastodon bot was unable to send a follow request to ' + account.url + '. The webhook has been created, but statuses may not be delivered.' :
            // Following
            'Following ' + account.url;

        const embed = await this.createAccountEmbed(account);

        await interaction.editReply({
            content,
            embeds: [embed],
        });
    }

    async getWebhooksForChannelActor(
        guild: Guild, channel: TextBasedChannel | ForumChannel,
        thread: PrivateThreadChannel | PublicThreadChannel | undefined,
        acct: string
    ) {
        const discord_webhooks = await this.getWebhooksForChannel(guild, channel, thread);

        const webhooks = await Promise.all(discord_webhooks.map(([w, url]) => this.db.all<Webhook[]>(
            sql`SELECT * FROM webhooks WHERE type = 'discord' AND url = ${url}`))).then(w => w.flat());

        const filter_accts = await Promise.all(webhooks.map(w => this.db.all<{
            id: number;
            webhook_id: number;
            acct: string;
        }>(
            sql`SELECT id,webhook_id,acct FROM webhook_filter_acct WHERE webhook_id = ${w.id} AND acct = ${acct}`
        ))).then(f => f.flat());

        return {
            webhooks: webhooks.filter(w => filter_accts.find(f => f.webhook_id === w.id)),
            filter_accts,
        };
    }

    async handleUnfollowCommand(interaction: ChatInputCommandInteraction, id: string) {
        const channel = interaction.channel?.isThread() ? interaction.channel.parent : interaction.channel;
        const thread = interaction.channel?.isThread() ? interaction.channel : undefined;

        if (!interaction.guild || !channel) {
            await interaction.reply('This action can only be performed in text channels in servers.');
            return;
        }

        await interaction.deferReply();

        const accounts = await this.findAccounts(id);

        if (accounts.length > 1) {
            await interaction.editReply('Multiple results found. Look up a user with the `/lookup` command and try again using a URL, or use the `/following` command to check which users are followed in this channel.');
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
            const embed = await this.createAccountEmbed(account);

            // Check if a webhook exists
            const {filter_accts} = await this.getWebhooksForChannelActor(interaction.guild, channel, thread, acct);

            if (!filter_accts.length) {
                await interaction.editReply({
                    content: 'This actor is not being following in this channel.\n\n' + account.url,
                    embeds: [embed],
                });
                return;
            }

            // Ask for confirmation
            const row = new ActionRowBuilder()
                .addComponents(new ButtonBuilder()
                    .setCustomId('unfollow:' + account.id)
                    .setLabel('Confirm')
                    .setStyle(ButtonStyle.Primary));

            await interaction.editReply({
                content: 'Unfollow this user?\n\n' + account.url,
                embeds: [embed],
                components: [row as any],
            });
            return;
        }

        // Select this user
        await this.unfollow(interaction, interaction.guild, channel, thread, account);
    }

    async handleConfirmUnfollowButton(interaction: ButtonInteraction, id: string) {
        const channel = interaction.channel?.isThread() ? interaction.channel.parent : interaction.channel;
        const thread = interaction.channel?.isThread() ? interaction.channel : undefined;

        if (!interaction.guild || !channel) {
            await interaction.reply('This action can only be performed in text channels in servers.');
            return;
        }

        await interaction.deferReply();

        const account: Account = await this.mastodon.fetch('/api/v1/accounts/' + id);

        await this.unfollow(interaction, interaction.guild, channel, thread, account);
    }

    async unfollow(
        interaction: ChatInputCommandInteraction | ButtonInteraction,
        guild: Guild, channel: TextBasedChannel | ForumChannel,
        thread: PrivateThreadChannel | PublicThreadChannel | undefined,
        account: Account
    ) {
        const acct = account.acct.includes('@') ?
            account.acct : account.acct + '@' + this.mastodon.account_host;

        // Check if a webhook already exists
        const {webhooks, filter_accts} = await this.getWebhooksForChannelActor(guild, channel, thread, acct);

        if (!filter_accts.length) {
            await interaction.editReply('This actor is not being following in this channel.');
            return;
        }

        for (const filter_acct of filter_accts) {
            const result = await this.db.run(sql`DELETE FROM webhook_filter_acct WHERE id = ${filter_acct.id}`);

            debug('Deleted webhook account filter', filter_acct, result);
        }

        for (const webhook of webhooks) {
            const filter_accts = await this.db.get<{count: number}>(
                sql`SELECT COUNT(*) as count FROM webhook_filter_acct WHERE webhook_id = ${webhook.id}`);
            if (filter_accts?.count) continue;

            const filter_hosts = await this.db.get<{count: number}>(
                sql`SELECT COUNT(*) as count FROM webhook_filter_host WHERE webhook_id = ${webhook.id}`);
            if (filter_hosts?.count) continue;

            const result = await this.db.run(sql`DELETE FROM webhooks WHERE id = ${webhook.id}`);

            debug('Deleted webhook', webhook, result);
        }

        const embed = await this.createAccountEmbed(account);

        const message = {
            content: 'Unfollowed ' + account.url,
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

    async getWebhookForChannel(
        guild: Guild, channel: TextBasedChannel | ForumChannel, thread?: PrivateThreadChannel | PublicThreadChannel
    ) {
        const webhooks = await this.getWebhooksForChannel(guild, channel, thread);

        for (const [webhook, url] of webhooks) {
            if (!webhook.token || webhook.applicationId !== this.client.application!.id) continue;

            debug('webhook', webhook, webhook.token, url);

            return [webhook, url] as const;
        }

        const webhook = await guild.channels.createWebhook({
            channel: channel.id,
            name: 'mastodon-webhooks',
        });

        debug('Created webhook', webhook.id, webhook, webhook.token);

        return [webhook, thread ? webhook.url + '?thread_id=' + thread.id : webhook.url] as const;
    }

    async getWebhooksForChannel(
        guild: Guild, channel: TextBasedChannel | ForumChannel, thread?: PrivateThreadChannel | PublicThreadChannel
    ) {
        const webhooks = await guild.channels.fetchWebhooks(channel.id);

        return webhooks
            .filter(w => w.url)
            .map(w => [w, thread ? w.url + '?thread_id=' + thread.id : w.url] as const);
    }

    async getWebhookIdForChannel(
        guild: Guild, channel: TextBasedChannel | ForumChannel, thread?: PrivateThreadChannel | PublicThreadChannel
    ) {
        const [discord_webhook, webhook_url] = await this.getWebhookForChannel(guild, channel, thread);

        const webhook = await this.db.get<Webhook>(
            sql`SELECT * FROM webhooks WHERE type = 'discord' AND url = ${webhook_url}`);
        if (webhook) return webhook.id;

        const result = await this.db.run(
            sql`INSERT INTO webhooks (type, url) VALUES ('discord', ${webhook_url})`);

        debug('Created webhook entry', result);

        return result.lastID;
    }

    async createAccountEmbed(account: Account, include_fields = false) {
        const acct = account.acct.includes('@') ?
            account.acct : account.acct + '@' + this.mastodon.account_host;

        const embed: APIEmbed = {
            title: account.display_name,
            description: turndown.turndown(account.note),
            url: account.url + '#' + new URLSearchParams({
                source: 'https://gitlab.fancy.org.uk/samuel/mastodon-webhooks discord bot',
                revision: git?.revision ?? 'unknown',
                server_url: this.mastodon.server_url,
                account_id: account.id,
            }).toString(),
            color: await getAccountColour(account, this.mastodon.server_url) ?? undefined,
            thumbnail: {
                url: account.avatar,
            },
            fields: [
                { name: 'Posts', value: '' + account.statuses_count, inline: true },
                { name: 'Following', value: '' + account.following_count, inline: true },
                { name: 'Followers', value: '' + account.followers_count, inline: true },

                ...include_fields ? account.fields.map(field => ({
                    name: field.name,
                    value: turndown.turndown(field.value).trim() || '-',
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

const account_colour_promise = new Map</** server URL/account ID/avatar URL */ string, Promise<number | null>>();

export function getAccountColour(account: Account, server_url: string) {
    const key = server_url + ':' + account.id + ':' + account.avatar;

    if (account_colour_promise.has(key)) return account_colour_promise.get(key)!;

    const promise = getAccountColours(account, server_url)
        .then(data => data?.colours[0] ?? null)
        .catch(err => (debugAvatarColours('Error getting account colours', account.id, account.display_name, err), null))
        .finally(() => account_colour_promise.delete(key));

    account_colour_promise.set(key, promise);

    return promise;
}

interface AccountColoursCache {
    server_url: string;
    id: string;
    url: string;
    key: string;
    colours: number[];
    created_at: string;
}

async function getAccountColours(account: Account, server_url: string) {
    const server_key = createHash('sha1').update(server_url).digest('hex');
    const key = createHash('sha1').update(account.avatar).digest('hex');

    try {
        const cache: AccountColoursCache = JSON.parse(await fs.readFile(
            path.join(data_path, 'avatar-colours-cache', server_key, account.id, key + '.json'), 'utf-8'));

        return cache;
    } catch (err) {
        if (!err || typeof err !== 'object' || !('code' in err) || err.code !== 'ENOENT') throw err;
    }

    const response = await fetch(account.avatar, {
        headers: {
            'User-Agent': http_user_agent,
        },
    });

    if (response.status === 404) return null;

    if (!response.ok) {
        debugAvatarColours('Server returned status %d %s when fetching avatar', response.status, response.statusText);
        return null;
    }

    const type = response.headers.get('Content-Type') ?? 'image/png';
    const data = await response.arrayBuffer();
    const buffer = Buffer.from(new Uint8Array(data));

    const colours = await getImageColours(buffer, {type});

    debugAvatarColours('account colours', colours);

    const cache: AccountColoursCache = {
        server_url,
        id: account.id,
        url: account.avatar,
        key,
        colours: colours.map(c => c.num()),
        created_at: new Date().toISOString(),
    };

    await fs.mkdir(path.join(data_path, 'avatar-colours-cache', server_key, account.id), {recursive: true});
    await fs.writeFile(
        path.join(data_path, 'avatar-colours-cache', server_key, account.id, key + '.json'),
        JSON.stringify(cache), 'utf-8');

    return cache;
}
