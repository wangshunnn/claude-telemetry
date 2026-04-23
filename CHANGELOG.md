# Changelog

All notable changes to `claude-telemetry` will be documented in this file.

The format is based on Keep a Changelog and this project uses Semantic Versioning.

## [1.2.0] - 2026-04-23

- Moved context occupancy to the session header and removed per-reply API call counts from the dashboard reply metadata.
- Removed the hard-coded 200K context-window baseline from dashboard percentages; unknown model windows now show token scale without a percentage.
- Clarified per-reply token metadata as cumulative turn totals to distinguish it from the session-level context peak.

## [1.1.2] - 2026-04-23

- Inferred Claude transcript paths from `cwd` and `session_id` when Stop hook input omits `transcript_path`, restoring model, token, and context metadata in more Claude Code runs.
- Added a short transcript retry window in the Stop hook to tolerate transcript flush timing.
- Deduplicated repeated usage rows for split assistant messages and kept pre-tool-result assistant calls in the same user turn.
- Backfilled missing Stop token/model metadata from local transcripts while building the dashboard, so older zero-metadata events can recover on the next `/claude-telemetry:open`.

## [1.1.1] - 2026-04-23

- Restored `last_assistant_message` as a Stop hook fallback when transcript text is unavailable, while keeping transcript as the primary source for reply metadata and token usage.

## [1.1.0] - 2026-04-23

- Switched the default telemetry storage path to project-local `.claude/telemetry/` so Claude Code plugin commands can write dashboard artifacts without leaving the workspace.
- Added `CLAUDE_TELEMETRY_ROOT` as an explicit override for shared telemetry storage outside the project.
- Removed the dead `last_assistant_message` fallback in the Stop hook; the final reply is now sourced directly from the transcript.
- Labeled the dashboard reply size in `字符` instead of `字` for accuracy on mixed-language output.

## [1.0.0] - 2026-04-23

- First stable public release of `claude-telemetry`
- Added self-hosted Claude Code marketplace distribution via `.claude-plugin/marketplace.json`
- Standardized public naming on `claude-telemetry`
- Documented install, update, and release workflows for marketplace users
- Kept telemetry local-first with an offline dashboard and no remote upload path
