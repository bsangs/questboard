/**
 * Agent (worker / reviewer / merger) MCP integration.
 *
 * Generates per-card mcp-config JSON files for `claude --mcp-config`,
 * pointing at our standalone stdio helper (`agent-mcp-stdio-helper.mjs`).
 *
 * The helper exposes four tools that wrap existing card-lifecycle HTTP
 * endpoints. Spawn modules for worker / reviewer / merger should:
 *   1. Call `agentMcpConfigPathFor(...)` to get a config path.
 *   2. Pass `--mcp-config <path> --strict-mcp-config` to claude.
 *   3. Whitelist the role-appropriate subset via `--allowed-tools`.
 *
 * Composer is intentionally NOT wired through this — it has its own
 * gate-driven MCP server (`composer/mcp.ts`).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { env } from "../env.js";

export type AgentRole = "worker" | "reviewer" | "merger";

/** Locate the stdio helper script. See composer/mcp.ts for layout cases. */
function resolveHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // bundled prod (esbuild): main.js sits in dist/, helpers under dist/mcp/
    join(here, "mcp", "agent-mcp-stdio-helper.mjs"),
    // tsc-only prod or tsx-watch dev: helper sits next to this module
    join(here, "agent-mcp-stdio-helper.mjs"),
    // tsc dist → src fallback (legacy dev)
    join(here, "..", "..", "src", "mcp", "agent-mcp-stdio-helper.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `agent-mcp-stdio-helper.mjs not found near ${here}; build artifacts may be stale`,
  );
}

const MCP_CONFIG_DIR = join(env.BOARD_DATA, "_agent-mcp-configs");

export interface AgentMcpConfigOpts {
  role: AgentRole;
  cardId: string;
  /** PID of the parent claude process (used for /claim payloads). */
  agentPid: number;
  /** Optional worktree path — forwarded to /claim. */
  worktree?: string;
  /** Optional wip branch — forwarded to /claim and used as request_review default. */
  wipBranch?: string;
}

/**
 * Write (or refresh) an mcp-config JSON for the given role + card. The
 * config points at our stdio helper with role/card-scoped env vars
 * baked in. Returns the path to feed into `claude --mcp-config`.
 *
 * Writes are idempotent — calling repeatedly for the same card just
 * overwrites the file with current opts (latest pid, latest wip branch).
 */
export function agentMcpConfigPathFor(opts: AgentMcpConfigOpts): string {
  mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  const helper = resolveHelperPath();
  const cfg = {
    mcpServers: {
      questboard: {
        type: "stdio",
        command: process.execPath,
        args: [helper],
        env: {
          BOARD_BASE_URL: `http://127.0.0.1:${env.BOARD_SERVER_PORT}`,
          BOARD_CARD_ID: opts.cardId,
          BOARD_AGENT_PID: String(opts.agentPid),
          BOARD_AGENT_ROLE: opts.role,
          ...(opts.worktree ? { BOARD_WORKTREE: opts.worktree } : {}),
          ...(opts.wipBranch ? { BOARD_WIP_BRANCH: opts.wipBranch } : {}),
        },
      },
    },
  };
  // Per-role + per-card filename so concurrent runs of different cards
  // (or even the same card across stages) don't clobber each other.
  const path = join(MCP_CONFIG_DIR, `${opts.role}-${opts.cardId}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
  return path;
}

/**
 * The role-appropriate MCP tool names to whitelist via
 * `--allowed-tools`. Format: `mcp__<server-name>__<tool-name>`.
 *
 * Worker:    claim_card, request_review
 * Reviewer:  review_pass, review_reject
 * Merger:    (none from this set — merger drives via Bash + git only)
 *
 * Callers that want everything (loose role) can spread `ALL_AGENT_MCP_TOOLS`
 * instead.
 */
export function agentMcpAllowedToolsFor(role: AgentRole): readonly string[] {
  switch (role) {
    case "worker":
      return ["mcp__questboard__claim_card", "mcp__questboard__request_review"];
    case "reviewer":
      return ["mcp__questboard__review_pass", "mcp__questboard__review_reject"];
    case "merger":
      return [];
  }
}

export const ALL_AGENT_MCP_TOOLS: readonly string[] = [
  "mcp__questboard__claim_card",
  "mcp__questboard__request_review",
  "mcp__questboard__review_pass",
  "mcp__questboard__review_reject",
];
