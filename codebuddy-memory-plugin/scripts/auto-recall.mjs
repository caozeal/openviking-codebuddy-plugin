#!/usr/bin/env node

/**
 * Auto-Recall Hook Script for CodeBuddy (UserPromptSubmit).
 *
 * Searches OpenViking for relevant context and injects an
 * <openviking-context> block. Retrieval, ranking and the token budget are the
 * shared recall core's; this hook owns the CodeBuddy envelope and the state
 * snapshot it leaves behind.
 *
 * Host notes that shape this hook (docs/HOST-CONTRACT.md):
 *   §3  `UserPromptSubmit` fires **only in the interactive TUI** — headless
 *       `-p` and `--input-format stream-json` runs never emit it. Recall is
 *       therefore untestable headlessly and must be exercised in a real session.
 *   §4  the payload carries `prompt`, `cwd` and `is_internal_continuation`.
 *       That last one is **not in the host docs** and is host-driven: those
 *       turns are continuations the host generated, not user asks, so they must
 *       not trigger a search.
 */

import { isPluginEnabled, loadConfig } from "./config.mjs";
import { createLogger } from "./debug-log.mjs";
import { deriveOvSessionId, makeFetchJSON } from "./lib/ov-session.mjs";
import { writeJsonState } from "./lib/state.mjs";
import { createHostCompressor } from "./lib/host-compressor.mjs";
import { getEffectivePeerId } from "./lib/workspace-peer.mjs";
import { runHookStage } from "./shared/agent-hook-runtime.mjs";
import { buildRecallBlockDetailed } from "./shared/recall-core.mjs";
import { applyInputFilters, compileInputFilters } from "./shared/input-filters.mjs";

if (!isPluginEnabled()) {
  process.stdout.write(JSON.stringify({ decision: "approve" }) + "\n");
  process.exit(0);
}

const baseCfg = loadConfig();
const { log, logError } = createLogger("auto-recall");
const fetchJSON = makeFetchJSON(baseCfg);

function output(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function approve(msg) {
  const out = { decision: "approve" };
  if (msg) out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: msg };
  output(out);
}

