# 开发说明

[English](./DEVELOPMENT.md)

这份文档用于本地接入、开发、验证和发布流程。面向用户的安装与使用说明放在 [README.zh-CN.md](./README.zh-CN.md)。

## 本地接入

可以直接从本地 checkout 加载插件：

```bash
claude --plugin-dir ~/mycode/github/claude-telemetry
```

或者写到 `.claude/settings.local.json`：

```json
{
  "plugins": {
    "claude-telemetry": "/absolute/path/to/claude-telemetry"
  }
}
```

## 验证

逻辑改动后运行测试：

```bash
pnpm test
```

手动验证时，可以把遥测指向一个示例项目并构建仪表盘：

```bash
CLAUDE_PROJECT_DIR=/absolute/path/to/sample-project node scripts/build.mjs
```

如果要验证 Claude Code 里的完整接入流程，安装插件后正常使用几轮，再执行：

```bash
/claude-telemetry:open
```

## 发布

marketplace 版本号维护在 `.claude-plugin/marketplace.json`。

每次发布时：

1. 更新 `.claude-plugin/marketplace.json`。
2. 更新 [CHANGELOG.md](./CHANGELOG.md)。
3. 运行 `claude plugin validate .` 和 `pnpm test` 做校验。
4. 将发布提交推送到 GitHub。

用户更新方式见 [README.zh-CN.md](./README.zh-CN.md)。
