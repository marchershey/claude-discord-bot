# Claude Discord Bot

## Automated Setup

When the user asks you to set up, install, or configure this bot, follow these steps in order. Ask grouped questions up front rather than one at a time.

### Step 1: Check prerequisites

```bash
node --version     # must be 18+
which claude       # must exist (this is the claudePath value)
pm2 --version      # optional but recommended
```

If `which claude` fails, tell the user to install Claude Code from https://claude.ai/code and authenticate with `claude login`, then stop.

### Step 2: Install dependencies

```bash
npm install
```

### Step 3: Gather config values

Ask the user for all of these at once (don't ask one by one):

1. **Discord bot token** (required). If they don't have one, point them to the README's "Discord Bot Setup" section.
2. **Wiki/notes path** (optional). A directory of markdown files to inject as context. Ask for the full path or `none`.
3. **Your name** (optional). Used so Claude addresses them by name. Can be skipped.
4. **Alert channel ID** (optional). A Discord channel ID for monitoring alert enrichment. Can be skipped.

### Step 4: Write config.js

Create `config.js` using the values collected. Use `which claude` output for `claudePath`. For any optional values the user skipped, use `null`.

```js
module.exports = {
  claudePath: '<output of which claude>',
  wikiPath: '<wiki path or null>',
  vaultPath: '<parent dir of wiki path, or null>',
  userMdPath: null,
  userName: '<name or null>',
  alertChannelId: '<channel id or null>',
  statusServices: [],
  topicMappings: [],
};
```

### Step 5: Write ecosystem.config.js

```js
module.exports = {
  apps: [{
    name: 'discord-bot',
    script: 'bot.js',
    env: {
      DISCORD_TOKEN: '<token from step 3>'
    },
    restart_delay: 5000,
    max_restarts: 10,
  }]
};
```

### Step 6: Start the bot

If PM2 is available:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 logs discord-bot
```

Otherwise:
```bash
DISCORD_TOKEN=<token> node bot.js
```

Wait a few seconds and check the logs confirm `Online as <BotName>` and `Registered N slash commands`. If it crashes, show the error and diagnose from there.

### Step 7: Confirm it's working

Tell the user to send the bot a DM or @mention it in their server. If they see a response, setup is complete.

---

## Project Layout

| File | Purpose |
|------|---------|
| `bot.js` | Main bot, handles Discord events, Claude CLI spawning, and message routing |
| `session-registry.js` | Per-channel session state tracking |
| `config.js` | Personal settings (gitignored) |
| `config.example.js` | Config template |
| `ecosystem.config.js` | PM2 config with Discord token (gitignored) |

## Runtime Files (auto-created, gitignored)

- `sessions.json`: session UUID registry per channel
- `chat-log.jsonl`: audit log of all messages
- `reminders.json`: persistent reminder storage

## Key Design Decisions

- Sessions are **never deleted**. `/clear` archives them so they can be resumed later via `/resume <N>`.
- The Claude CLI session JSONL files in `~/.claude/projects/` are the source of truth for cross-turn memory.
- `config.js` and `ecosystem.config.js` are always gitignored since they hold personal paths and the Discord token.
- The `CLAUDE_PROJECT_DIR` in `session-registry.js` is derived from `config.wikiPath` at runtime, encoding the path the same way the Claude CLI does (replacing `/` with `-`).
