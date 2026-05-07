/**
 * questboard CLI.
 *
 * Two roles share one binary:
 *
 *  - User-facing companion-app commands (e.g. `init`) for setting up a
 *    repo-local `.questboard/` runtime. These do NOT need a server URL or
 *    card id.
 *
 *  - Worker / reviewer helper commands (`claim`, `heartbeat`, ...) that
 *    mutate card state through the board server's REST API. The dispatcher
 *    sets `BOARD_SERVER_URL` and `CARD_ID` in the spawn env; both can be
 *    overridden via `--server` / `--card`.
 *
 * On HTTP / network error: prints the error to stderr and exits with code 1.
 */
import { Command } from "commander";

import { configureApi } from "./api.js";
import { cmdClaim } from "./cmd-claim.js";
import { cmdHeartbeat } from "./cmd-heartbeat.js";
import { cmdComment } from "./cmd-comment.js";
import { cmdStuck } from "./cmd-stuck.js";
import { cmdReview } from "./cmd-review.js";
import { cmdReviewPass } from "./cmd-review-pass.js";
import { cmdReviewReject } from "./cmd-review-reject.js";
import { cmdInit } from "./cmd-init.js";
import { cmdStart } from "./cmd-start.js";
import { cmdStop } from "./cmd-stop.js";
import { cmdStatus } from "./cmd-status.js";
import { cmdLogs } from "./cmd-logs.js";

const program = new Command();

/**
 * Subcommands that DON'T need server context. Anything else triggers
 * configureApi() in the preAction hook so worker / reviewer commands fail
 * fast with a clear message when env / flags are missing.
 */
const COMMANDS_WITHOUT_API = new Set([
  "init",
  "start",
  "stop",
  "status",
  "logs",
  "help",
]);

program
  .name("questboard")
  .description("questboard companion-app CLI and worker / reviewer helpers")
  .option("--server <url>", "override BOARD_SERVER_URL (worker / reviewer commands)")
  .option("--card <id>", "override CARD_ID (4-digit zero-padded)")
  .hook("preAction", (thisCommand, actionCommand) => {
    if (COMMANDS_WITHOUT_API.has(actionCommand.name())) return;
    const opts = thisCommand.opts<{ server?: string; card?: string }>();
    configureApi({
      serverUrl: opts.server,
      cardId: opts.card,
    });
  });

program
  .command("init")
  .description("Initialize repo-local .questboard/ runtime in the current Git repository")
  .option(
    "--root <path>",
    "override project root (defaults to git rev-parse --show-toplevel from cwd)",
  )
  .action(cmdInit);

program
  .command("start")
  .description("Run server, dispatcher, and UI together in the foreground")
  .option(
    "--root <path>",
    "override project root (defaults to walk-up from cwd / git root)",
  )
  .option("--no-server", "do not start the API server (split-deploy: UI on a separate host)")
  .option("--no-dispatcher", "do not start the dispatcher (pause worker spawn)")
  .option("--no-ui", "do not start the Next.js UI (headless API + dispatcher)")
  .option(
    "--detach",
    "spawn detached children, redirect logs to .questboard/run/, and return",
  )
  .action(cmdStart);

program
  .command("stop")
  .description("Stop a detached run for the current project (SIGTERM → SIGKILL after 5s)")
  .option("--root <path>", "override project root")
  .action(cmdStop);

program
  .command("status")
  .description("Show pids and liveness for the current project's detached run")
  .option("--root <path>", "override project root")
  .action(cmdStatus);

program
  .command("logs [role]")
  .description("Tail role logs (server | dispatcher | ui). Default: tail -f all roles")
  .option("--root <path>", "override project root")
  .option("--no-follow", "dump current contents and exit instead of tailing")
  .action(cmdLogs);

program
  .command("claim")
  .description("Take ownership of a ready card (POST /claim)")
  .requiredOption("--pid <n>", "worker process pid")
  .requiredOption("--attempt <n>", "attempt number (1 = first spawn)")
  .action(cmdClaim);

program
  .command("heartbeat")
  .description("Send keep-alive heartbeat (POST /heartbeat)")
  .requiredOption("--tokens <n>", "tokens used so far")
  .requiredOption("--elapsed <n>", "elapsed seconds since claim")
  .action(cmdHeartbeat);

program
  .command("comment")
  .description("Append a comment to the card (POST /comments)")
  .requiredOption("--kind <kind>", "CommentKind enum value")
  .requiredOption("--body <text|@file>", "comment body — `@path` reads from file")
  .action(cmdComment);

program
  .command("stuck")
  .description("Escalate to human (POST /stuck)")
  .requiredOption("--reason <enum>", "StuckReason enum value")
  .requiredOption(
    "--question <text|@file>",
    "human-facing question — `@path` reads from file"
  )
  .action(cmdStuck);

program
  .command("review")
  .description("Hand off to reviewer (POST /review)")
  .requiredOption("--branch <branchname>", "WIP branch (e.g. worker/card-0042)")
  .action(cmdReview);

program
  .command("review-pass")
  .description("Reviewer: approve and trigger merge (POST /reviewer-pass)")
  .action(cmdReviewPass);

program
  .command("review-reject")
  .description("Reviewer: reject and route back to in_progress (POST /reviewer-reject)")
  .requiredOption("--body <text|@file>", "rejection comment — `@path` reads from file")
  .action(cmdReviewReject);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`questboard: ${msg}\n`);
  process.exit(1);
});
