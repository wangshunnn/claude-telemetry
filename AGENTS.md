# AGENTS.md

## Purpose

This repository ships a Claude Code plugin that records hook events, stores them as local telemetry, and renders a self-contained offline dashboard. The core question it answers is which docs, rules, skills, and agent instructions are actually being consumed during a turn.

## Project Map

- `.claude-plugin/plugin.json`: Claude Code plugin manifest and user-facing metadata.
- `hooks/hooks.json`: hook wiring for session, prompt, tool, notification, permission, and stop events.
- `commands/open.md`: `/claude-telemetry:open` command definition.
- `scripts/append-event.mjs`: generic event collector for most hook types.
- `scripts/on-stop.mjs`: stop-event collector that also parses transcript usage and reply data.
- `scripts/config.mjs`: default knowledge-target rules plus project-level override loading.
- `scripts/metrics.mjs`: path normalization and knowledge-target classification helpers.
- `scripts/build.mjs`: aggregates `events.jsonl` into `snapshot.json` and a standalone HTML dashboard.
- `scripts/open.mjs`: builds the dashboard and opens it in the local browser.
- `test/*.test.mjs`: Vitest coverage for classification and config behavior.

## Working Agreements

- Keep the plugin local-first and offline-first. Do not add network upload or remote telemetry behavior unless explicitly requested.
- Prefer Node.js standard-library solutions and keep dependencies minimal.
- Treat event collection as best-effort: hooks should fail soft and avoid disrupting Claude Code sessions.
- Preserve event-shape compatibility when possible. If a schema change is necessary, make the dashboard tolerant of older rows in `events.jsonl`.
- Keep generated output self-contained. The dashboard should continue to work as a single HTML file plus `snapshot.json`.
- Be careful with privacy. Telemetry may contain raw prompts, absolute file paths, tool inputs, and permission commands.

## Editing Guidance

- When changing hook capture, check both the producer (`append-event.mjs` or `on-stop.mjs`) and the downstream consumer in `build.mjs`.
- When changing knowledge-target matching, update `scripts/config.mjs` and add or adjust tests in `test/config.test.mjs` or `test/metrics.test.mjs`.
- Keep user-facing labels concise because they are rendered directly in the dashboard UI.
- Avoid committing generated telemetry artifacts from instrumented projects such as `.claude/telemetry/events.jsonl`, `index.html`, or `snapshot.json`.

## Validation

- Run `pnpm test` after logic changes.
- For manual verification, set `CLAUDE_PROJECT_DIR` to a sample project and run `node scripts/build.mjs`.
- To exercise the end-to-end flow in Claude Code, install the plugin and run `/claude-telemetry:open` after a few turns.
