# Claude Discord Bot

A self-hosted Discord bot that gives you a persistent Claude AI assistant right inside Discord. Talk to it in DMs, @mention it in any channel, or hook it into a server channel for ongoing conversations. Each channel keeps its own memory across sessions.

Built on top of the [Claude Code CLI](https://claude.ai/code), so it supports tool use, can read and write files, run shell commands, search the web, and work with a local Obsidian wiki or any markdown notes directory.

---

## Features

- **Persistent sessions**: each Discord channel remembers your conversation across bot restarts
- **Tool use**: Claude can run Bash commands, read/write files, search the web, and read images
- **Wiki/notes integration**: optionally connect a local markdown notes directory for context injection
- **Alert enrichment**: point it at a monitoring channel and it auto-analyzes incoming alerts in threads
- **Reminders**: set one with `/remind 2h take out the trash` and it DMs you when the time is up
- **Session management**: archive, resume, and browse past conversations with slash commands

---

## Discord Bot Setup

Before you can run anything, you need a Discord bot account. This takes about 5 minutes.

### 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** in the top right
3. Give it a name (this is the app name, not the bot username; you can change the bot username separately)
4. Click **Create**

### 2. Create a Bot User

1. In the left sidebar, click **Bot**
2. Click **Reset Token**, confirm, then copy the token and save it somewhere safe (**you won't see it again**)
3. Under **Privileged Gateway Intents**, enable all three:
   - ✅ Presence Intent
   - ✅ Server Members Intent
   - ✅ **Message Content Intent** (required, without this the bot can't read messages)
4. Click **Save Changes**

### 3. Invite the Bot to Your Server

1. In the left sidebar, click **OAuth2** then **URL Generator**
2. Under **Scopes**, check:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Under **Bot Permissions**, check:
   - ✅ Read Messages / View Channels
   - ✅ Send Messages
   - ✅ Read Message History
   - ✅ Use Slash Commands
   - ✅ Create Public Threads
   - ✅ Send Messages in Threads
   - ✅ Manage Threads
4. Copy the generated URL at the bottom, open it in a browser, and invite the bot to your server

---

## Installation

> **Want Claude to set this up for you?** See [Automated Setup](#automated-setup-with-claude) below.

### Prerequisites

- **Node.js 18+**: run `node --version` to check
- **Claude Code CLI**: install at [claude.ai/code](https://claude.ai/code), then authenticate with `claude login`
- **PM2** (optional, recommended for keeping the bot running): `npm install -g pm2`

### Steps

```bash
git clone https://github.com/marchershey/claude-discord-bot.git
cd claude-discord-bot
npm install
```

### Configure

Copy the example config files and fill them in:

```bash
cp config.example.js config.js
cp ecosystem.config.example.js ecosystem.config.js
```

Open `config.js`. Every option is documented with comments. The only required fields are `claudePath` and the Discord token in `ecosystem.config.js`. Everything else is optional.

**Find your Claude binary path:**
```bash
which claude
```

**Minimum `config.js`:**
```js
module.exports = {
  claudePath: '/home/you/.local/bin/claude',  // output of: which claude
  wikiPath: null,
  vaultPath: null,
  userMdPath: null,
  userName: null,
  alertChannelId: null,
  statusServices: [],
  topicMappings: [],
};
```

**Minimum `ecosystem.config.js`:**
```js
module.exports = {
  apps: [{
    name: 'discord-bot',
    script: 'bot.js',
    env: { DISCORD_TOKEN: 'your-token-here' },
    restart_delay: 5000,
    max_restarts: 10,
  }]
};
```

### Run

```bash
# One-off / development
DISCORD_TOKEN=your-token-here node bot.js

# Background service with PM2 (recommended)
pm2 start ecosystem.config.js
pm2 save
pm2 logs discord-bot
```

---

## Automated Setup with Claude

If you have Claude Code installed, you can have it walk you through the whole setup:

```bash
git clone https://github.com/marchershey/claude-discord-bot.git
cd claude-discord-bot
claude
```

Once Claude Code opens, just say:

> **"Set this up for me"**

Claude will read the `CLAUDE.md` instructions in this repo, detect your environment, ask for your Discord token and any optional settings, and write your `config.js` and `ecosystem.config.js` automatically.

---

## Day-to-Day Usage

### Talking to the Bot

The bot responds in three contexts (no extra setup needed for any of them):

**Direct Messages**
Open a DM with the bot and send any message. Works exactly like chatting with Claude directly.

**Server Channels (via @mention)**
In any channel the bot has access to, @mention it:
> `@ClaudeAI what's the weather in Austin?`

The bot replies in that channel and keeps a persistent session per channel, so follow-up messages continue the conversation without needing to @mention again.

**Hooking Into a Dedicated Channel**
If you want a channel that's exclusively for bot conversations (no @mention required):
1. Create a channel (e.g. `#claude`)
2. Restrict it so only you and the bot can see it
3. You'll still need to @mention for the first message, or just use DMs instead

> **Tip:** Each Discord channel gets its own separate memory. Use different channels for different topics if you want to keep conversations isolated.

### Images

Attach an image to any message and the bot will read it using Claude's vision. Works in DMs and @mentions.

### Slash Commands

| Command | What it does |
|---------|-------------|
| `/help` | Show all available commands |
| `/clear` or `/new` | Archive the current conversation and start fresh |
| `/sessions` | List this channel's past conversations (local numbers, use with `/resume`) |
| `/sessions all:True` | List every session across all channels with global numbers (use with `/delete`) |
| `/resume <number>` | Jump back into a previous conversation in this channel |
| `/delete <number>` | Delete a specific session by its global number from `/sessions all:True` |
| `/delete all` | Delete all sessions in the current channel |
| `/purge confirm:True` | Delete every session across every channel (cannot be undone) |
| `/status` | Check the status of configured services (requires `statusServices` in config) |
| `/wiki <page>` | Read a page from your connected notes directory |
| `/remind <time> <message>` | Set a reminder (e.g. `/remind 2h call the shop`) |
| `/reminders` | List your active reminders |
| `/simulate-alert` | Test alert enrichment (requires `alertChannelId` in config) |

### Reminders

Reminders fire as a DM regardless of which channel you set them from:
```
/remind 30m check the oven
/remind 2h30m meeting prep
/remind 1h check build status
```

### Session Management

The bot never deletes conversation history by default. `/clear` just archives it so you can always come back. Sessions are numbered two ways depending on the command:

**Local numbers** (from `/sessions`) are used with `/resume`. They only refer to sessions in the current channel.

**Global numbers** (from `/sessions all:True`) are used with `/delete`. They are unique across every channel, so you can delete any session from anywhere without switching channels.

```
/sessions                 (lists this channel's sessions, numbered locally)
/resume 3                 (resumes local session #3 in this channel)

/sessions all:True        (lists all sessions everywhere, numbered globally)
/delete 7                 (deletes global session #7, no matter which channel it's in)
/delete all               (deletes all sessions in the current channel)
/purge confirm:True       (wipes everything across all channels)
```

---

## Optional Features

### Wiki / Notes Integration

Point the bot at a local directory of markdown files and it will automatically inject relevant pages into Claude's context based on keywords in your messages.

In `config.js`:
```js
wikiPath: '/home/you/notes/wiki',
vaultPath: '/home/you/notes',
userMdPath: '/home/you/notes/wiki/about-me.md',  // optional personal profile
topicMappings: [
  { pattern: /docker|container/, file: 'homelab/docker.md' },
  { pattern: /proxmox|vm/,       file: 'homelab/proxmox.md' },
],
```

### Alert Enrichment

If you use a monitoring tool (n8n, Uptime Kuma, etc.) that can post embeds to a Discord channel, the bot will automatically analyze each alert in a thread.

1. Get the Discord channel ID of your monitoring channel (right-click the channel and click "Copy Channel ID"; you'll need Developer Mode enabled in Discord settings under Advanced)
2. Set it in `config.js`:
   ```js
   alertChannelId: '1234567890123456789',
   ```
3. Configure your monitoring tool to post embeds with a title starting with 🚨, ✅, or ⚠️
4. Use `/simulate-alert` to test it

### Service Status Checks

The `/status` command curls a list of services and returns an up/down table:

```js
statusServices: [
  { name: 'My App',  url: 'https://myapp.com' },
  { name: 'Grafana', url: 'http://10.0.0.1:3000' },
  { name: 'Proxmox', url: 'https://10.0.0.1:8006', curlFlags: '-k -s -o /dev/null -w "%{http_code}"' },
],
```

---

## Architecture

| File | Purpose |
|------|---------|
| `bot.js` | Main entry point, handles Discord events, Claude CLI spawning, and message routing |
| `session-registry.js` | Per-channel session state (active, archived, lost), never deletes history |
| `config.js` | Your personal settings (gitignored, never committed) |
| `config.example.js` | Config template with documentation |
| `ecosystem.config.js` | PM2 process config with your Discord token (gitignored) |

**Runtime files** (auto-created, gitignored):
- `sessions.json`: session UUID registry
- `chat-log.jsonl`: append-only audit log
- `reminders.json`: active reminder storage
- `sessions-view.md`: human-readable session snapshot

---

## Troubleshooting

**Bot is online but not responding**
- Check that Message Content Intent is enabled in the Developer Portal
- Make sure the bot has Send Messages permission in the channel
- Check logs: `pm2 logs discord-bot`

**`spawn ... ENOENT` error**
- `claudePath` in `config.js` is wrong. Run `which claude` and update it.

**`Cannot find module './config'`**
- You haven't created `config.js` yet. Copy it from `config.example.js` and fill it in.

**Sessions not resuming after restart**
- The Claude CLI session files live in `~/.claude/projects/`. If they've been deleted or the `wikiPath` changed, old sessions will be marked as lost automatically.
