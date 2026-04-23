# Changelog

All notable changes to `claude-telemetry` will be documented in this file.

The format is based on Keep a Changelog and this project uses Semantic Versioning.

## [Unreleased]

- Switched the default telemetry storage path to project-local `.claude/telemetry/` so Claude Code plugin commands can write dashboard artifacts without leaving the workspace.
- Added `CLAUDE_TELEMETRY_ROOT` as an explicit override for shared telemetry storage outside the project.

## [1.0.0] - 2026-04-23

- First stable public release of `claude-telemetry`
- Added self-hosted Claude Code marketplace distribution via `.claude-plugin/marketplace.json`
- Standardized public naming on `claude-telemetry`
- Documented install, update, and release workflows for marketplace users
- Kept telemetry local-first with an offline dashboard and no remote upload path
