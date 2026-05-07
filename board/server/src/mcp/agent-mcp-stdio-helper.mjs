#!/usr/bin/env node
/**
 * Agent MCP stdio helper (worker / reviewer / merger).
 *
 * Mirrors the composer's stdio helper but exposes the four card-lifecycle
 * tools instead of make_card / save_plan. These wrap existing HTTP
 * endpoints — bash-curl callsites in older agent prompts continue to work
 * unchanged.
 *
 * Tools:
 *   - claim_card({card_id, attempt?})     →  POST /api/cards/:id/claim
 *   - request_review({card_id, wip_branch}) →  POST /api/cards/:id/review
 *   - review_pass({card_id})              →  POST /api/cards/:id/reviewer-pass
 *   - review_reject({card_id, comment_body}) →  POST /api/cards/:id/reviewer-reject
 *
 * Env (set at spawn time by the role's spawn module):
 *   BOARD_AGENT_PID    — pid of the parent claude process (used for /claim)
 *   BOARD_CARD_ID      — the card this helper is scoped to
 *   BOARD_BASE_URL     — questboard-server origin (e.g. http://127.0.0.1:3031)
 *   BOARD_WORKTREE     — optional worktree path (passed to /claim if set)
 *   BOARD_WIP_BRANCH   — optional default wip branch
 *   BOARD_AGENT_ROLE   — "worker" | "reviewer" | "merger" (informational only)
 */
import process from "node:process";

const BASE_URL = process.env.BOARD_BASE_URL;
const CARD_ID = process.env.BOARD_CARD_ID;
const AGENT_PID = Number(process.env.BOARD_AGENT_PID ?? "0");
if (!BASE_URL || !CARD_ID) {
  process.stderr.write(
    "agent-mcp-stdio-helper: BOARD_BASE_URL + BOARD_CARD_ID must be set\n",
  );
  process.exit(2);
}

const TOOLS = [
  {
    name: "claim_card",
    description:
      "Claim a backlog card so the worker takes ownership. Equivalent to POST /api/cards/:id/claim. The server may have already claimed before spawn — call defensively; a duplicate claim by the same pid is a no-op.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: {
          type: "string",
          pattern: "^\\d{4}$",
          description: "4-digit card id (e.g. \"0123\"). Must match the card this agent was spawned for.",
        },
        attempt: {
          type: "integer",
          minimum: 1,
          description: "Optional attempt counter — informational, not enforced server-side.",
        },
      },
      required: ["card_id"],
    },
  },
  {
    name: "request_review",
    description:
      "Hand the card off to human/AI review. Equivalent to POST /api/cards/:id/review. Pass the wip branch the worker pushed.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", pattern: "^\\d{4}$" },
        wip_branch: {
          type: "string",
          minLength: 1,
          description: "The wip branch the worker pushed (e.g. \"worker/card-0123\").",
        },
      },
      required: ["card_id", "wip_branch"],
    },
  },
  {
    name: "review_pass",
    description:
      "Reviewer approves the wip — moves the card to merging. Equivalent to POST /api/cards/:id/reviewer-pass.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", pattern: "^\\d{4}$" },
      },
      required: ["card_id"],
    },
  },
  {
    name: "review_reject",
    description:
      "Reviewer rejects the wip with a comment — sends the card back to the worker. Equivalent to POST /api/cards/:id/reviewer-reject.",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", pattern: "^\\d{4}$" },
        comment_body: {
          type: "string",
          minLength: 1,
          description: "Reviewer comment explaining what's wrong / what needs to change.",
        },
      },
      required: ["card_id", "comment_body"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function asTextResult(id, payload, isError) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: !!isError,
    },
  });
}

async function postJson(path, body) {
  let resp;
  try {
    resp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    return { ok: false, status: 0, payload: { reason: `transport: ${String(err)}` } };
  }
  let payload;
  try {
    payload = await resp.json();
  } catch {
    payload = { reason: `non-json response (status ${resp.status})` };
  }
  return { ok: resp.ok, status: resp.status, payload };
}

function ensureCardMatches(args) {
  // Cross-card calls are almost always a model error — tighten the seam
  // by requiring the tool's card_id to match the spawn's BOARD_CARD_ID.
  if (args && typeof args.card_id === "string" && args.card_id !== CARD_ID) {
    return `card_id mismatch: tool received "${args.card_id}", helper bound to "${CARD_ID}"`;
  }
  return null;
}

async function handleToolCall(req) {
  const { name, arguments: args } = req.params ?? {};
  const mismatch = ensureCardMatches(args);
  if (mismatch) {
    return asTextResult(req.id, { ok: false, reason: mismatch }, true);
  }
  const cardId = (args && args.card_id) || CARD_ID;
  let result;
  switch (name) {
    case "claim_card": {
      // The HTTP /claim endpoint requires pid; also forward optional
      // worktree + wip_branch from spawn env so server can record them.
      result = await postJson(`/api/cards/${cardId}/claim`, {
        pid: AGENT_PID,
        worktree: process.env.BOARD_WORKTREE || undefined,
        wip_branch: process.env.BOARD_WIP_BRANCH || undefined,
      });
      break;
    }
    case "request_review": {
      result = await postJson(`/api/cards/${cardId}/review`, {
        wip_branch: args?.wip_branch,
      });
      break;
    }
    case "review_pass": {
      result = await postJson(`/api/cards/${cardId}/reviewer-pass`, {});
      break;
    }
    case "review_reject": {
      result = await postJson(`/api/cards/${cardId}/reviewer-reject`, {
        comment_body: args?.comment_body,
      });
      break;
    }
    default:
      return sendError(req.id, -32602, `unknown tool: ${name}`);
  }
  if (result.ok) {
    asTextResult(req.id, { ok: true, ...result.payload }, false);
  } else {
    asTextResult(
      req.id,
      { ok: false, status: result.status, ...result.payload },
      true,
    );
  }
}

async function dispatch(req) {
  switch (req.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "questboard-agent", version: "0.1.0" },
        },
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
      return;
    case "tools/call":
      await handleToolCall(req);
      return;
    case "ping":
      send({ jsonrpc: "2.0", id: req.id, result: {} });
      return;
    default:
      if (req.id != null) sendError(req.id, -32601, `method not found: ${req.method}`);
      return;
  }
}

// ─── stdin loop ──────────────────────────────────────────────────────────────

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      sendError(null, -32700, "parse error");
      continue;
    }
    Promise.resolve(dispatch(req)).catch((err) => {
      if (req && req.id != null) sendError(req.id, -32603, String(err));
    });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
