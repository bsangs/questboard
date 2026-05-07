/**
 * Composer MCP integration.
 *
 * Two responsibilities:
 *   1. Generate a per-thread mcp-config JSON for `claude --mcp-config`.
 *      The config points at a stdio MCP helper script
 *      (`mcp-stdio-helper.mjs`) which claude spawns as its MCP server.
 *      We use stdio (not HTTP) because `@modelcontextprotocol/sdk` is
 *      not in the dependency tree, and the stdio JSON-RPC protocol is
 *      tiny enough to ship as a standalone .mjs file.
 *
 *   2. Expose `/api/composer/internal/tool-call` — the HTTP endpoint
 *      the helper script calls. This handler is the seam between
 *      claude (via the helper) and gate.ts: it turns each tool_use into
 *      a ComposerPendingToolUse, broadcasts SSE, awaits the user's
 *      decision, and returns the resolved outcome.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { broadcast } from "../sse.js";
import { ComposerMessage, type ComposerPendingToolUse } from "@questboard/core";
import {
  appendMessage,
  composerPaths,
  recordPending,
} from "./threads.js";
import { awaitDecision } from "./gate.js";

// ─── Helper script discovery ─────────────────────────────────────────────────

/**
 * Locate the stdio helper script. Three layouts to handle:
 *   - bundled prod: import.meta.url = dist/main.js → dist/composer/mcp-stdio-helper.mjs
 *   - tsc-only prod (legacy): import.meta.url = dist/composer/mcp.js → ./mcp-stdio-helper.mjs
 *   - dev (tsx watch): import.meta.url = src/composer/mcp.ts → ./mcp-stdio-helper.mjs
 */
function resolveHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // bundled prod (esbuild): main.js sits in dist/, helpers under dist/composer/
    join(here, "composer", "mcp-stdio-helper.mjs"),
    // tsc-only prod or tsx-watch dev: helper sits next to this module
    join(here, "mcp-stdio-helper.mjs"),
    // tsc dist falling back to src (legacy dev)
    join(here, "..", "..", "src", "composer", "mcp-stdio-helper.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `composer mcp-stdio-helper.mjs not found near ${here}; build artifacts may be stale`,
  );
}

const MCP_CONFIG_DIR = join(composerPaths.root, "_mcp-configs");

/**
 * Write (or refresh) a per-thread mcp-config JSON pointing claude at
 * our stdio helper, with COMPOSER_THREAD_ID + COMPOSER_BASE_URL injected
 * via env. Returns the config file path; spawn.ts feeds it to claude.
 */
export function mcpConfigPathFor(threadId: string): string {
  mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  const helper = resolveHelperPath();
  const cfg = {
    mcpServers: {
      composer: {
        type: "stdio",
        command: process.execPath, // current node, robust across PATH oddities
        args: [helper],
        env: {
          COMPOSER_THREAD_ID: threadId,
          COMPOSER_BASE_URL: `http://127.0.0.1:${env.BOARD_SERVER_PORT}`,
        },
      },
    },
  };
  const path = join(MCP_CONFIG_DIR, `${threadId}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
  return path;
}

// ─── Internal HTTP route: helper → server tool-call seam ─────────────────────

const ToolCallBody = z.object({
  thread_id: z.string().min(1),
  name: z.enum(["make_card", "save_plan"]),
  // Claude validates against our advertised JSON Schema before sending, so
  // we accept the input verbatim here and let gate.ts re-validate via the
  // strict zod MakeCardInput / SavePlanInput schemas at commit time.
  input: z.unknown(),
});

export async function composerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/composer/internal/tool-call", async (req, reply) => {
    let body: z.infer<typeof ToolCallBody>;
    try {
      body = ToolCallBody.parse(req.body);
    } catch (err) {
      reply.code(400).send({ ok: false, reason: `bad request: ${(err as Error).message}` });
      return;
    }

    // Generate a stable id for this pending — claude's MCP layer doesn't
    // expose its tool_use_id over JSON-RPC, so we mint our own. The UI
    // uses this id for approve/reject; the server uses it as the gate key.
    const id = `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const pending: ComposerPendingToolUse = {
      id,
      thread_id: body.thread_id,
      name: body.name,
      input: body.input,
      created_at: new Date().toISOString(),
      status: "pending",
    };

    // Record the tool_use as a transcript message so the UI's chat view can
    // show "claude wants to make a card → preview gate". The actual gate
    // UI is driven by the SSE composer_tool_pending event below.
    const toolUseMsg = ComposerMessage.parse({
      id,
      ts: pending.created_at,
      role: "assistant",
      tool_use: { id, name: body.name, input: body.input },
    });
    try {
      appendMessage(body.thread_id, toolUseMsg);
      broadcast({ type: "composer_message_appended", thread_id: body.thread_id, message: toolUseMsg });
    } catch (err) {
      logger.warn("composer_tool_use_record_failed", { threadId: body.thread_id, err: String(err) });
    }

    recordPending(body.thread_id, pending);
    broadcast({ type: "composer_tool_pending", thread_id: body.thread_id, pending });

    // Block until the user resolves. The HTTP request stays open for as
    // long as it takes — fastify keeps the socket alive. claude's helper
    // also has no client-side timeout (we control it).
    let outcome;
    try {
      outcome = await awaitDecision(pending);
    } catch (err) {
      reply.code(500).send({ ok: false, reason: (err as Error).message });
      return;
    }

    if (outcome.ok) {
      reply.send({ ok: true, result: outcome.result, result_ref: outcome.result_ref });
    } else {
      reply.send({ ok: false, reason: outcome.reason });
    }
  });
}

/** Tool definitions advertised over MCP — exact schemas live in core/types.ts. */
export interface ComposerToolDefs {
  make_card: { name: "make_card"; description: string };
  save_plan: { name: "save_plan"; description: string };
}

/** Back-compat name kept in case anything else imports the old slot. */
export const mcpRoutes = composerMcpRoutes;
