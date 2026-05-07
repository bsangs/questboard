# Runtime system prompts

These files are the **runtime system prompts** read by the dispatcher when it
spawns workers and reviewers. Each prompt is loaded as the `--system-prompt`
(or equivalent) of a fresh ephemeral agent process for a single card.

These runtime prompts are the source of truth for role behavior. Keep changes
small and review them carefully: editing a prompt changes how future agents act.
