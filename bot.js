const {
  Client, GatewayIntentBits, Events, Partials,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const sessionReg = require('./session-registry');
const config = require('./config');

const WIKI              = config.wikiPath || null;
const VAULT             = config.vaultPath || null;
const MEMORY_PATH       = config.memoryPath || null;
const CLAUDE            = config.claudePath || 'claude';
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const REMINDERS_FILE    = path.join(__dirname, 'reminders.json');

// Proactive alert enrichment. A monitoring bot (e.g. n8n) posts alerts to a
// designated channel using the SAME bot token, so alert messages show
// message.author = this bot. We distinguish them by: top-level channel (not
// thread) + embed title matching the emoji prefix (🚨/✅/⚠️). User replies
// in the auto-created thread are treated as conversation without @mention.
const ALERT_CHANNEL_ID = config.alertChannelId || null;

// Captured at module load. Used to ignore historical alerts on restart so we
// don't fire a flood of enrichments for things that already happened.
const startupTime = Date.now();

// ── Error tracking ─────────────────────────────────────────────────────────────

function fatal(label, err) {
  const ts = new Date().toISOString();
  console.error(`\n[${ts}] FATAL: ${label}`);
  console.error(err?.stack || err);
  process.exit(1);
}

function logError(label, err) {
  const ts = new Date().toISOString();
  console.error(`\n[${ts}] ERROR: ${label}`);
  console.error(err?.stack || err);
}

process.on('uncaughtException', err => fatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));

// ── Reminder persistence ───────────────────────────────────────────────────────

function saveReminders() {
  const flat = Object.entries(reminders).flatMap(([userId, list]) =>
    list.map(r => ({ userId, text: r.text, fireAt: r.fireAt }))
  );
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(flat, null, 2));
}

function loadReminders() {
  let flat;
  try { flat = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); }
  catch { return; }

  for (const { userId, text, fireAt } of flat) {
    const ms = fireAt - Date.now();
    if (ms <= 0) continue;
    if (!reminders[userId]) reminders[userId] = [];
    const tid = setTimeout(async () => {
      try {
        const user = await client.users.fetch(userId);
        const dm = await user.createDM();
        await dm.send(`⏰ **Reminder:** ${text}`);
      } catch (e) { logError('reminder DM', e); }
      reminders[userId] = reminders[userId].filter(r => r.id !== tid);
      saveReminders();
    }, ms);
    reminders[userId].push({ id: tid, text, fireAt });
  }
}

// Session persistence (per-Discord-channel claude session UUID) lives in
// ./session-registry.js. State column model (active / archived / lost) — never
// deletes a UUID so /resume <N> can re-enter prior conversations. See that
// module for schema + wiki-mirror behavior.

