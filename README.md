Mastodon webhooks
---

Sends webhooks for ActivityPub statuses using Mastodon's streaming API.

### Discord bot

The Discord bot can be used to follow users to receive their statuses in Discord.

The bot is available in the [#fediverse](https://discord.com/channels/998657768594608138/1043231715142942740) channel in the [Nintendo APIs and nxapi Discord server](https://discord.com/invite/4D82rFkXRv).

Authorise: https://discord.com/api/oauth2/authorize?client_id=1043278411449237584&permissions=536870912&scope=bot

#### Commands and permissions

Command         | Description                                       | Default permissions
----------------|---------------------------------------------------|-----------------------
`/lookup`       | Searches for a user.                              | All users
`/follow`       | Follows a user in the current channel.            | Users with Manage webhooks
`/unfollow`     | Unfollows a user in the current channel.          | Users with Manage webhooks
`/following`    | Lists all users followed in the current channel.  | Users with Manage webhooks
