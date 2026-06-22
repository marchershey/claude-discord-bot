// config.example.js — Copy this file to config.js and fill in your values.
// config.js is gitignored so your personal settings stay local.

module.exports = {

  // ── Paths ──────────────────────────────────────────────────────────────────

  // Path to the Claude CLI binary. Run `which claude` to find yours.
  claudePath: '/home/you/.local/bin/claude',

  // Path to your wiki/notes directory (e.g. an Obsidian vault wiki folder,
  // or any directory of markdown files). Leave null to disable wiki features.
  wikiPath: null,  // e.g. '/home/you/vault/wiki'

  // Path to the vault root (parent of wikiPath).
  // Used to find a vault-level CLAUDE.md if you have one. Leave null if not.
  vaultPath: null,  // e.g. '/home/you/vault'

  // Path to a personal user-profile markdown file (optional).
  // If set, this file is injected into Claude's context every conversation turn
  // so it always knows who it's talking to.
  userMdPath: null,  // e.g. '/home/you/vault/wiki/people/you.md'

  // Path to a directory of persistent memory files (optional).
  // Claude Code writes small .md files here to remember facts about you across
  // sessions (preferences, project context, ongoing work, etc.). Pointing the
  // bot at the same directory means the Discord bot shares that memory.
  // If you use Claude Code, check: ~/.claude/projects/<encoded-homedir>/memory/
  memoryPath: null,  // e.g. '/home/you/.claude/projects/-home-you/memory'

  // Directory the bot launches `claude` from (the spawned process's cwd).
  // Set this to the SAME directory you run the interactive `claude` CLI from.
  // Claude keys its auto-loaded memory, CLAUDE.md, and session/resume list by
  // this cwd — so matching it means the bot shares your brain and its sessions
  // appear in your `claude` resume list. Kept separate from wikiPath so wiki
  // file access is unchanged. Falls back to wikiPath, then the bot's own dir.
  launchCwd: null,  // e.g. '/home/you'

  // ── Identity ───────────────────────────────────────────────────────────────

  // Your name — used in Claude's system prompt so it addresses you naturally.
  // Leave null to use generic "the user" language.
  userName: null,  // e.g. 'Alex'

  // ── Alert enrichment ──────────────────────────────────────────────────────

  // Discord channel ID for proactive alert enrichment.
  // When a bot posts an embed starting with 🚨, ✅, or ⚠️ in this channel,
  // Claude automatically analyzes it and replies in the auto-created thread.
  // Set to null to disable alert enrichment entirely.
  alertChannelId: null,  // e.g. '1234567890123456789'

  // ── /status command ───────────────────────────────────────────────────────

  // Services to check when someone runs /status.
  // Each entry is curl'd and results are shown in a compact up/down table.
  // curlFlags defaults to '-s -o /dev/null -w "%{http_code}"' if omitted.
  statusServices: [
    // { name: 'My App',   url: 'https://example.com' },
    // { name: 'Proxmox',  url: 'https://10.0.0.1:8006', curlFlags: '-k -s -o /dev/null -w "%{http_code}"' },
    // { name: 'Grafana',  url: 'http://10.0.0.1:3000' },
  ],

  // ── Wiki topic mappings ───────────────────────────────────────────────────

  // Keyword → wiki file mappings for automatic context injection.
  // When a user message matches a pattern, the corresponding wiki file is
  // injected into Claude's context for that turn (up to 3000 chars each).
  // Patterns are matched against the lowercased message text.
  topicMappings: [
    // { pattern: /proxmox|vm|lxc/,               file: 'homelab/proxmox.md' },
    // { pattern: /plex|sonarr|radarr|media/,      file: 'homelab/media.md' },
    // { pattern: /docker|portainer|container/,    file: 'homelab/docker.md' },
    // { pattern: /cloudflare|dns|tunnel|domain/,  file: 'homelab/network.md' },
  ],

};
