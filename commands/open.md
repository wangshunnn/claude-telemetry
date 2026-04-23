---
description: Build the current project's claude-telemetry dashboard, then open it in the browser.
allowed-tools: Bash
---

The command below builds the dashboard and prints either a `file://` URL (on stdout) or a no-data / failure message. Do NOT run `node` yourself — the inline command is the single source of truth.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/build.mjs"`

Rules for your reply:

1. **Primary contract: always surface the output above to the user.** If it is a `file://...` URL, that URL is the answer — include it verbatim in your reply. If it is a no-data / failure message, reply with that message as-is (keep both the Chinese and English lines — do not drop either).
2. **Opening the browser is best-effort.** If (and only if) you got a `file://...` URL, you MAY run `open "<url>"` once to launch the browser. This call may fail with `procNotFound` / exit code 1 under Claude Code's Bash sandbox, or the user may decline the permission prompt — either way, **do not retry, do not treat it as an error, and do not omit the URL from your reply**. The user can click the URL themselves.
3. Do not invoke any other build scripts. Do not call `node` again.
