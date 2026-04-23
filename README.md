# claude-telemetry

Per-turn knowledge-base hit-rate telemetry for Claude Code. Collects hook events into a global `~/.claude/claude-telemetry/projects/<project-bucket>/events.jsonl`, renders a self-contained offline HTML dashboard, and ships both as a Claude Code plugin.

## What it measures

- **Turn-level knowledge hit rate** — how often each doc / rule / skill is actually read in a turn
- **Tool usage** — Read / Grep / Glob / Edit / Write counts
- **Permission requests & idle prompts** — friction points
- **Per-turn token & API cost** — from the transcript

The core question it answers: *is my documentation actually being consumed by Claude, or is it sitting in the repo unread?*

## Install

Add the marketplace once:

```bash
/plugin marketplace add wangshunnn/claude-telemetry
```

Then install the plugin:

```bash
/plugin install claude-telemetry
```

If you already have another marketplace that also ships a `claude-telemetry` plugin, use the explicit form instead:

```bash
/plugin install claude-telemetry@soonwang-plugins
```

For local development, you can still install directly from a checkout:

```bash
# from any project you want to instrument
claude --plugin-dir ~/mycode/github/claude-telemetry
```

Or add to project settings (`.claude/settings.local.json`):
```json
{ "plugins": { "claude-telemetry": "/absolute/path/to/claude-telemetry" } }
```

Once installed, the plugin's hooks fire automatically. Use Claude in the project for a few turns to populate `events.jsonl`, then run:

```
/claude-telemetry:open
```

The command builds the current project's global `index.html` + `snapshot.json` and opens the dashboard in your browser.

## Updating

If you already installed the plugin from the marketplace, update with:

```bash
/plugin marketplace update soonwang-plugins
/plugin update claude-telemetry
/reload-plugins
```

Third-party marketplaces do not auto-refresh by default. Users can optionally enable marketplace auto-update in Claude Code's plugin UI.

## Release process

This repository follows Claude Code marketplace best practices:

- The distributed plugin version is managed in `.claude-plugin/marketplace.json`
- `.claude-plugin/plugin.json` intentionally omits `version` because this plugin is shipped from a marketplace
- Stable releases start at `1.0.0`
- Changes are documented in [CHANGELOG.md](./CHANGELOG.md)
- Pre-release builds should use semver prerelease tags such as `1.1.0-beta.1`

For each release:

1. Update the plugin version in `.claude-plugin/marketplace.json`
2. Update [CHANGELOG.md](./CHANGELOG.md)
3. Validate locally with `claude plugin validate .` and `pnpm test`
4. Push the release commit to GitHub

After a new version is pushed, users update with the commands above.

## Config (optional)

By default, the dashboard counts these as "knowledge targets":

- `docs/**/*.md`
- `.claude/rules/**/*.md`
- `**/skills/*/SKILL.md`
- Any `AGENTS.md` / `CLAUDE.md` **except the auto-loaded ones** at the project root, `.claude/`, or `.agents/` (those load every session and would drown out real signal)
- `.cursor/rules/**/*.mdc`
- `.github/copilot-instructions.md`

To customize, drop a `.claude/telemetry.config.mjs` in your project root:

```js
import { basename, dirname } from 'node:path';

export const knowledgeTargets = [
  { kind: 'doc',   label: 'Docs',  test: (p) => /\/docs\/.*\.md$/i.test(p) },
  { kind: 'rule',  label: 'Rule',  test: (p) => /\/\.claude\/rules\/.*\.md$/i.test(p) },
  { kind: 'skill', label: 'Skill', test: (p) => /\/skills\/.+\/SKILL\.md$/i.test(p) },
  {
    kind: 'agents', label: 'Agents',
    test: (p, ctx) => /^(AGENTS|CLAUDE)\.md$/i.test(basename(p))
      && dirname(p) !== ctx.projectRoot, // skip project-root one
  },
];
```

Each target needs `kind` (string id), `label` (display name), and `test` — a function receiving `(path, ctx)` where `ctx.projectRoot` is the current project root (use it to exclude files at a specific location). Invalid entries are skipped with a warning.

## Files on disk

After the plugin runs, telemetry stays out of your repo and lands under:

```
~/.claude/claude-telemetry/
└── projects/
    └── <project-bucket>/
        ├── events.jsonl   # raw append-only event stream
        ├── index.html     # self-contained dashboard
        ├── snapshot.json  # aggregate, for static-site sync
        └── meta.json      # project bucket metadata
```

`<project-bucket>` follows Claude's own `~/.claude/projects/` naming style. For example, `/Users/mycode/github/claude-telemetry` becomes `-Users-mycode-github-claude-telemetry`. In the rare case two different paths map to the same bucket name, claude-telemetry appends a short suffix to keep them separate.

## Schema

Each event is one line of JSON with a stable envelope:

```json
{ "ts": "ISO8601", "session_id": "...", "event": "...", "...": "..." }
```

| event | source hook | key fields |
| --- | --- | --- |
| `session_start` | `SessionStart` | `cwd` |
| `user_prompt` | `UserPromptSubmit` | `prompt` |
| `instructions_loaded` | `InstructionsLoaded` | `raw.file_path` / `raw.load_reason` |
| `tool_read` | `PostToolUse(Read)` | `file` |
| `tool_search` | `PostToolUse(Grep\|Glob)` | `tool` / `pattern` / `glob` / `path` |
| `tool_write` | `PostToolUse(Edit\|Write)` | `tool` / `file` |
| `permission_request` | `PermissionRequest` | `tool` / `input` / `suggestions` |
| `notification` | `Notification(idle_prompt)` | `notification_type` / `message` |
| `session_stop` | `Stop` / `StopFailure` | `stop_status` / `tokens` / `model` / `reply` |

## Hit-rate formula

```
global hit rate        = turns that triggered target / total turns
in-knowledge hit rate  = turns that triggered target / turns with any knowledge hit
```

A *turn* is bracketed by `user_prompt` → `session_stop`. Repeated reads of the same file inside a turn count once.

## Privacy caveats

Hook payloads include raw `prompt` text, absolute file paths, and permission-request shell commands. Events stay local by default (written under your user-scoped `~/.claude/claude-telemetry/` directory), but be careful before sharing or uploading. No redaction is built in yet.

## Layout

```
claude-telemetry/
├── .claude-plugin/
│   ├── plugin.json          # plugin manifest
│   └── marketplace.json     # marketplace catalog
├── hooks/
│   └── hooks.json           # hook wiring — SessionStart, PostToolUse, Stop, …
├── commands/
│   └── open.md              # /claude-telemetry:open
├── scripts/
│   ├── paths.mjs            # resolves ~/.claude/claude-telemetry/projects/<bucket>/*
│   ├── config.mjs           # default knowledge preset + user override loader
│   ├── append-event.mjs     # generic hook collector
│   ├── on-stop.mjs          # Stop / StopFailure collector (parses transcript)
│   ├── build.mjs            # events.jsonl → index.html + snapshot.json
│   └── open.mjs             # build + launch browser
└── README.md
```

## License

MIT
