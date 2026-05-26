// Session registry — per-Discord-channel Claude CLI session state.
//
// Design: sessions are NEVER deleted. /clear and /new archive the active
// session rather than removing it, so prior conversations can be resumed
// at any time via /resume <N>.
//
// Two surfaces:
//   • ./sessions.json         — hot-path ops state. Written on every turn
//     (recordTurn bumps last_used + msg_count). Tiny file, ms-scale write.
//   • ./sessions-view.md      — human-readable snapshot. Regenerated ONLY
//     on state transitions (new / archive / resume / lost), never per-message,
//     to avoid noisy file churn.

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

const FILE = path.join(__dirname, 'sessions.json');
const WIKI_PAGE = path.join(__dirname, 'sessions-view.md');

// Claude CLI persists session JSONLs in a cwd-encoded subdirectory under
// ~/.claude/projects/. The encoding replaces every '/' with '-' in the cwd.
// We derive this from config.wikiPath so it stays in sync with the bot's
// actual working directory.
const _cwd = config.wikiPath || process.cwd();
const CLAUDE_PROJECT_DIR = path.join(os.homedir(), '.claude', 'projects', _cwd.replace(/\//g, '-'));

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

function nowIso() { return new Date().toISOString(); }

function ensureChannel(state, channelId) {
  if (!state[channelId]) state[channelId] = { active: null, sessions: {} };
  return state[channelId];
}

function titleFrom(userMessage) {
  const t = (userMessage || '').replace(/\s+/g, ' ').trim();
  if (!t) return '(empty)';
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

function sessionFileExists(uuid) {
  if (!uuid) return false;
  return fs.existsSync(path.join(CLAUDE_PROJECT_DIR, `${uuid}.jsonl`));
}

// Return active UUID for channel, but only if the underlying JSONL still
// exists on disk. If it's gone, auto-mark as lost and return null so caller
// starts a fresh session. This is the recovery path for manual jsonl deletion
// or claude-CLI version churn that invalidates session files.
function getActive(channelId) {
  const state = load();
  const ch = state[channelId];
  if (!ch || !ch.active) return null;
  if (!sessionFileExists(ch.active)) {
    if (ch.sessions[ch.active]) {
      ch.sessions[ch.active].state = 'lost';
      ch.sessions[ch.active].lost_at = nowIso();
    }
    ch.active = null;
    save(state);
    regenerateWikiPage(state);
    return null;
  }
  return ch.active;
}

// Caller has minted a fresh UUID and successfully launched the session.
// Register it as the channel's active session. Archives any prior active.
function registerNew(channelId, uuid, firstUserMessage) {
  const state = load();
  const ch = ensureChannel(state, channelId);
  if (ch.active && ch.active !== uuid && ch.sessions[ch.active]?.state === 'active') {
    ch.sessions[ch.active].state = 'archived';
    ch.sessions[ch.active].archived_at = nowIso();
  }
  ch.sessions[uuid] = {
    state: 'active',
    title: titleFrom(firstUserMessage),
    created: nowIso(),
    last_used: nowIso(),
    msg_count: 1,
  };
  ch.active = uuid;
  save(state);
  regenerateWikiPage(state);
}

// Hot path — bumps last_used + msg_count. No wiki write.
// Defensive: skip if the session is no longer active (covers the narrow race
// where the user fires /clear or /resume <N> while a spawn is in-flight; the
// spawn still completes and replies, but we don't want its post-completion
// recordTurn to bump stats on a now-archived session).
function recordTurn(channelId, uuid) {
  const state = load();
  const ch = state[channelId];
  if (!ch || !ch.sessions[uuid]) return;
  if (ch.sessions[uuid].state !== 'active') return;
  ch.sessions[uuid].last_used = nowIso();
  ch.sessions[uuid].msg_count = (ch.sessions[uuid].msg_count || 0) + 1;
  save(state);
}

// /clear or /new: archive active, clear active pointer. Next message creates fresh.
// Returns the archived UUID (or null if there was no active session).
function archiveActive(channelId) {
  const state = load();
  const ch = state[channelId];
  if (!ch || !ch.active) return null;
  const uuid = ch.active;
  if (ch.sessions[uuid] && ch.sessions[uuid].state === 'active') {
    ch.sessions[uuid].state = 'archived';
    ch.sessions[uuid].archived_at = nowIso();
  }
  ch.active = null;
  save(state);
  regenerateWikiPage(state);
  return uuid;
}

// Resume failed mid-turn (file gone, corrupt, etc).
function markLost(channelId, uuid) {
  const state = load();
  const ch = state[channelId];
  if (!ch || !ch.sessions[uuid]) return;
  ch.sessions[uuid].state = 'lost';
  ch.sessions[uuid].lost_at = nowIso();
  if (ch.active === uuid) ch.active = null;
  save(state);
  regenerateWikiPage(state);
}

// Newest-first list for /sessions. Index 1 = most recent. Active session is flagged.
function listForChannel(channelId) {
  const state = load();
  const ch = state[channelId];
  if (!ch) return [];
  return Object.entries(ch.sessions)
    .map(([uuid, meta]) => ({ uuid, ...meta }))
    .sort((a, b) => (b.last_used || b.created).localeCompare(a.last_used || a.created))
    .map((s, i) => ({ index: i + 1, isActive: s.uuid === ch.active, ...s }));
}

// /resume <index>. Archives the current active first; refuses lost sessions
// and missing jsonls. Returns the resumed UUID or null on failure.
function resumeByIndex(channelId, index) {
  const list = listForChannel(channelId);
  const target = list.find(s => s.index === index);
  if (!target) return null;
  if (target.state === 'lost') return null;
  if (!sessionFileExists(target.uuid)) {
    markLost(channelId, target.uuid);
    return null;
  }

  const state = load();
  const ch = state[channelId];
  if (ch.active && ch.active !== target.uuid && ch.sessions[ch.active]?.state === 'active') {
    ch.sessions[ch.active].state = 'archived';
    ch.sessions[ch.active].archived_at = nowIso();
  }
  ch.sessions[target.uuid].state = 'active';
  ch.sessions[target.uuid].last_used = nowIso();
  delete ch.sessions[target.uuid].archived_at;
  ch.active = target.uuid;
  save(state);
  regenerateWikiPage(state);
  return target.uuid;
}

function regenerateWikiPage(state) {
  const today = new Date().toISOString().slice(0, 10);
  let body = `---
type: meta
title: "Discord Bot Sessions"
updated: ${today}
tags:
  - meta
  - discord-bot
status: evergreen
---

# Discord Bot Sessions

Auto-generated registry of Claude CLI sessions per Discord channel. Updated on every state transition (new / archive / resume / lost) — never on a plain message. Underlying JSONLs live at \`${CLAUDE_PROJECT_DIR}/<uuid>.jsonl\`.

`;

  const channels = Object.entries(state);
  if (channels.length === 0) {
    body += '_No sessions yet._\n';
  } else {
    for (const [channelId, ch] of channels) {
      const list = Object.entries(ch.sessions || {})
        .map(([uuid, meta]) => ({ uuid, ...meta }))
        .sort((a, b) => (b.last_used || b.created).localeCompare(a.last_used || a.created));
      body += `## Channel \`${channelId}\`\n\n`;
      body += `**Active:** ${ch.active || '_(none — next message starts fresh)_'}\n\n`;
      if (list.length === 0) {
        body += '_(no sessions)_\n\n';
        continue;
      }
      body += '| # | State | Title | Created | Last Used | Msgs | UUID |\n';
      body += '|---|-------|-------|---------|-----------|------|------|\n';
      list.forEach((s, i) => {
        const stateLabel = s.state + (s.uuid === ch.active ? ' ★' : '');
        body += `| ${i + 1} | ${stateLabel} | ${s.title || ''} | ${(s.created || '').slice(0, 16)} | ${(s.last_used || '').slice(0, 16)} | ${s.msg_count || 0} | \`${s.uuid}\` |\n`;
      });
      body += '\n';
    }
  }

  try { fs.writeFileSync(WIKI_PAGE, body); }
  catch (e) { console.error('regenerateWikiPage failed:', e.message); }
}

// Delete a specific session by UUID. Removes the registry entry and the
// underlying JSONL file if it exists. Returns true if deleted, false if not found.
function deleteSession(channelId, uuid) {
  const state = load();
  const ch = state[channelId];
  if (!ch || !ch.sessions[uuid]) return false;
  const jsonlPath = path.join(CLAUDE_PROJECT_DIR, `${uuid}.jsonl`);
  try { if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath); } catch {}
  delete ch.sessions[uuid];
  if (ch.active === uuid) ch.active = null;
  save(state);
  regenerateWikiPage(state);
  return true;
}

// Delete all sessions for a single channel. Returns the number deleted.
function deleteAllInChannel(channelId) {
  const state = load();
  const ch = state[channelId];
  if (!ch) return 0;
  let count = 0;
  for (const uuid of Object.keys(ch.sessions)) {
    const jsonlPath = path.join(CLAUDE_PROJECT_DIR, `${uuid}.jsonl`);
    try { if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath); } catch {}
    count++;
  }
  state[channelId] = { active: null, sessions: {} };
  save(state);
  regenerateWikiPage(state);
  return count;
}

// Wipe every session across every channel. Returns the total number deleted.
function purgeAll() {
  const state = load();
  let count = 0;
  for (const ch of Object.values(state)) {
    for (const uuid of Object.keys(ch.sessions || {})) {
      const jsonlPath = path.join(CLAUDE_PROJECT_DIR, `${uuid}.jsonl`);
      try { if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath); } catch {}
      count++;
    }
  }
  fs.writeFileSync(FILE, JSON.stringify({}, null, 2));
  regenerateWikiPage({});
  return count;
}

module.exports = {
  getActive,
  registerNew,
  recordTurn,
  archiveActive,
  markLost,
  listForChannel,
  resumeByIndex,
  sessionFileExists,
  deleteSession,
  deleteAllInChannel,
  purgeAll,
};
