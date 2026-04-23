# Development

[简体中文](./DEVELOPMENT.zh-CN.md)

This document is for local integration, development, validation, and release workflow. End-user installation and usage live in [README.md](./README.md).

## Local Integration

Load the plugin directly from a local checkout:

```bash
claude --plugin-dir ~/mycode/github/claude-telemetry
```

Or add it in `.claude/settings.local.json`:

```json
{
  "plugins": {
    "claude-telemetry": "/absolute/path/to/claude-telemetry"
  }
}
```

## Validate

Run tests after logic changes:

```bash
pnpm test
```

For manual verification, point Claude telemetry at a sample project and build the dashboard:

```bash
CLAUDE_PROJECT_DIR=/absolute/path/to/sample-project node scripts/build.mjs
```

To verify the end-to-end plugin flow in Claude Code, install the plugin, use Claude for a few turns, then run:

```bash
/claude-telemetry:open
```

## Release

The marketplace version is managed in `.claude-plugin/marketplace.json`.

For each release:

1. Update `.claude-plugin/marketplace.json`.
2. Update [CHANGELOG.md](./CHANGELOG.md).
3. Validate with `claude plugin validate .` and `pnpm test`.
4. Push the release commit to GitHub.

Users then update with the commands in [README.md](./README.md).