const URI_RE = /viking:\/\/[^\s<>"')\]]+/g;

async function recall(cfg, query, peer, sessionId) {
  const runCompressor = await createHostCompressor(cfg, log);
  return buildRecallBlockDetailed(fetchJSON, cfg, query, {
    actorPeerId: peer.peerId,
    legacyPeerId: peer.legacyPeerId,
    sessionId,
    log,
    runCompressor,
    localCompressorAvailable: Boolean(runCompressor),
    excludeUris: cfg.recallExcludeUris,
  });
}

// ---------------------------------------------------------------------------
// Experience hydration
// ---------------------------------------------------------------------------
//
// The server's context face renders an Experience as a self-closing
// `<memory ... type="experiences" ... detail="uri" />`: Experience files carry
// no `abstract` scalar — their body lives in the Situation/Approach/Reflect
// sections — so the assembler has nothing to serve at the abstract tier and
// degrades the entry to a bare URI. The server ignores `detail` overrides for
// this category, so a URI-only Experience reaches the model with no content at
// all: it would have to issue its own read, which in practice never happens
// (measured 2026-10-10: 0 read records across 7 experiences, while the same
// entries ranked first by score). Read the body here and inline it.
const EXPERIENCE_TAG_RE = /<memory\b[^>]*\btype="experiences"[^>]*\/>/g;
const HYDRATE_MAX_ENTRIES = 3;
const HYDRATE_MAX_CHARS = 800;
const HYDRATE_TOTAL_CHARS = 1200;

/** Body for one Experience URI, or "" when the read fails or is unavailable. */
async function readExperienceBody(uri, actorPeerId) {
  try {
    const res = await fetchJSON(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
      {},
      { actorPeerId },
    );
    return res.ok && typeof res.result === "string" ? res.result.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Inline the body of URI-only Experience entries in a server-assembled block.
 *
 * Only self-closing Experience tags are touched; entries the server already
 * served with an overview/abstract/full body are left alone. Each body is
 * capped and the total inlined text is capped, so a large Experience cannot
 * blow past the recall budget the server just spent. Any failure returns the
 * original block unchanged — recall must never degrade into an error.
 */
async function hydrateUriOnlyExperiences(block, cfg, actorPeerId) {
  if (!block || process.env.OPENVIKING_RECALL_HYDRATE_EXPERIENCES === "0") return block;

  const targets = (block.match(EXPERIENCE_TAG_RE) || [])
    .filter((tag) => !/\bdetail="(abstract|overview|full)"/.test(tag))
    .slice(0, HYDRATE_MAX_ENTRIES);
  if (!targets.length) return block;

  const perEntry = Math.min(Math.max(200, Number(cfg.recallMaxContentChars || 500)), HYDRATE_MAX_CHARS);
  const bodies = await Promise.all(targets.map((tag) => {
    const uri = tag.match(/\buri="([^"]*)"/)?.[1];
    return uri ? readExperienceBody(uri, actorPeerId) : Promise.resolve("");
  }));

  let out = block;
  let inlined = 0;
  let hydrated = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const room = HYDRATE_TOTAL_CHARS - inlined;
    if (room <= 0) break;
    let body = bodies[i];
    if (!body) continue;
    const cap = Math.min(perEntry, room);
    if (body.length > cap) body = `${body.slice(0, cap)}...`;
    const open = targets[i].replace(/\s*\/>\s*$/, ">").replace(/\bdetail="uri"/, 'detail="full"');
    out = out.replace(targets[i], `${open}\n${body}\n</memory>`);
    inlined += body.length;
    hydrated += 1;
  }

  if (hydrated) log("recall_experience_hydrated", { uriOnly: targets.length, hydrated, chars: inlined });
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const t0 = Date.now();
// Snapshot state for later inspection (and for the memory skill). Always
// written, even on early-exit branches, so it reflects the latest turn rather
// than stale data from the previous run.
function writeRecallState(extra) {
  writeJsonState("last-recall.json", {
    server_url: baseCfg.baseUrl,
    latency_ms: Date.now() - t0,
    ...extra,
  });
}

runHookStage({
  loadConfig,
  gates: { enabled: (cfg) => cfg.autoRecall },
  envelope: approve,
  onSkip: (reason, { cfg, sessionId }) => {
    log("skip", { reason });
    if (cfg.enabled !== false) writeRecallState({ count: 0, reason, cb_session_id: sessionId });
  },
}, async ({ cfg, input, cwd, sessionId }) => {
  // Host-generated continuations are not user asks — never search for them.
  if (input.is_internal_continuation === true) {
    log("skip", { reason: "internal_continuation" });
    writeRecallState({ count: 0, reason: "internal_continuation", cb_session_id: sessionId });
    return;
  }

  let userPrompt = (input.prompt || "").trim();
  const effectivePeer = getEffectivePeerId(cfg, { sessionId, cwd });
  log("start", {
    query: userPrompt.slice(0, 200),
    queryLength: userPrompt.length,
    config: {
      recallLimit: cfg.recallLimit,
      scoreThreshold: cfg.scoreThreshold,
      recallMaxContentChars: cfg.recallMaxContentChars,
      recallTokenBudget: cfg.recallTokenBudget,
      peerSource: effectivePeer.source,
      recallPeerScope: cfg.recallPeerScope,
    },
  });

  // Filters run before the length gate, so a prompt whose only content was a
  // stripped prefix is short_query rather than a search for the empty string.
  const queryFilters = compileInputFilters(cfg.recallQueryFilters);
  if (queryFilters.rules.length) {
    const verdict = applyInputFilters(userPrompt, queryFilters.rules, { role: "user" });
    if (verdict.dropped) {
      log("skip", { reason: "query_filter", rule: verdict.ruleIndex, op: verdict.op });
      writeRecallState({ count: 0, reason: "query_filtered", cb_session_id: sessionId });
      return;
    }
    if (verdict.changed) log("query_filter", { rawLength: userPrompt.length, length: verdict.text.length });
    userPrompt = verdict.text;
  }
  if (queryFilters.errors.length) log("query_filter_errors", queryFilters.errors);
  if (!userPrompt || userPrompt.length < cfg.minQueryLength) {
    log("skip", { reason: "query too short or empty" });
    writeRecallState({ count: 0, reason: "short_query", cb_session_id: sessionId });
    return;
  }

  const health = await fetchJSON("/health");
  if (!health.ok) {
    logError("health_check", "server unreachable");
    writeRecallState({ count: 0, reason: "offline", cb_session_id: sessionId });
    return;
  }

  // The OV session id is what unlocks server-side query expansion and the
  // cross-turn dedup ledger; it must match the id auto-capture writes to.
  const ovSessionId = sessionId && sessionId !== "unknown" ? deriveOvSessionId(sessionId) : "";
  const recalled = await recall(cfg, userPrompt, effectivePeer, ovSessionId);
  if (!recalled.block) {
    log("skip", { reason: recalled.stage });
    writeRecallState({ count: 0, reason: recalled.stage, cb_session_id: sessionId });
    return;
  }

  const block = await hydrateUriOnlyExperiences(recalled.block, cfg, effectivePeer.peerId);

  writeRecallState({
    // A server-assembled block is one rendered unit whatever it holds, so the
    // count comes from the URIs it cites.
    count: recalled.stage === "server_assembled"
      ? new Set(recalled.block.match(URI_RE) || []).size
      : recalled.contentCount + recalled.hintCount,
    content_items: recalled.contentCount,
    hint_items: recalled.hintCount,
    tokens_used: recalled.budgetUsed,
    tokens_budget: cfg.recallTokenBudget,
    cb_session_id: sessionId,
    reason: "ok",
  });
  return block;
}).catch((err) => { logError("uncaught", err); approve(); });
