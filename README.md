# openviking-codebuddy-plugin

Long-term semantic memory for the [CodeBuddy Code](https://cnb.cool/codebuddy/codebuddy-code)
CLI, powered by [OpenViking](https://github.com/volcengine/OpenViking).

The plugin injects relevant OpenViking context into each session and prompt, and
captures the conversation back into OpenViking through lifecycle hooks. It also
exposes the OpenViking tools over MCP, so the model can read and write memories
directly. Hooks and MCP resolve the same configuration, so they can never
disagree about which server, account or user they are talking to.

This repository is also a CodeBuddy **marketplace**, so it can be installed
straight from GitHub.

---

## Install

Requires Node.js 18+ and a reachable OpenViking server.

```bash
# 1. add this repository as a marketplace
codebuddy plugin marketplace add caozeal/openviking-codebuddy-plugin

# 2. install the plugin into the user scope
codebuddy plugin install openviking-memory@openviking --scope user
```

Then point the plugin at your server — either export `OPENVIKING_URL` and
`OPENVIKING_API_KEY`, or write `~/.openviking/ovcli.conf`:

```json
{ "url": "http://127.0.0.1:1933", "api_key": "<your key>" }
```

A session started after that has memory. To try it without installing anything:

```bash
codebuddy --plugin-dir /path/to/this/repo/codebuddy-memory-plugin
```

Uninstall with `codebuddy plugin uninstall openviking-memory@openviking`.

> ⚠️ **Installing this plugin sends your conversations to the OpenViking server
> you configure.** That is what it is for, but it is worth stating plainly.
> `OPENVIKING_MEMORY_ENABLED=0`, `OPENVIKING_BYPASS_SESSION` and
> `OPENVIKING_BYPASS_SESSION_PATTERNS` keep sessions out.

Full configuration, the hook-by-hook behaviour table and the measured host
contract live in
[`codebuddy-memory-plugin/README.md`](codebuddy-memory-plugin/README.md) and
[`docs/HOST-CONTRACT.md`](codebuddy-memory-plugin/docs/HOST-CONTRACT.md).

## Layout

```
.codebuddy-plugin/marketplace.json   this repo as a marketplace (source: ./codebuddy-memory-plugin)
codebuddy-memory-plugin/             the plugin itself — self-contained, hooks + MCP + skills
memory-plugin-shared/testing/        one vendored test helper, so `npm test` needs no checkout
LICENSE                              Apache-2.0 (see also NOTICE)
```

`codebuddy-memory-plugin/scripts/shared/` and `codebuddy-memory-plugin/skills/`
are **generated** by OpenViking's `examples/memory-plugin-shared/sync.mjs` — do
not edit them by hand; change the shared library upstream and regenerate.

## Tests and diagnostics

```bash
cd codebuddy-memory-plugin
npm test                              # 34 unit/hook tests, mock server, no network
node scripts/ov-memory-doctor.mjs     # install + config + connection + activity report
```

## Status

Built and measured against CodeBuddy Code **v2.163.0** (also exercised on
v2.164.0). The host contract was established by running a throwaway probe plugin
against real sessions — interactive TUI, `-p`, and `--input-format stream-json`
— not by reading the docs alone.

Known limitations are listed in
[`codebuddy-memory-plugin/README.md`](codebuddy-memory-plugin/README.md#known-limitations).
The short version: recall and the final commit only run in the interactive TUI
(headless runs never emit `UserPromptSubmit` or `SessionEnd`, a host property),
and the URI guard can only block, not advise, because `PreToolUse` has no
advisory channel on this host.

## License and attribution

Apache-2.0 — see [LICENSE](LICENSE).

This is a community integration derived from OpenViking's `examples/`
directory. [`NOTICE`](NOTICE) lists exactly which files are copies, which were
ported and adapted, and which were written for this project. Not affiliated
with, sponsored by, or endorsed by the OpenViking project or Tencent.
