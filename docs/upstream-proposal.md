# Proposal: a CodeBuddy Code memory plugin host (hooks + MCP)

> **Posted** as <https://github.com/volcengine/OpenViking/issues/5857>.
>
> This is the draft. The version that was sent is the same text re-shaped into the
> repository's `feature_request.yml` form (its required Issue Origin / Problem
> Statement / Proposed Solution / Alternatives / Feature Area / Use Case /
> Example API / Additional Context / Contribution sections) — the substance is
> unchanged. The title carries the template's `[Feature]:` prefix. Labels could
> not be applied: setting them requires maintainer permission on that repository.
>
> Kept here so the reasoning stays next to the measured host contract.

---

I built an OpenViking memory plugin for the **CodeBuddy Code CLI** and have been
running it end to end. I'd like to contribute it as
`examples/codebuddy-memory-plugin/` — a first-class host next to the existing
ones. Before opening a PR I'd like to confirm the design boundary, since the
change touches configuration semantics and the shared library, which
CONTRIBUTING asks for up front.

## Current behaviour

- OpenViking ships memory plugins for Claude Code, Codex, Cursor / TRAE / ZCode /
  KimiCode (through `agent-hook-plugin`), OpenCode, DSH and pi. **CodeBuddy is
  covered by none of them** — the installer does not detect it and there is no
  plugin for it.
- CodeBuddy does have a plugin system (`.codebuddy-plugin/plugin.json`,
  `hooks/hooks.json`, `.mcp.json`, `skills/`), and its hook payloads and output
  envelope are close to Claude Code's — close enough that the plugin could be
  ported from `examples/claude-code-memory-plugin/` and adapted rather than
  written from scratch.
- Today a CodeBuddy user's only option is a hand-written MCP server entry in
  `~/.codebuddy/mcp.json`: MCP tools, but no capture and no recall.

## Proposed behaviour

`examples/codebuddy-memory-plugin/`, the same shape as the Claude Code plugin:

| Event | Entry | Behaviour |
| --- | --- | --- |
| `SessionStart` | `session-start.mjs` | health probe → replay the offline queue → inject the profile/catalog (and, on resume, the archive block) as one `<openviking-context>` block |
| `UserPromptSubmit` | `auto-recall.mjs` | search and inject `<openviking-context>`; skips host-generated continuations |
| `PreToolUse` | `uri-guard.mjs` | deny file-tool calls whose path is a `viking://` URI, pointing at the MCP tool |
| `Stop` | `auto-capture.mjs` | incremental transcript capture; commits once pending passes the threshold |
| `PreCompact` / `SessionEnd` | `pre-compact.mjs` / `session-end.mjs` | commit so the tail becomes an archive |
| `SubagentStart` / `SubagentStop` | `subagent-{start,stop}.mjs` | the subagent's transcript into its own OV session |

Plus the three bundled skills, the plugin's own MCP proxy, and an
`ov-memory-doctor` that reports install / config / connection / activity.
Configuration resolves from `ovcli.conf` or `OPENVIKING_*`, harness id
**`codebuddy`**.

On the harness id: the server-side ingest subsystem has an adapter called
`workbuddy` that parses this same transcript format. I deliberately did not
reuse that name — it belongs to the ingest namespace, and a `plugin.workbuddy.*`
override in `ovcli.conf` is silently ignored (verified both ways), so
`codebuddy` had to be registered as its own key.

## What it changes in shared code

1. `examples/memory-plugin-shared/lib/config-schema.mjs` — add
   `codebuddy: "codebuddy"` to `HARNESS_KEYS`.
2. `examples/memory-plugin-shared/sync.mjs` — one `TARGETS` entry and three
   `SKILL_TARGETS` entries.
3. Three shared tests enumerate harnesses and need a row:
   `mcp-hook-parity` (a row makes hooks and the MCP proxy prove they agree on
   identity across all its scenarios), `plugin-config` (a loader entry), and
   `mcp-proxy-config` (the shipped-proxy count).

