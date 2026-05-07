# Contributing to questboard

Thanks for helping polish questboard. This project coordinates local AI worker processes, so small operational changes can have outsized effects. Keep changes narrow, reviewable, and explicit about runtime impact.

## Ground rules

- Do not commit local runtime data from `.questboard/data/` or `.questboard/worktrees/`.
- Do not commit `.questboard/.env`, `.env`, `.env.local`, SQLite files, transcripts, logs, `node_modules/`, `dist/`, or `.next/` output.
- Preserve Omniroute as a required supported setup. Do not remove Omniroute references just because they look environment-specific.
- Keep `questboard/docs/*` role specs and `questboard/board/prompts/*` runtime prompt mirrors in sync when changing worker/reviewer/merger behavior.
- Avoid behavior changes in documentation-only pull requests.
- Keep PM2 lifecycle operations as human-run operations; document commands when helpful, but do not make agents run them.

## Development setup

From the repository root:

```sh
cd questboard
cp .env.example .env
pnpm install
```

For the default setup, run `claude login` once and leave Anthropic env vars blank. Set `ANTHROPIC_API_KEY` only when testing bare mode, proxy, multi-host, or non-interactive operation.

## Checks before submitting

Run the relevant checks from `questboard/`:

```sh
pnpm typecheck
pnpm build
```

For UI-only changes, also run the UI package checks if relevant:

```sh
pnpm --filter ./ui typecheck
pnpm --filter ./ui build
```

If a check requires local services, PM2 state, credentials, or non-public runtime data, note that clearly in the pull request instead of faking the result.

## Pull request checklist

- [ ] Change is scoped to questboard and avoids unrelated product-code behavior changes.
- [ ] No ignored runtime data, secrets, transcripts, logs, worktrees, or generated build output are included.
- [ ] Docs and runtime prompt mirrors are updated together when role behavior changes.
- [ ] Omniroute-supported setup still works and remains documented.
- [ ] Typecheck/build status is reported, including any local prerequisites that prevented running checks.
- [ ] Security-sensitive changes call out any auth, CORS, shell command, attachment, or file-serving implications.

## Documentation style

Prefer practical operational guidance over aspirational docs. When documenting a command, include where it should be run from. When documenting a safety boundary, name the concrete files or directories involved.
