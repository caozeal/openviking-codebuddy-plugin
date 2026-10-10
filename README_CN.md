# openviking-codebuddy-plugin

为 [CodeBuddy Code](https://cnb.cool/codebuddy/codebuddy-code) CLI 提供长期语义记忆，由
[OpenViking](https://github.com/volcengine/OpenViking) 驱动。

插件在每次会话开始与每轮提问时注入相关的 OpenViking 上下文，并通过生命周期 hooks 把对话写回
OpenViking；同时以 MCP 暴露 OpenViking 的工具，让模型能直接读写记忆。hooks 与 MCP 解析同一份
配置，因此对「服务器 / account / user」的理解永远一致。

本仓库**同时也是一个 CodeBuddy marketplace**，所以可以直接从 GitHub 安装。

---

## 安装

需要 Node.js 18+ 与一个可达的 OpenViking 服务端。

```bash
# 1. 把本仓库添加为 marketplace
codebuddy plugin marketplace add caozeal/openviking-codebuddy-plugin

# 2. 装到 user 作用域
codebuddy plugin install openviking-memory@openviking --scope user
```

然后告诉插件连哪个服务端 —— 要么导出 `OPENVIKING_URL` / `OPENVIKING_API_KEY`，要么写
`~/.openviking/ovcli.conf`：

```json
{ "url": "http://127.0.0.1:1933", "api_key": "<你的 key>" }
```

之后新开的会话就有记忆了。想不安装先试：

```bash
codebuddy --plugin-dir /path/to/this/repo/codebuddy-memory-plugin
```

卸载：`codebuddy plugin uninstall openviking-memory@openviking`。

> ⚠️ **装上这个插件＝你的对话会被发往你配置的 OpenViking 服务器。** 这正是它的用途，但值得
> 明说。用 `OPENVIKING_MEMORY_ENABLED=0`、`OPENVIKING_BYPASS_SESSION` 与
> `OPENVIKING_BYPASS_SESSION_PATTERNS` 可把特定会话排除在外。

完整的配置说明、逐 hook 的行为表与实测的 host 契约见
[`codebuddy-memory-plugin/README_CN.md`](codebuddy-memory-plugin/README_CN.md) 与
[`docs/HOST-CONTRACT.md`](codebuddy-memory-plugin/docs/HOST-CONTRACT.md)。

## 目录结构

```
.codebuddy-plugin/marketplace.json   本仓库作为 marketplace（source: ./codebuddy-memory-plugin）
codebuddy-memory-plugin/             插件本体 —— 自包含：hooks + MCP + skills
memory-plugin-shared/testing/        唯一 vendor 的测试助手，让 `npm test` 无需上游检出
LICENSE                              Apache-2.0（另见 NOTICE）
```

`codebuddy-memory-plugin/scripts/shared/` 与 `codebuddy-memory-plugin/skills/` 是**生成物**
（由 OpenViking 的 `examples/memory-plugin-shared/sync.mjs` 产出）—— **不要手改**；要更新就改上游
共享库后重跑那个生成器。

## 测试与诊断

```bash
cd codebuddy-memory-plugin
npm test                              # 34 个单测/hook 测试，mock 服务器，不联网
node scripts/ov-memory-doctor.mjs     # 安装 + 配置 + 连接 + 活动 报告
```

## 状态

针对 CodeBuddy Code **v2.163.0** 构建与实测（也在 v2.164.0 上跑过）。host 契约是**用一次性探针
插件在真实会话里实测**得出的（交互 TUI、`-p`、`--input-format stream-json` 三种），不是照文档抄的。

已知限制见
[`codebuddy-memory-plugin/README_CN.md`](codebuddy-memory-plugin/README_CN.md#已知限制)。一句话版本：
recall 与收尾 commit **只在交互 TUI 跑**（headless 完全不发 `UserPromptSubmit` / `SessionEnd`，这是
宿主性质）；URI 守卫**只能拦不能劝**，因为本宿主的 `PreToolUse` 没有「劝告」通道。

## 许可与署名

Apache-2.0 —— 见 [LICENSE](LICENSE)。

这是从 OpenViking 的 `examples/` 目录派生出来的社区集成。[`NOTICE`](NOTICE) 逐文件写明了：哪些
是未改动的副本、哪些是从其 Claude Code 插件移植并改造的、哪些是为本项目新写的。与 OpenViking
项目及腾讯均无隶属、赞助或背书关系。
