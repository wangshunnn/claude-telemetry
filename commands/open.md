---
description: Build the current project's claude-telemetry dashboard and try to open it in the browser. If browser launch is unavailable, return the generated file path for manual opening.
allowed-tools: Bash
---

Run:

!`output="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/open.mjs" 2>&1)"; status=$?; printf '[claude-telemetry] exit_status=%s\n' "$status"; if [ -n "$output" ]; then printf '%s\n' "$output"; fi`

Inspect the `[claude-telemetry] status=` line first when it is present. Use the `[claude-telemetry] exit_status=` line as a fallback signal if there is no explicit status line. Then reply with a concise status in plain text:

- If the dashboard opened successfully, say that it was generated and opened, and include the HTML path.
- If the dashboard was generated but the browser could not be launched, say that generation succeeded and include the manual-open path.
- If there are no events yet, say that telemetry has not been collected for this project yet and the user should try again after at least one turn.
- If the build truly failed, summarize the relevant error lines without dumping the full stack trace unless the error details are necessary.