**Cost I want to flag before doing it:** `check-plugin-version-bumps.sh` diffs
each registered plugin against `$dir` *and* `examples/memory-plugin-shared/lib`,
on the reasoning that a library change reaches every plugin. So this PR would
also have to bump the versions of the six existing plugins. If there is a
preferred way to land a harness addition without that, or if you would rather
take the shared-library change as its own deliberate PR, I'd rather follow your
convention than invent one.

## Host facts I measured rather than assumed

The plugin's `docs/HOST-CONTRACT.md` records the method (a throwaway probe
plugin, three run modes, plus an interactive session) and every fact, including
the ones that refuted my own earlier assumptions. The ones that shaped the
design:

- **`UserPromptSubmit`, `SessionEnd` and `SubagentStart`/`SubagentStop` fire
  only in the interactive TUI.** Headless `-p` and
  `--input-format stream-json` runs never emit them. A headless session therefore
  captures on `Stop` and never emits the final commit.
- **`PreToolUse` has no advisory channel.** An `allow`'s
  `permissionDecisionReason` does not reach the model. A **`deny`**'s reason
  does — it arrives as the failed tool result, and the model then switches to the
  MCP tool. So the URI guard denies rather than notices, and `Bash` is left out
  of its matcher (a notice there could only ever be inert).
- **A hook killed at its timeout does not take its descendants with it** — which
  is what makes the shared library's detached async write path safe on this host.
- `SessionStart` carries no `cwd` (`process.cwd()` is the session cwd), and the
  transcript is already complete when `Stop` fires.
- `SessionStart` is delivered twice per channel in some modes, so session-start
  logic has to be idempotent.
- Verified in a real interactive session: `SessionEnd` → `commit_count 2` with 7
  memories extracted; `PreCompact` → the host writes its own
  `{"type":"summary","providerData":{"source":"pre-compact"}}` record; subagent
  capture → a session of its own at `cb-<session>__subagent-<agentId>`.

34 unit/hook tests run against a mock server with no network. The three shared
test registrations above keep the existing suite green (562 tests).

## Compatibility impact

- **No behaviour change for existing plugins.** The harness key is additive, the
  sync targets are additive, and the regenerated shared copies are the normal
  generator output.
- Six existing plugin versions would move, purely to satisfy the version-bump
  check (see above).
- **Nothing touches the server, SDK, storage, or session model.** This is a
  client-side host integration over the documented session HTTP API
  (`/api/v1/sessions`, `…/messages/batch`, `…/commit`).

## Open questions

1. **Is a CodeBuddy host in scope at all?** CodeBuddy is a Tencent product. I
   understand if upstream would rather keep the adapter list where it is — a
   clear "not in scope" is a useful answer too.
2. **Shape:** a standalone `examples/codebuddy-memory-plugin/` (what I built), or
   a thin adapter under `agent-hook-plugin/hosts/`? The thin-adapter route looks
   like it would require the installer to write user-level CodeBuddy
   configuration, because CodeBuddy loads hooks from `hooks/hooks.json` *inside
   the plugin* rather than from a host config file the dispatcher could own. I'd
   rather not guess — if you want the thin shape, tell me and I'll look at
   whether it's reachable.
3. **Docs:** should there be a `docs/{en,zh}/agent-integrations/` page and an
   entry in whatever index lists hosts? I'll follow the existing template.
4. **The six bumps:** same PR, or split into a separate shared-library PR?

## Licensing

The plugin derives from `examples/` — Apache-2.0, per that directory's LICENSE
and the repository README's component list — and is currently published at
<https://github.com/caozeal/openviking-codebuddy-plugin> under Apache-2.0, with a
NOTICE recording exactly which files are unmodified copies from `examples/`,
which are ported from the Claude Code plugin and adapted, and which are new. If
the contribution is accepted, the upstream copy becomes the source of truth and
my repository becomes a mirror.