// ── Slash command definitions ─────────────────────────────────────────────────

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('help').setDescription('List all commands'),
  new SlashCommandBuilder()
    .setName('clear').setDescription('Archive current conversation, start fresh next message'),
  new SlashCommandBuilder()
    .setName('new').setDescription('Same as /clear — archive + start fresh next message'),
  new SlashCommandBuilder()
    .setName('sessions').setDescription('List archived conversations for this channel, or all channels')
    .addBooleanOption(o => o.setName('all').setDescription('Show sessions from every channel, not just this one').setRequired(false)),
  new SlashCommandBuilder()
    .setName('resume').setDescription('Re-activate an archived conversation by its number from /sessions')
    .addIntegerOption(o => o.setName('number').setDescription('Index shown by /sessions').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('status').setDescription('Live status check of configured services'),
  new SlashCommandBuilder()
    .setName('wiki').setDescription('Read a wiki page')
    .addStringOption(o => o.setName('page').setDescription('Page path, e.g. homelab/proxmox').setRequired(true)),
  new SlashCommandBuilder()
    .setName('remind').setDescription('Set a reminder')
    .addStringOption(o => o.setName('time').setDescription('e.g. 2h, 30m, 1h30m').setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('What to remind you about').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reminders').setDescription('List your active reminders'),
  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Delete a session from this channel')
    .addStringOption(o => o.setName('target').setDescription('Session number from /sessions, or "all" to delete every session in this channel').setRequired(true)),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete ALL sessions across every channel. Cannot be undone.')
    .addBooleanOption(o => o.setName('confirm').setDescription('Set to True to confirm').setRequired(true)),
  new SlashCommandBuilder()
    .setName('simulate-alert').setDescription('Post a fake alert to the alert channel to test enrichment')
    .addStringOption(o => o.setName('service').setDescription('Service name (default: TestService)'))
    .addStringOption(o => o.setName('kind').setDescription('down | resolved | action')
      .addChoices(
        { name: 'down', value: 'down' },
        { name: 'resolved', value: 'resolved' },
        { name: 'action', value: 'action' },
      )),
].map(c => c.toJSON());

// ── Wiki helpers ──────────────────────────────────────────────────────────────

function readWiki(...files) {
  if (!WIKI) return '';
  return files
    .map(f => {
      try { return `--- ${f} ---\n${fs.readFileSync(path.join(WIKI, f), 'utf8').slice(0, 3000)}`; }
      catch { return ''; }
    })
    .filter(Boolean).join('\n\n');
}

// Returns wiki files relevant to the message content based on config.topicMappings.
// Core context (hot.md, SOUL.md, USER.md, user profile) is NOT injected here —
// ~/.claude/CLAUDE.md loads automatically every spawn and tells Claude where to
// find everything. Claude reads on demand via the Read tool.
function getWikiFiles(content) {
  if (!WIKI || !config.topicMappings?.length) return [];
  const q = content.toLowerCase();
  const files = [];
  for (const { pattern, file } of config.topicMappings) {
    if (q.match(pattern)) files.push(file);
  }
  return [...new Set(files)];
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function parseReminderMs(text) {
  let ms = 0;
  const h = text.match(/(\d+)\s*h(?:ours?)?/i);
  const m = text.match(/(\d+)\s*m(?:in(?:utes?)?)?/i);
  const s = text.match(/(\d+)\s*s(?:ec(?:onds?)?)?/i);
  if (h) ms += parseInt(h[1]) * 3600000;
  if (m) ms += parseInt(m[1]) * 60000;
  if (s) ms += parseInt(s[1]) * 1000;
  return ms || null;
}

function msToHuman(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

const LOG_FILE = path.join(__dirname, 'chat-log.jsonl');
// Flat audit log only — NOT used for history reconstruction (the claude session
// jsonl is the source of truth for cross-turn context). Kept so you can grep
// "what did the bot say on 2026-05-17 around 9pm" without parsing per-channel
// session jsonls.
function appendLog(channelId, role, content, sessionId = null) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), channel: channelId, sessionId, role, content });
  try { fs.appendFileSync(LOG_FILE, entry + '\n'); } catch {}
}

// Per-channel promise chain. Discord can deliver two MessageCreate events back-to-back;
// without serialization they'd both spawn `claude -p --resume <same-uuid>` and race on
// the same jsonl file. Each new handler awaits the prior one before spawning.
const lockChain = {};
function enqueue(channelId, fn) {
  const prev = lockChain[channelId] || Promise.resolve();
  const next = prev.then(fn).catch(err => logError(`queued handler ch=${channelId}`, err));
  lockChain[channelId] = next.finally(() => {
    if (lockChain[channelId] === next) delete lockChain[channelId];
  });
  return next;
}

