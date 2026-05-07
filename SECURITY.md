# Security Policy

## Supported usage

questboard is currently designed for local, single-user operation on a trusted developer machine. The board server has no production authentication layer in v1 and should only be bound to localhost or otherwise protected by trusted network controls.

Do not expose the server, dispatcher, UI, SQLite database, card data, transcripts, logs, or worktrees directly to the public internet.

## Sensitive data

The following are considered sensitive local runtime data and must not be committed or attached to public issues without redaction:

- `.questboard/.env` and `ui/.env.local`
- `.questboard/data/cards/`
- `.questboard/data/archive/`
- `.questboard/data/logs/`
- `.questboard/data/config.json`
- `.questboard/data/board.sqlite*`
- `.questboard/worktrees/`
- worker/reviewer/merger transcripts and post-build logs

These files can contain prompts, source diffs, proprietary code, credentials, API keys, Telegram IDs, model outputs, and local filesystem paths.

## Dependency and runtime expectations

- Use Node.js 20 or newer.
- Keep dependencies current with normal pnpm lockfile review.
- Use the default Claude Code login-session mode for local development unless you intentionally need bare mode, proxy, multi-host, or non-interactive operation.
- Prefer `questboard start --detach` for long-lived local runs. If you use PM2, keep it protected and aligned with the documented environment settings.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository maintainers or owner. Include:

1. A concise description of the issue.
2. Steps to reproduce in a local setup.
3. Impact and affected component, if known.
4. Any relevant logs with secrets and private code removed.

Please do not open public issues containing secrets, exploitable details, card transcripts, or private repository contents.

## Scope

In scope:

- Authentication/authorization assumptions that could expose local board data.
- Unsafe handling of card attachments, transcripts, logs, shell commands, or worktrees.
- Dependency vulnerabilities that affect default local operation.
- Cross-origin or file-serving behavior in the UI/server boundary.

Out of scope for this early local-first setup:

- Findings that require exposing the unauthenticated local server to the internet against the documented guidance.
- Secrets committed through ignored runtime files already called out above.
- Denial-of-service of the developer's own local machine without privilege escalation or data exposure.
