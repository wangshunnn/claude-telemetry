# claude-telemetry

[简体中文](./README.zh-CN.md)

Offline telemetry and a self-contained dashboard for Claude Code and Codex. It helps you see which docs, rules, skills, and agent instructions are actually used in each turn.

## Contents

- [Claude Code](#claude-code-plugin)
- [Codex](#codex-platform)

## Claude Code Plugin

```bash
/plugin market add wangshunnn/claude-telemetry
/plugin install claude-telemetry
/reload-plugins
```

After installation, telemetry starts collecting from new turns. Use Claude in your project for a few turns, then open the dashboard:

```bash
/claude-telemetry:open
```

This builds the current project's offline dashboard and opens it in your browser.

You can add `.claude/telemetry/` to the instrumented project's `.gitignore`.

<details>
<summary>If installation hits a same-name plugin conflict</summary>

Use the explicit source:

```bash
/plugin install claude-telemetry@claude-telemetry
```

</details>

### Update

Update the Claude Code plugin:

```bash
/plugin market update claude-telemetry
/plugin update claude-telemetry
/reload-plugins
```

### Screenshot

<img src="./screenshot/claude-telemetry-preview-1.jpeg" alt="claude-telemetry dashboard" width="800" />
<img src="./screenshot/claude-telemetry-preview-2.jpeg" alt="claude-telemetry dashboard" width="800" />

## Codex

Use the npm package when you want project-local Codex hooks and a dashboard for Codex turns.

```bash
npm i -g @wangshunnn/claude-telemetry
cd /path/to/your/project
claude-telemetry install codex
```

Then use Codex in that trusted project for a few turns and open the Codex dashboard:

```bash
claude-telemetry open codex
```

Codex project hooks need both of these Codex-side prerequisites:

- The project is trusted in Codex.
- `features.codex_hooks = true` is enabled in your Codex config.

For example, in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Useful Codex commands:

```bash
claude-telemetry open           # interactively choose Codex or Claude when both have data
claude-telemetry open codex     # open Codex telemetry
claude-telemetry doctor codex   # check hook setup, trust, config, PATH, and data
claude-telemetry uninstall codex
```

Codex telemetry is stored separately under `.codex/telemetry/`. Add it to the instrumented project's `.gitignore`:

```bash
.codex/telemetry/
```

### Screenshot

<img src="./screenshot/claude-telemetry-preview-codex-1.jpeg" alt="claude-telemetry dashboard" width="800" />
<img src="./screenshot/claude-telemetry-preview-codex-2.jpeg" alt="claude-telemetry dashboard" width="800" />

## What You Get

- Per-turn knowledge hit rate for docs, rules, skills, and instruction files
- Tool usage, permission requests, idle prompts, token usage, and context size
- Project-local storage under `.claude/telemetry/` for Claude Code and `.codex/telemetry/` for Codex
- Self-contained `index.html` and `snapshot.json`

## Notes

- Telemetry can include raw prompts, absolute file paths, and permission command inputs.
- Output stays inside the current project by default, which keeps Claude Code plugin commands within the workspace write boundary.
- Set `CLAUDE_TELEMETRY_ROOT` only if you explicitly want a shared telemetry directory outside the project.
- The npm package ships the `claude-telemetry` CLI plus the Claude Code plugin files used by the marketplace install path.
- Release notes live in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT — [LICENSE](./LICENSE)