// Spawn `claude -p`. Empirically verified flag semantics:
//   - --session-id <uuid>: claims a fresh UUID; errors "already in use" on second call.
//   - --resume <uuid>: continues an existing session; prior tool_use/tool_result blocks
//     remain in the model's context.
//   - --append-system-prompt: re-passed every turn (does NOT persist across resume).
//   - --tools: re-passed every turn (does NOT persist across resume).
// Passing channelId enables session continuity; oneShot:true spawns ephemerally.
function runClaude({
  userText,
  channelId = null,
  appendSystem = '',
  tools = 'Read,Write,Edit,Bash,WebSearch,WebFetch',
  oneShot = false,
  onChunk,
  _retry = false,
}) {
  return new Promise((resolve, reject) => {
    const args = ['-p'];
    let sessionUuid = null;
    let sessionIsNew = false;

    if (oneShot) {
      // One-shot /status etc — don't pollute the channel's conversation thread.
      args.push('--no-session-persistence');
    } else if (channelId) {
      const existing = sessionReg.getActive(channelId);
      if (existing) {
        sessionUuid = existing;
        sessionIsNew = false;
        args.push('--resume', sessionUuid);
      } else {
        sessionUuid = crypto.randomUUID();
        sessionIsNew = true;
        args.push('--session-id', sessionUuid);
      }
    }

    if (appendSystem) args.push('--append-system-prompt', appendSystem);
    args.push('--tools', tools);
    args.push('--output-format', 'stream-json');
    args.push('--verbose'); // stream-json requires --verbose with --print
    args.push('--dangerously-skip-permissions');

    const cwd = WIKI || process.cwd();
    const proc = spawn(CLAUDE, args, { cwd });

    let lineBuffer = '';
    let accText = '';
    let finalResult = null;
    let stderr = '';

    proc.stdout.on('data', d => {
      lineBuffer += d;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text' && block.text) {
                accText += (accText ? '\n' : '') + block.text;
                onChunk?.(accText);
              }
            }
          } else if (ev.type === 'result') {
            finalResult = ev.result ?? null;
          }
        } catch { /* skip malformed lines */ }
      }
    });

    proc.stderr.on('data', d => { stderr += d; });
    proc.stdin.write(userText);
    proc.stdin.end();
    proc.on('close', async code => {
      if (code !== 0) {
        const errMsg = stderr.trim() || `claude exited ${code}`;
        // Soft-fail recovery: if --resume failed (session file deleted/corrupt),
        // mark the broken UUID lost, retry once with a fresh --session-id and
        // a context-lost preamble so the agent can notify the user.
        const looksLikeSessionLost = !_retry && !oneShot && channelId && !sessionIsNew && (
          /session.*not.*found/i.test(errMsg) ||
          /no such file/i.test(errMsg) ||
          /session.*invalid/i.test(errMsg) ||
          /no conversation found/i.test(errMsg)
        );
        if (looksLikeSessionLost) {
          logError(`session lost ch=${channelId}, retrying fresh`, new Error(errMsg));
          sessionReg.markLost(channelId, sessionUuid);
          try {
            const result = await runClaude({
              userText: `[prior session context lost, starting fresh]\n\n${userText}`,
              channelId, appendSystem, tools, oneShot, onChunk,
              _retry: true,
            });
            return resolve(result);
          } catch (e) { return reject(e); }
        }
        return reject(new Error(errMsg));
      }
      // Register/record session AFTER successful exit, so a crashed first turn
      // doesn't leave a phantom UUID with no jsonl behind.
      if (!oneShot && channelId && sessionUuid) {
        if (sessionIsNew) sessionReg.registerNew(channelId, sessionUuid, userText);
        else              sessionReg.recordTurn(channelId, sessionUuid);
      }
      resolve({
        display: (finalResult || accText).trim(),
        full: accText,
        sessionUuid,
        sessionIsNew,
      });
    });
    proc.on('error', reject);
  });
}

