#!/usr/bin/env node
/**
 * Composer MCP stdio helper.
 *
 * Standalone .mjs script (no build step, no dependencies beyond core
 * Node) that claude spawns as its MCP server via --mcp-config. We chose
 * stdio over HTTP because:
 *   - The MCP HTTP transport (streamable HTTP + Mcp-Session-Id) is a
 *     non-trivial spec to implement by hand and we don't have
 *     @modelcontextprotocol/sdk installed.
 *   - stdio JSON-RPC is dead simple and universally supported by claude
 *     out of the box.
 *
 * This script is the seam between two protocols:
 *   - claude  ←(stdio JSON-RPC)→  this script
 *   - this script  ←(HTTP)→  questboard-server (gate.ts via routes.ts)
 *
 * Tool definitions are advertised statically (initialize / tools/list).
 * Tool calls (`tools/call`) translate to a single blocking POST to
 * /api/composer/internal/tool-call?thread_id=<tid>, which parks on the
 * server's gate until the user approves/rejects in the UI.
 *
 * Env this script expects:
 *   COMPOSER_THREAD_ID  — the thread we serve
 *   COMPOSER_BASE_URL   — questboard-server origin (e.g. http://127.0.0.1:3031)
 */
import process from "node:process";

const THREAD_ID = process.env.COMPOSER_THREAD_ID;
const BASE_URL = process.env.COMPOSER_BASE_URL;
if (!THREAD_ID || !BASE_URL) {
  process.stderr.write(
    "composer-mcp-stdio-helper: COMPOSER_THREAD_ID + COMPOSER_BASE_URL must be set\n",
  );
  process.exit(2);
}

// Tool schemas hand-rolled from MakeCardInput / SavePlanInput in core/types.ts.
// These MUST stay in sync with that source of truth — drift produces
// confusing AI behavior since claude validates against THIS schema before
// calling. zod-to-json-schema is not installed; the schemas are small enough
// to maintain by hand.
const TOOLS = [
  {
    name: "make_card",
    description:
      "Propose a single backlog card for the user's review. The user must approve via the UI before the card is actually created. For multi-card plans, call once per card sequentially and use the returned card id (#0, #1, ...) in subsequent `deps`.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", default: "" },
        priority: { type: "integer", enum: [1, 2, 3], default: 2 },
        flavor: {
          type: "string",
          enum: ["feature", "bug", "refactor", "chore", "docs"],
          default: "feature",
        },
        scope: { type: ["string", "null"], default: null },
        language: { type: "string", minLength: 2, maxLength: 3 },
        deps: {
          type: "array",
          items: { type: "string", pattern: "^(?:\\d{4}|#\\d+)$" },
          default: [],
          description:
            "Either an existing card id (e.g. '0091') or a back-reference to a card created earlier in THIS make_card batch by zero-based index (e.g. '#0', '#1'). The server resolves '#N' refs in commit order.",
        },
        estimated_loc: { type: ["integer", "null"] },
        budget_minutes: { type: ["integer", "null"] },
      },
      required: ["title"],
    },
  },
  {
    name: "save_plan",
    description:
      "Propose saving the current discussion as a plan document under docs/plan/. The user must approve via the UI. Use sections '## Goal', '## Approach', '## Open questions'.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          pattern: "^[a-z0-9][a-z0-9-]*$",
          description: "Becomes filename slug. Lowercase ascii / dashes only.",
        },
        title: { type: "string", minLength: 1, maxLength: 200 },
        body: { type: "string", minLength: 1 },
        scope: { type: ["string", "null"], default: null },
      },
      required: ["slug", "title", "body"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleToolCall(req) {
  const { name, arguments: args } = req.params ?? {};
  if (name !== "make_card" && name !== "save_plan") {
    return sendError(req.id, -32602, `unknown tool: ${name}`);
  }
  // POST blocks on the server until the user resolves the gate. We rely on
  // fetch's lack of default timeout — the gate can wait hours.
  let resp;
  try {
    resp = await fetch(`${BASE_URL}/api/composer/internal/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thread_id: THREAD_ID, name, input: args }),
    });
  } catch (err) {
    return sendError(req.id, -32603, `tool transport failed: ${String(err)}`);
  }
  let payload;
  try {
    payload = await resp.json();
  } catch (err) {
    return sendError(req.id, -32603, `tool response parse failed: ${String(err)}`);
  }
  // The server returns:
  //   { ok: true, result: <object>, result_ref?: string }
  //   { ok: false, reason: string }
  // Wrap as MCP tool result: a content array of text blocks. We convey
  // is_error via the MCP-standard `isError` flag (claude treats it as a
  // tool_error so the AI can react / retry).
  if (payload && payload.ok === true) {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload.result ?? { ok: true }),
          },
        ],
        isError: false,
      },
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: req.id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ approved: false, reason: payload?.reason ?? "rejected" }),
        },
      ],
      isError: true,
    },
  });
}

async function dispatch(req) {
  switch (req.method) {
    case "initialize":
      // Advertise minimal capabilities — tools only. We don't expose
      // resources, prompts, or sampling. protocolVersion follows the
      // MCP 2024-11-05 baseline that claude code supports.
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "questboard-composer", version: "0.1.0" },
        },
      });
      return;
    case "notifications/initialized":
      // Spec note: this is a notification (no id, no response).
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
      // Unknown method — return method-not-found per JSON-RPC, unless it's a
      // notification (no id) where we silently ignore.
      if (req.id != null) sendError(req.id, -32601, `method not found: ${req.method}`);
      return;
  }
}

// ─── stdin loop ──────────────────────────────────────────────────────────────

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  // Newline-delimited JSON-RPC frames.
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      // Malformed line — JSON-RPC says respond with parse error and id=null.
      sendError(null, -32700, "parse error");
      continue;
    }
    // Don't await — handlers fire-and-forget so multiple in-flight tool
    // calls can wait on the gate independently. Errors during async work
    // are surfaced as JSON-RPC error responses inside the handler.
    Promise.resolve(dispatch(req)).catch((err) => {
      if (req && req.id != null) sendError(req.id, -32603, String(err));
    });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
