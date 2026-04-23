# claude-telemetry

Per-turn knowledge-base hit-rate telemetry for Claude Code. Collects hook events into `.claude/telemetry/events.jsonl` in your project, renders a self-contained offline HTML dashboard, and ships both as a Claude Code plugin.

## What it measures

- **Turn-level knowledge hit rate** — how often each doc / rule / skill is actually read in a turn
- **Tool usage** — Read / Grep / Glob / Edit / Write counts
- **Permission requests & idle prompts** — friction points
- **Per-turn token & API cost** — from the transcript

The core question it answers: *is my documentation actually being consumed by Claude, or is it sitting in the repo unread?*

## Install (local plugin)

```bash
# from any project you want to instrument
claude --plugin-dir ~/mycode/github/claude-telemetry-plugin
```

Or add to project settings (`.claude/settings.local.json`):
```json
{ "plugins": { "claude-telemetry": "/absolute/path/to/claude-telemetry-plugin" } }
```

Once installed, the plugin's hooks fire automatically. Use Claude in the project for a few turns to populate `events.jsonl`, then run:

```
/claude-telemetry:open
```

The command builds `.claude/telemetry/index.html` + `snapshot.json` and opens the dashboard in your browser.

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

## Files in your project

After the plugin runs, you'll see:

```
.claude/telemetry/
├── events.jsonl     # raw append-only event stream (gitignore recommended)
├── index.html       # dashboard (gitignore recommended)
└── snapshot.json    # aggregate, for static-site sync (gitignore recommended)
```

Add this to your project `.gitignore`:
```
.claude/telemetry/events.jsonl
.claude/telemetry/index.html
.claude/telemetry/snapshot.json
```

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

Hook payloads include raw `prompt` text, absolute file paths, and permission-request shell commands. Events stay local by default (written to your project's `.claude/telemetry/events.jsonl`), but be careful before sharing or uploading. No redaction is built in yet.

## Layout

```
claude-telemetry-plugin/
├── .claude-plugin/
│   └── plugin.json          # plugin manifest
├── hooks/
│   └── hooks.json           # hook wiring — SessionStart, PostToolUse, Stop, …
├── commands/
│   └── open.md              # /claude-telemetry:open
├── scripts/
│   ├── paths.mjs            # resolves $CLAUDE_PROJECT_DIR/.claude/telemetry/*
│   ├── config.mjs           # default knowledge preset + user override loader
│   ├── append-event.mjs     # generic hook collector
│   ├── on-stop.mjs          # Stop / StopFailure collector (parses transcript)
│   ├── build.mjs            # events.jsonl → index.html + snapshot.json
│   └── open.mjs             # build + launch browser
└── README.md
```

## License

MIT