// Send chunks — works for both message replies and slash command interactions
async function sendChunks(target, text, { isDM = false, isInteraction = false } = {}) {
  const chunks = (text || '(no response)').match(/[\s\S]{1,1900}/g);
  for (let i = 0; i < chunks.length; i++) {
    if (isInteraction) {
      i === 0 ? await target.editReply(chunks[i]) : await target.followUp(chunks[i]);
    } else {
      i === 0 && !isDM ? await target.reply(chunks[i]) : await target.channel.send(chunks[i]);
    }
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

const BASE_SYSTEM = [
  `You are Claude, a personal AI assistant accessible via Discord. Keep responses concise and conversational — this is a chat interface, not a document editor.`,
  '',
  WIKI
    ? `You have READ and WRITE access to the wiki/notes at ${WIKI} via Read, Write, and Edit tools. You have Bash for running shell commands. You have WebSearch and WebFetch for looking things up online. Use these tools proactively — don't ask permission, just do it.`
    : `You have Bash for running shell commands. You have WebSearch and WebFetch for looking things up online. Use these tools proactively — don't ask permission, just do it.`,
  '',
  `Before each tool call, write one short status line so the user can see your progress live in Discord. Examples: "🔍 Searching...", "📂 Reading wiki page...", "🖥️ Running command...", "✍️ Updating wiki...". Keep it one line, no extra commentary.`,
  '',
  `Never use Obsidian wiki link syntax like [[page-name]] — the user is reading this in Discord, not Obsidian.`,
  '',
  `CONTEXT: ~/.claude/CLAUDE.md is loaded automatically every turn — treat it as standing orders. Everything else (wiki, user profile, recent context) lives on disk and is indexed. Read it on demand with the Read tool. Never claim ignorance about something that's findable. Never ask the user to repeat context you can look up yourself.`,
  '',
  `ABSOLUTE — anti-fabrication rule: NEVER report a tool result, HTTP status code, container state, API response, log output, or file content that you did not literally receive from a tool call in THIS turn. If you lack an endpoint, token, container name, file path, or credential needed for a real check — STOP and say so plainly. It is always better to say "I don't know, checking now" than to invent a result. A fabricated result is a critical trust failure. When in doubt: read the relevant page, run the actual command, or ask. Never guess and report the guess as fact.`,
  '',
  `CROSS-TURN MEMORY: this Discord channel is wrapped around a persistent claude session (\`claude -p --resume\`). Your past tool_use/tool_result blocks from earlier turns in THIS channel ARE in your context — you can rely on them the same way you would in a Claude Code CLI session. But: across-channel state is NOT shared, and process restarts can rotate the session (you'll see a "[prior session context lost, starting fresh]" preamble if so). If a tool result is missing from your visible context and you need it, re-run the tool — don't fabricate.`,
].join('\n');

// One-line hint appended to every turn so Claude knows memory files exist.
// Claude reads them on demand — they are never bulk-injected.
const MEMORY_HINT = MEMORY_PATH
  ? `\nPersistent memory (notes about this user) is at ${MEMORY_PATH}/ — read any .md file there on demand if you need personal context.`
  : '';

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const reminders = {};

client.once(Events.ClientReady, async c => {
  console.log(`Online as ${c.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(c.user.id), { body: COMMANDS });
    console.log(`Registered ${COMMANDS.length} slash commands`);
  } catch (err) {
    logError('slash command registration', err);
  }
  loadReminders();
  // Session registry loads lazily on first read — nothing to do at boot.
});

// ── Slash command handler ─────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  await interaction.deferReply();

  try {
    if (commandName === 'help') {
      const lines = [
        '**Commands:**',
        '`/clear` or `/new` — archive current conversation, start fresh next message',
        '`/sessions` — list this channel\'s archived conversations',
        '`/resume <number>` — re-activate an archived conversation (from `/sessions`)',
        '`/status` — live status check of configured services',
        WIKI ? '`/wiki <page>` — read a wiki page (e.g. `/wiki homelab/proxmox`)' : null,
        '`/remind <time> <message>` — set a reminder (e.g. `/remind 2h check the build`)',
        '`/reminders` — list active reminders',
        ALERT_CHANNEL_ID ? '`/simulate-alert [service] [kind]` — post a fake alert to test enrichment' : null,
        '`/help` — this list',
        '',
        'You can also just chat — I have wiki read/write, Bash, and web search. Send images and I\'ll read them. Each Discord channel keeps its own persistent claude session (tool history preserved across turns).',
      ].filter(l => l !== null);
      await interaction.editReply(lines.join('\n'));
      return;
    }

    if (commandName === 'clear' || commandName === 'new') {
      const archived = sessionReg.archiveActive(interaction.channelId);
      if (archived) await interaction.editReply(`✅ Archived current conversation (\`${archived.slice(0, 8)}…\`). Next message starts a fresh session. Use \`/sessions\` to list, \`/resume <N>\` to come back.`);
      else          await interaction.editReply('No active session to archive. Next message starts fresh.');
      return;
    }

    if (commandName === 'sessions') {
      const showAll = interaction.options.getBoolean('all') ?? false;

      if (showAll) {
        const { channels, total } = sessionReg.listAllChannels();
        if (!channels.length) { await interaction.editReply('No sessions anywhere yet.'); return; }

        const sections = [];
        for (const ch of channels) {
          const header = `**<#${ch.channelId}>** (${ch.sessions.length} session${ch.sessions.length === 1 ? '' : 's'})`;
          const lines = ch.sessions.slice(0, 5).map(s => {
            const star = s.isActive ? '★ ' : '  ';
            const stateLabel = s.state === 'active' ? 'active' : s.state === 'archived' ? 'archived' : 'lost';
            const last = s.last_used ? new Date(s.last_used).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '(unknown)';
            return `  \`${String(s.globalIndex).padStart(2)}\` ${star}[${stateLabel}] "${s.title || '(no title)'}" · ${last} · ${s.msg_count || 0} msgs`;
          });
          if (ch.sessions.length > 5) lines.push(`  _...and ${ch.sessions.length - 5} more (use \`/sessions\` in that channel to see all)_`);
          sections.push(header + '\n' + lines.join('\n'));
        }

        const reply = `**All sessions** (${total} total, numbered globally, ★ = active):\n\nUse \`/delete <number>\` to remove any session from here.\n\n` + sections.join('\n\n');
        const chunks = reply.match(/[\s\S]{1,1900}/g) || [];
        for (let i = 0; i < chunks.length; i++) {
          i === 0 ? await interaction.editReply(chunks[i]) : await interaction.followUp(chunks[i]);
        }
        return;
      }

      const list = sessionReg.listForChannel(interaction.channelId);
      if (!list.length) { await interaction.editReply('No sessions yet on this channel.'); return; }
      const lines = list.slice(0, 20).map(s => {
        const star = s.isActive ? '★ ' : '  ';
        const stateLabel = s.state === 'active' ? 'active' : s.state === 'archived' ? 'archived' : 'lost';
        const last = s.last_used ? new Date(s.last_used).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '(unknown)';
        return `\`${String(s.index).padStart(2)}\` ${star}[${stateLabel}] "${s.title || '(no title)'}" · ${last} · ${s.msg_count || 0} msgs`;
      });
      let reply = '**Sessions on this channel** (newest first, ★ = active):\n' + lines.join('\n');
      if (list.length > 20) reply += `\n\n_(showing 20 of ${list.length})_`;
      reply += '\n\nUse `/resume <number>` to re-activate one.';
      await interaction.editReply(reply);
      return;
    }

    if (commandName === 'resume') {
      const n = interaction.options.getInteger('number');
      const resumedUuid = sessionReg.resumeByIndex(interaction.channelId, n);
      if (!resumedUuid) {
        await interaction.editReply(`Could not resume session #${n} — bad index, or session is marked lost. Run \`/sessions\` to see what's available.`);
        return;
      }
      await interaction.editReply(`🔄 Resumed session #${n} (\`${resumedUuid.slice(0, 8)}…\`). Next message continues that conversation with its full tool-call history intact.`);
      return;
    }

    if (commandName === 'delete') {
      const target = interaction.options.getString('target').trim().toLowerCase();

      if (target === 'all') {
        const count = sessionReg.deleteAllInChannel(interaction.channelId);
        await interaction.editReply(count > 0
          ? `🗑️ Deleted ${count} session${count === 1 ? '' : 's'} from this channel.`
          : 'No sessions to delete in this channel.');
        return;
      }

      const n = parseInt(target, 10);
      if (isNaN(n) || n < 1) {
        await interaction.editReply('Invalid target. Use a session number from `/sessions all:True`, or `all` to delete everything in this channel.');
        return;
      }

      // Look up by global index — works from any channel.
      const found = sessionReg.getSessionByGlobalIndex(n);
      if (!found) {
        await interaction.editReply(`No session #${n} found. Run \`/sessions all:True\` to see all sessions with their numbers.`);
        return;
      }

      const deleted = sessionReg.deleteSession(found.channelId, found.uuid);
      if (deleted) {
        const channelMention = found.channelId === interaction.channelId ? 'this channel' : `<#${found.channelId}>`;
        await interaction.editReply(`🗑️ Deleted session #${n} (from ${channelMention}).`);
      } else {
        await interaction.editReply(`Could not delete session #${n}. It may have already been removed.`);
      }
      return;
    }

    if (commandName === 'purge') {
      const confirmed = interaction.options.getBoolean('confirm');
      if (!confirmed) {
        await interaction.editReply('Set `confirm` to `True` to actually run the purge. This will wipe every session across every channel and cannot be undone.');
        return;
      }
      const count = sessionReg.purgeAll();
      await interaction.editReply(`🗑️ Purged ${count} session${count === 1 ? '' : 's'} across all channels. Starting fresh.`);
      return;
    }

    if (commandName === 'status') {
      const services = config.statusServices || [];
      if (!services.length) {
        await interaction.editReply('No services configured. Add entries to `statusServices` in `config.js`.');
        return;
      }
      const defaultFlags = '-s -o /dev/null -w "%{http_code}"';
      const serviceList = services.map(s => {
        const flags = s.curlFlags || defaultFlags;
        return `${s.name} (${s.url}, curl flags: ${flags})`;
      }).join('; ');
      const userText = `Check the status of these services using Bash curl and return a compact up/down table: ${serviceList}`;
      const response = await runClaude({ userText, appendSystem: BASE_SYSTEM, tools: 'Bash', oneShot: true });
      await sendChunks(interaction, response.display || 'Status check failed.', { isInteraction: true });
      return;
    }

    if (commandName === 'wiki') {
      if (!WIKI) {
        await interaction.editReply('Wiki not configured. Set `wikiPath` in `config.js`.');
        return;
      }
      const page = interaction.options.getString('page').replace(/\.md$/, '') + '.md';
      try {
        const text = fs.readFileSync(path.join(WIKI, page), 'utf8');
        await sendChunks(interaction, `**${page}**\n\`\`\`\n${text.slice(0, 1800)}\n\`\`\``, { isInteraction: true });
      } catch {
        await interaction.editReply(`Page not found: \`${page}\``);
      }
      return;
    }

    if (commandName === 'remind') {
      const timeStr = interaction.options.getString('time');
      const reminderText = interaction.options.getString('message');
      const ms = parseReminderMs(timeStr);
      if (!ms) { await interaction.editReply('Could not parse time. Try `2h`, `30m`, `1h30m`.'); return; }
      const userId = interaction.user.id;
      if (!reminders[userId]) reminders[userId] = [];
      const fireAt = Date.now() + ms;
      const tid = setTimeout(async () => {
        try {
          const user = await client.users.fetch(userId);
          const dm = await user.createDM();
          await dm.send(`⏰ **Reminder:** ${reminderText}`);
        } catch (e) { logError('reminder DM', e); }
        reminders[userId] = reminders[userId].filter(r => r.id !== tid);
        saveReminders();
      }, ms);
      reminders[userId].push({ id: tid, text: reminderText, fireAt });
      saveReminders();
      await interaction.editReply(`⏰ Reminder set for ${msToHuman(ms)}: "${reminderText}"`);
      return;
    }

    if (commandName === 'reminders') {
      const list = reminders[interaction.user.id] || [];
      if (!list.length) { await interaction.editReply('No active reminders.'); return; }
      const lines = list.map(r => `• "${r.text}" — in ${msToHuman(r.fireAt - Date.now())}`);
      await interaction.editReply('**Active reminders:**\n' + lines.join('\n'));
      return;
    }

    if (commandName === 'simulate-alert') {
      if (!ALERT_CHANNEL_ID) {
        await interaction.editReply('Alert enrichment is not configured. Set `alertChannelId` in `config.js`.');
        return;
      }
      const service = interaction.options.getString('service') || 'TestService';
      const kind = interaction.options.getString('kind') || 'down';
      const channel = await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null);
      if (!channel) { await interaction.editReply(`Could not fetch alert channel (${ALERT_CHANNEL_ID}).`); return; }

      let embed;
      if (kind === 'resolved') {
        embed = {
          title: `✅ ${service} — resolved`,
          description: `${service} is healthy again. Duration: 1m 24s.`,
          color: 0x57f287,
          fields: [
            { name: 'Service', value: service, inline: true },
            { name: 'Recovered', value: new Date().toISOString(), inline: true },
          ],
          footer: { text: 'simulated alert (test)' },
        };
      } else if (kind === 'action') {
        embed = {
          title: `⚠️ ${service} — action needed`,
          description: `Exhausted 3 auto-restart attempts. Manual intervention required.`,
          color: 0xed4245,
          fields: [
            { name: 'Service', value: service, inline: true },
            { name: 'Attempts', value: '3', inline: true },
            { name: 'Last error', value: '`connection refused on port 8080`' },
          ],
          footer: { text: 'simulated alert (test)' },
        };
      } else {
        embed = {
          title: `🚨 ${service} is down`,
          description: `Health check failed twice in a row. Auto-restart attempt 1/3 in progress.`,
          color: 0xfee75c,
          fields: [
            { name: 'Service', value: service, inline: true },
            { name: 'Detected', value: new Date().toISOString(), inline: true },
            { name: 'Validator', value: '`/api/v3/health → expected []`' },
          ],
          footer: { text: 'simulated alert (test)' },
        };
      }
      await channel.send({ embeds: [embed] });
      await interaction.editReply(`✅ Posted simulated **${kind}** alert for **${service}** to <#${ALERT_CHANNEL_ID}>. Enrichment should follow in the thread.`);
      return;
    }

  } catch (err) {
    logError('interaction handler', err);
    const msg = `⚠️ ${err.message?.slice(0, 300) || 'Unknown error'}`;
    try {
      interaction.deferred ? await interaction.editReply(msg) : await interaction.reply(msg);
    } catch { /* interaction expired — swallow */ }
  }
});

// ── Proactive alert helpers ───────────────────────────────────────────────────

// Detect an inbound alert message: top-level post in the alert channel, authored
// by a bot (covers our own bot user, which monitoring tools post through), with
// at least one embed whose title starts with an emoji prefix.
//
// Self-loop safety: the bot's enrichment reply lives INSIDE the auto-created
// thread, not at the channel root, so the channel.id check below excludes it.
// And in `isAlertThreadFollowup` we filter `author.bot === false`, so our own
// thread replies can't trigger that path either. Two independent filters; both
// must stay.
function isAlertMessage(message) {
  if (!ALERT_CHANNEL_ID) return false;
  if (!message.channel || message.channel.id !== ALERT_CHANNEL_ID) return false;
  if (!message.author?.bot) return false;
  if (!message.embeds?.length) return false;
  const title = (message.embeds[0].title || '').trim();
  return /^(🚨|✅|⚠️)\s/.test(title);
}

// User replying inside an auto-created thread on an alert message. Treat as a
// dedicated incident conversation — no @mention required.
function isAlertThreadFollowup(message) {
  if (!ALERT_CHANNEL_ID) return false;
  if (message.author?.bot) return false;
  const ch = message.channel;
  if (!ch?.isThread?.()) return false;
  return ch.parentId === ALERT_CHANNEL_ID;
}

// Flatten an alert message (embed title/description/fields + plain content)
// into a single readable string for the synthetic claude prompt.
function formatAlertContent(message) {
  const parts = [];
  if (message.content) parts.push(message.content);
  for (const e of message.embeds || []) {
    if (e.title) parts.push(`**${e.title}**`);
    if (e.description) parts.push(e.description);
    for (const f of e.fields || []) {
      parts.push(`**${f.name}:** ${f.value}`);
    }
    if (e.footer?.text) parts.push(`_${e.footer.text}_`);
  }
  return parts.join('\n');
}

// Find or wait for the auto-created thread on an alert message; fall back to
// creating one ourselves if the monitoring tool didn't make one within ~5s.
async function fetchThreadForMessage(message) {
  if (message.thread) return message.thread;
  try {
    const ch = await client.channels.fetch(message.id);
    if (ch?.isThread?.()) return ch;
  } catch (e) {
    // 10003 = Unknown Channel = no thread on this message yet (normal "still
    // waiting" case). Log anything else (rate limit, 5xx).
    if (e?.code !== 10003) logError('fetchThreadForMessage', e);
  }
  return null;
}

async function getOrCreateAlertThread(message) {
  // First fast path — the thread might already be attached on the live object.
  let thread = await fetchThreadForMessage(message);
  if (thread) return thread;
  // Wait briefly for the monitoring tool to create one. Poll every 1s for 5s.
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    thread = await fetchThreadForMessage(message);
    if (thread) return thread;
  }
  // Fall back to creating our own.
  try {
    const title = (message.embeds[0]?.title || 'Alert').slice(0, 90);
    return await message.startThread({ name: title, autoArchiveDuration: 1440 });
  } catch (e) {
    logError('getOrCreateAlertThread', e);
    return null;
  }
}

async function handleInboundAlert(message) {
  const thread = await getOrCreateAlertThread(message);
  if (!thread) return; // logged inside the helper
  const channelId = thread.id;
  const alertText = formatAlertContent(message);
  if (!alertText.trim()) return;

  enqueue(channelId, async () => {
    let typingInterval;
    try {
      await thread.sendTyping().catch(() => {}); // some discord.js builds reject on threads
      typingInterval = setInterval(() => thread.sendTyping().catch(() => {}), 8000);

      const prompt = [
        'An automated alert just fired. You are replying in the auto-created thread for this incident — the user will continue the conversation here.',
        '',
        'If a monitoring/auto-restart workflow is already handling this, do NOT duplicate that work or run restarts yourself unless the user explicitly asks.',
        '',
        'Your job:',
        '- Read the alert and enrich it with context from any relevant wiki pages (the service, its dependencies, recent prior incidents).',
        '- Briefly say what is likely going on.',
        '  - 🚨 (down): note what any automation is probably doing and propose checks/actions only a human can do (UI-only fixes, logs to grep, manual interventions).',
        '  - ✅ (resolved): confirm what came back, offer a quick post-mortem note for the wiki, flag follow-ups.',
        '  - ⚠️ (action needed): treat as exhausted auto-restart — ask what the user wants to do, offer the next manual step.',
        '- Ask before any destructive action.',
        '- Keep it tight: this is a Discord thread, not a doc. Use short bullets, no markdown tables.',
        '',
        'Alert:',
        alertText,
      ].join('\n');

      // Alert enrichment is a focused task — it only needs tool rules and relevant
      // service docs. User profile, memory, hot.md, and CLAUDE.md are all noise here.
      const topicFiles = getWikiFiles(alertText);
      const topicContext = topicFiles.length ? readWiki(...topicFiles) : '';
      let appendSystem = BASE_SYSTEM;
      if (topicContext) appendSystem += `\n\n=== TOPIC CONTEXT ===\n${topicContext}`;

      appendLog(channelId, 'user', `[INBOUND ALERT]\n${alertText}`);

      let lastSentLength = 0;
      let lastSendTime = 0;

      const fullPrompt = `=== ALERT ENRICHMENT PROMPT ===\n${prompt}`;
      const result = await runClaude({
        userText: fullPrompt,
        channelId,
        appendSystem,
        onChunk: async (acc) => {
          const now = Date.now();
          if (now - lastSendTime >= 2000) {
            const newContent = acc.slice(lastSentLength).trim();
            if (newContent) {
              lastSentLength = acc.length;
              lastSendTime = now;
              const chunks = newContent.match(/[\s\S]{1,1900}/g) || [];
              for (const chunk of chunks) await thread.send(chunk);
            }
          }
        },
      });

      clearInterval(typingInterval);

      const remaining = result.full.slice(lastSentLength).trim();
      if (remaining) {
        const chunks = remaining.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) await thread.send(chunk);
      } else if (lastSentLength === 0) {
        const chunks = (result.display || '(no response)').match(/[\s\S]{1,1900}/g);
        for (const chunk of chunks) await thread.send(chunk);
      }

      appendLog(channelId, 'assistant', result.full.trim() || result.display, result.sessionUuid);
    } catch (err) {
      clearInterval(typingInterval);
      logError('handleInboundAlert', err);
      try { await thread.send(`⚠️ Failed to enrich alert: ${err.message?.slice(0, 300)}`); } catch {}
    }
  });
}

// ── Chat message handler ──────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  // Ignore anything that pre-dates this process — keeps a restart from
  // triggering enrichments for every historical alert in the channel.
  if (message.createdTimestamp < startupTime) return;

  // Inbound alert detection MUST run before the bot-author filter below,
  // because alerts are authored by our own bot user (monitoring posts via shared token).
  if (isAlertMessage(message)) return handleInboundAlert(message);

  if (message.author.bot) return;

  const isDM = !message.guild;
  const isMentioned = client.user && message.mentions.has(client.user.id);
  const isAlertFollowup = isAlertThreadFollowup(message);
  if (!isDM && !isMentioned && !isAlertFollowup) return;

  const content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!content && message.attachments.size === 0) return;

  // Ignore slash command invocations — handled by InteractionCreate
  if (content.startsWith('/')) return;

  const channelId = message.channelId;

  // Per-channel queue: serialize handlers so concurrent messages don't race
  // on the same `claude -p --resume <uuid>` jsonl. See enqueue() / lockChain above.
  enqueue(channelId, async () => {
    try {
      // Handle image attachments
      let attachmentNote = '';
      if (message.attachments.size > 0) {
        const tmpPaths = [];
        for (const [, att] of message.attachments) {
          if (att.contentType?.startsWith('image/')) {
            const ext = path.extname(att.name) || '.png';
            const tmp = path.join(os.tmpdir(), `discord-${att.id}${ext}`);
            try { await downloadFile(att.url, tmp); tmpPaths.push(tmp); } catch {}
          }
        }
        if (tmpPaths.length)
          attachmentNote = `\n\n[User sent ${tmpPaths.length} image(s). Use Read tool to view: ${tmpPaths.join(', ')}]`;
      }

      // BASE_SYSTEM + MEMORY_HINT re-injected every turn via --append-system-prompt.
      // ~/.claude/CLAUDE.md loads automatically by the CLI and tells Claude where
      // everything lives. Claude reads wiki, hot.md, user profile on demand.
      // Topic context is the only thing we pre-fetch — it's message-specific and
      // keyword-matched so we know it's relevant before Claude even starts.
      const topicFiles = getWikiFiles(content);
      const topicContext = topicFiles.length ? readWiki(...topicFiles) : '';
      let appendSystem = BASE_SYSTEM + MEMORY_HINT;
      if (topicContext) appendSystem += `\n\n=== TOPIC CONTEXT ===\n${topicContext}`;

      const userText = `${content}${attachmentNote}`;

      // Audit log: write the user side BEFORE spawning so a crashed claude run
      // still leaves the user msg in chat-log.jsonl (sessionId fills in post-run).
      appendLog(channelId, 'user', content);

      let lastSentLength = 0;
      let lastSendTime = 0;

      await message.channel.sendTyping();
      const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

      const result = await runClaude({
        userText,
        channelId,
        appendSystem,
        onChunk: async (acc) => {
          const now = Date.now();
          if (now - lastSendTime >= 2000) {
            const newContent = acc.slice(lastSentLength).trim();
            if (newContent) {
              // Claim position synchronously BEFORE awaiting send. Otherwise a
              // concurrent onChunk or the final flush below can re-read
              // lastSentLength=stale and re-send the same content (the
              // "last message repeats" symptom).
              lastSentLength = acc.length;
              lastSendTime = now;
              const chunks = newContent.match(/[\s\S]{1,1900}/g) || [];
              for (const chunk of chunks) await message.channel.send(chunk);
            }
          }
        },
      });

      clearInterval(typingInterval);

      // Send any content that wasn't flushed during streaming
      const remaining = result.full.slice(lastSentLength).trim();
      if (remaining) {
        const chunks = remaining.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) await message.channel.send(chunk);
      } else if (lastSentLength === 0) {
        // Nothing was streamed at all — send the display result
        const chunks = (result.display || '(no response)').match(/[\s\S]{1,1900}/g);
        for (const chunk of chunks) await message.channel.send(chunk);
      }

      // Assistant side of the audit (user side already logged pre-spawn).
      const fullResponse = result.full.trim() || result.display;
      appendLog(channelId, 'assistant', fullResponse, result.sessionUuid);

    } catch (err) {
      logError('message handler', err);
      await message.channel.send(`⚠️ ${err.message?.slice(0, 300) || 'Unknown error'}`);
    }
  });
});

client.login(DISCORD_TOKEN);
