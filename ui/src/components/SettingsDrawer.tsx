"use client";

import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { FolderOpen, Plus, Send, Settings2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BOARD_SERVER_URL,
  getBasePrompt,
  patchConfig,
  pickFolder,
  setBasePrompt,
  testTelegram,
} from "@/lib/api";
import { useBoard } from "@/lib/state";
import type { Scope } from "@/lib/types";

// ─── Tab definitions ─────────────────────────────────────────────────────────

type TabId = "workflow" | "scopes" | "base_prompt" | "notifications" | "merger";

const TABS: { id: TabId; label: string }[] = [
  { id: "workflow", label: "Workflow" },
  { id: "scopes", label: "Scopes" },
  { id: "base_prompt", label: "Base prompt" },
  { id: "notifications", label: "Notifications" },
  { id: "merger", label: "Merger" },
];

const ACTIVE_TAB_LS_KEY = "questboard.settings.activeTab.v1";

function readSavedTab(): TabId {
  if (typeof window === "undefined") return "workflow";
  try {
    const raw = window.localStorage.getItem(ACTIVE_TAB_LS_KEY);
    if (raw && TABS.some((t) => t.id === raw)) return raw as TabId;
  } catch {
    /* ignore (private mode, etc.) */
  }
  return "workflow";
}

function persistTab(id: TabId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_TAB_LS_KEY, id);
  } catch {
    /* ignore */
  }
}

// ─── Drawer ─────────────────────────────────────────────────────────────────

export function SettingsDrawer() {
  const [open, setOpen] = useState(false);
  const config = useBoard((s) => s.config);
  const setConfig = useBoard((s) => s.setConfig);
  const pushToast = useBoard((s) => s.pushToast);
  const stats = useBoard((s) => s.stats);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>(() => readSavedTab());

  // Re-read the saved tab when the drawer is opened — covers the case
  // where the user changed it in another open instance / browser tab.
  useEffect(() => {
    if (open) setActiveTab(readSavedTab());
  }, [open]);

  const switchTab = useCallback((id: TabId) => {
    setActiveTab(id);
    persistTab(id);
  }, []);

  const update = useCallback(
    async (patch: Parameters<typeof patchConfig>[0]) => {
      setBusy(true);
      try {
        const next = await patchConfig(patch);
        setConfig(next);
      } catch (e) {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(false);
      }
    },
    [pushToast, setConfig],
  );

  // Stable error-callback so child effects don't re-fire whenever the
  // drawer re-renders (e.g. when StatsPanel polls every 30s and updates
  // the global `stats` slice). pushToast is a stable zustand selector.
  const pushError = useCallback(
    (m: string) => pushToast({ kind: "error", message: m }),
    [pushToast],
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          aria-label="Settings"
          className="rounded p-1.5 text-ink-muted hover:bg-black/5"
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-black/20 animate-fadeIn" />
        <Dialog.Content
          aria-label="Settings"
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[460px] flex-col border-l border-black/10 bg-white shadow-drawer animate-slideIn"
        >
          <header className="flex items-center justify-between border-b border-black/5 px-5 py-3">
            <Dialog.Title className="text-[14px] font-semibold">
              Settings
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="Close"
                className="rounded p-1 text-ink-subtle hover:bg-black/5"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </header>

          {/* Tab strip */}
          <nav
            role="tablist"
            aria-label="Settings sections"
            className="flex shrink-0 items-stretch gap-0 overflow-x-auto border-b border-black/5 px-2"
          >
            {TABS.map((t) => {
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={active}
                  aria-controls={`settings-panel-${t.id}`}
                  id={`settings-tab-${t.id}`}
                  onClick={() => switchTab(t.id)}
                  className={clsx(
                    "relative whitespace-nowrap px-3 py-2 text-[12.5px] font-medium transition-colors",
                    active
                      ? "text-ink"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  {t.label}
                  <span
                    className={clsx(
                      "absolute inset-x-2 -bottom-px h-0.5 rounded-t",
                      active ? "bg-ink" : "bg-transparent",
                    )}
                    aria-hidden
                  />
                </button>
              );
            })}
          </nav>

          <div className="flex-1 overflow-y-auto p-5 text-[13px]">
            {activeTab === "workflow" && (
              <TabPanel id="workflow">
                <WorkflowTab
                  config={config}
                  stats={stats}
                  busy={busy}
                  update={update}
                />
              </TabPanel>
            )}

            {activeTab === "scopes" && (
              <TabPanel id="scopes">
                <Section title="Scopes (work areas)">
                  <p className="mb-2 text-[11.5px] text-ink-subtle">
                    Define work areas. When a card has a scope, the scope's
                    description is injected into the helper system prompt.
                  </p>
                  <ScopeManager
                    scopes={config?.scopes ?? []}
                    disabled={busy || !config}
                    onChange={(scopes) => update({ scopes })}
                  />
                </Section>
              </TabPanel>
            )}

            {activeTab === "base_prompt" && (
              <TabPanel id="base_prompt">
                <Section title="Base prompt">
                  <p className="mb-2 text-[11.5px] text-ink-subtle">
                    Shown to every Worker / Reviewer / Merger spawned. Use it
                    for project description, conventions, test commands, etc.
                  </p>
                  <BasePromptEditor pushError={pushError} />
                </Section>
              </TabPanel>
            )}

            {activeTab === "notifications" && (
              <TabPanel id="notifications">
                <NotificationsTab
                  config={config}
                  busy={busy}
                  update={update}
                  pushToast={pushToast}
                  setBusy={setBusy}
                />
              </TabPanel>
            )}

            {activeTab === "merger" && (
              <TabPanel id="merger">
                <MergerTab
                  config={config}
                  busy={busy}
                  update={update}
                  pushToast={pushToast}
                />
              </TabPanel>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Tab panel wrapper ──────────────────────────────────────────────────────

function TabPanel({
  id,
  children,
}: {
  id: TabId;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`settings-panel-${id}`}
      aria-labelledby={`settings-tab-${id}`}
      className="space-y-5"
    >
      {children}
    </div>
  );
}

// ─── Workflow tab ───────────────────────────────────────────────────────────

function WorkflowTab({
  config,
  stats,
  busy,
  update,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  stats: ReturnType<typeof useBoard.getState>["stats"];
  busy: boolean;
  update: (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;
}) {
  return (
    <>
      <Section title="Auto-review default">
        <Toggle
          checked={!!config?.auto_review}
          onChange={(v) => update({ auto_review: v })}
          label="Send human_review cards to AI Review automatically"
        />
      </Section>

      <Section title="Concurrency">
        <div className="text-ink-muted">
          Active workers:{" "}
          <span className="font-mono text-ink">
            {stats?.active_workers ?? "—"}
          </span>{" "}
          /{" "}
          <span className="font-mono">
            {config?.concurrency_limit ?? "—"}
          </span>
        </div>
        <div className="mt-2">
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={config?.concurrency_limit ?? 8}
            disabled={busy || !config}
            onChange={(e) =>
              update({ concurrency_limit: Number(e.target.value) })
            }
            className="w-full"
          />
          <div className="mt-1 flex justify-between text-[10px] text-ink-subtle">
            <span>1</span>
            <span>8</span>
          </div>
        </div>
      </Section>

      <Section title="Default scope">
        <p className="mb-2 text-[11.5px] text-ink-subtle">
          Pre-selected when creating a new card.
        </p>
        <select
          value={config?.default_scope ?? ""}
          disabled={busy || !config || (config?.scopes ?? []).length === 0}
          onChange={(e) => update({ default_scope: e.target.value || null })}
          className="w-full rounded border border-black/10 px-2 py-1 text-[12.5px] disabled:opacity-50"
        >
          <option value="">(none)</option>
          {(config?.scopes ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Section>

      <Section title="Default language">
        <DefaultLanguageInput
          value={config?.default_language ?? "en"}
          disabled={busy || !config}
          onCommit={(v) => update({ default_language: v })}
        />
        <p className="mt-1 text-[11.5px] text-ink-subtle">
          ISO 639-1. Used as fallback when franc fails.
        </p>
      </Section>
    </>
  );
}

/**
 * Uncontrolled-ish input for default_language: reads server value once,
 * keeps a local draft, and only re-syncs from the server when the user
 * has not diverged (draft === lastServerValue). This prevents the
 * common bug where a poll-driven config refresh wipes out in-progress
 * typing. The same pattern can be lifted out for any other text/textarea
 * input that needs to survive periodic upstream refreshes.
 */
function DefaultLanguageInput({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const lastServerValue = useRef(value);

  useEffect(() => {
    // Only adopt the new server value if the user hasn't diverged.
    if (draft === lastServerValue.current) {
      setDraft(value);
    }
    lastServerValue.current = value;
    // Intentionally only depend on `value` — `draft` would cause re-runs
    // every keystroke and defeat the divergence check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const v = e.target.value.trim();
        if (v && v !== value) onCommit(v);
        else setDraft(value); // user blanked it — restore server truth
      }}
      disabled={disabled}
      className="w-24 rounded border border-black/10 px-2 py-1 text-[12.5px]"
    />
  );
}

// ─── Notifications tab ──────────────────────────────────────────────────────

function NotificationsTab({
  config,
  busy,
  update,
  pushToast,
  setBusy,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  busy: boolean;
  update: (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;
  pushToast: ReturnType<typeof useBoard.getState>["pushToast"];
  setBusy: (v: boolean) => void;
}) {
  return (
    <Section title="Telegram">
      <div className="text-ink-muted">
        Env:{" "}
        <span className="font-mono text-ink">
          {config?.telegram_configured ? "configured" : "not set"}
        </span>
      </div>
      <div className="mt-2">
        <Toggle
          checked={!!config?.telegram_enabled}
          onChange={(v) => update({ telegram_enabled: v })}
          label="Send Telegram alerts (stuck / review / done)"
        />
      </div>
      <button
        onClick={async () => {
          setBusy(true);
          try {
            await testTelegram();
            pushToast({
              kind: "success",
              message: "Test message sent.",
            });
          } catch (e) {
            pushToast({
              kind: "error",
              message: e instanceof Error ? e.message : String(e),
            });
          } finally {
            setBusy(false);
          }
        }}
        disabled={
          busy ||
          !config?.telegram_configured ||
          !config?.telegram_enabled
        }
        className="mt-2 inline-flex items-center gap-1.5 rounded border border-black/10 px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-black/5 disabled:opacity-50"
      >
        <Send className="h-3.5 w-3.5" /> Send test message
      </button>
      <p className="mt-2 text-[11.5px] text-ink-subtle">
        Configure <code>BOT_TOKEN</code> and <code>CHAT_ID</code> in
        <code className="mx-1">.questboard/.env</code>.
      </p>
    </Section>
  );
}

// ─── Merger tab ─────────────────────────────────────────────────────────────

function MergerTab({
  config,
  busy,
  update,
  pushToast,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  busy: boolean;
  update: (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;
  pushToast: ReturnType<typeof useBoard.getState>["pushToast"];
}) {
  return (
    <>
      <Section title="Post-build command">
        <p className="mb-2 text-[11.5px] text-ink-subtle">
          Shell command the SERVER runs after the merger reports MERGED
          (no AI). Runs as <code>bash -lc &lt;your command&gt;</code>.
          Non-zero exit blocks the transition to Done and moves the card
          to Stuck with the log tail attached. Leave blank to skip the
          step entirely.
        </p>
        <PostBuildCommandEditor
          serverValue={config?.merger_post_build_command ?? null}
          disabled={busy || !config}
          onCommit={(v) => update({ merger_post_build_command: v })}
        />
      </Section>
      <Section title="Working directory (cwd)">
        <p className="mb-2 text-[11.5px] text-ink-subtle">
          Directory the post-build command is run from. Project-relative
          path under BOARD_ROOT. Leave blank for the repo root. Useful
          when the command is package-local (e.g. <code>vercel --prod</code>{" "}
          from <code>design-system</code>).
        </p>
        <PostBuildCwdEditor
          serverValue={config?.merger_post_build_cwd ?? null}
          disabled={busy || !config}
          onCommit={(v) => update({ merger_post_build_cwd: v })}
          pushToast={pushToast}
        />
      </Section>
    </>
  );
}

/**
 * cwd input + native folder Pick button. Reuses the same
 * /api/system/folder-pick endpoint Scope rows use.
 */
function PostBuildCwdEditor({
  serverValue,
  disabled,
  onCommit,
  pushToast,
}: {
  serverValue: string | null;
  disabled: boolean;
  onCommit: (v: string | null) => Promise<void> | void;
  pushToast: ReturnType<typeof useBoard.getState>["pushToast"];
}) {
  const [draft, setDraft] = useState<string>(serverValue ?? "");
  const lastServerValue = useRef<string>(serverValue ?? "");
  const [saving, setSaving] = useState(false);

  // Divergence-guarded sync from server: only adopt the new value when
  // the user hasn't typed anything since the last sync.
  useEffect(() => {
    const next = serverValue ?? "";
    if (draft === lastServerValue.current) setDraft(next);
    lastServerValue.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverValue]);

  const dirty = draft !== (serverValue ?? "");

  const save = async () => {
    setSaving(true);
    try {
      await onCommit(draft.trim() === "" ? null : draft.trim());
      lastServerValue.current = draft;
    } finally {
      setSaving(false);
    }
  };

  const pick = async () => {
    try {
      const r = await fetch(`${BOARD_SERVER_URL}/api/system/folder-pick`);
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        pushToast({ kind: "error", message: `Pick failed: ${body || r.status}` });
        return;
      }
      // Server returns:
      //   {absolute, relative, boardRoot} on success
      //   {cancelled: true}              when user dismissed
      //   {error, message}               picker unavailable
      const data = (await r.json()) as {
        absolute?: string;
        relative?: string | null;
        cancelled?: boolean;
      };
      if (data.cancelled) return;
      if (data.relative != null) {
        setDraft(data.relative);
      } else if (data.absolute) {
        pushToast({
          kind: "error",
          message: `Picked folder is outside BOARD_ROOT: ${data.absolute}`,
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="(repo root)"
        disabled={disabled || saving}
        className="flex-1 rounded border border-black/10 px-2 py-1 font-mono text-[12px]"
      />
      <button
        type="button"
        onClick={pick}
        disabled={disabled || saving}
        className="rounded border border-black/10 px-2.5 py-1 text-[12px] hover:bg-black/5 disabled:opacity-50"
      >
        Pick…
      </button>
      <button
        type="button"
        onClick={save}
        disabled={!dirty || disabled || saving}
        className="rounded border border-black/10 bg-ink px-2.5 py-1 text-[12px] font-medium text-white hover:bg-black disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

/**
 * Editor that owns its own draft (so polling-driven config re-renders
 * don't reset it mid-typing) and only saves on explicit Save click.
 * "Reset" pulls the latest server value back into the draft.
 */
function PostBuildCommandEditor({
  serverValue,
  disabled,
  onCommit,
}: {
  serverValue: string | null;
  disabled: boolean;
  onCommit: (v: string | null) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<string>(serverValue ?? "");
  const lastServerValue = useRef<string>(serverValue ?? "");
  const [saving, setSaving] = useState(false);

  // Same divergence rule as DefaultLanguageInput: only adopt a new
  // server value when the user is "in sync" (no in-flight edits).
  useEffect(() => {
    const next = serverValue ?? "";
    if (draft === lastServerValue.current) {
      setDraft(next);
    }
    lastServerValue.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverValue]);

  const dirty = draft !== (serverValue ?? "");

  const save = async () => {
    setSaving(true);
    try {
      const trimmed = draft.trim();
      const out = trimmed === "" ? null : draft;
      await onCommit(out);
      // After a successful save, lastServerValue will be refreshed via
      // the parent's update() → setConfig path; the divergence check
      // then keeps draft in sync.
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setDraft(serverValue ?? "");
  };

  return (
    <>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        placeholder='e.g.  pnpm lint  &&  pnpm test:e2e'
        disabled={disabled || saving}
        spellCheck={false}
        className="w-full resize-y rounded border border-black/10 p-2 font-mono text-[12px] leading-snug"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={!dirty || saving || disabled}
          onClick={save}
          className="inline-flex items-center rounded border border-black/10 px-2.5 py-1 text-[12px] font-medium hover:bg-black/5 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save command"}
        </button>
        <button
          disabled={!dirty || saving}
          onClick={reset}
          className="inline-flex items-center rounded px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 disabled:opacity-50"
        >
          Reset
        </button>
      </div>
    </>
  );
}

// ─── Section wrapper ────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
        {title}
      </h3>
      {children}
    </section>
  );
}

// ─── Base prompt ────────────────────────────────────────────────────────────

/**
 * Base prompt editor. Fetches ONCE on mount; never re-fetches in response
 * to prop / state changes (the previous version had a `[pushError]`
 * dep that retriggered every parent render → the textarea got reset
 * every ~30s when the StatsPanel poll updated the global store and
 * caused a re-render in this drawer).
 *
 * To explicitly pull the server value back, use the "Reload" button.
 */
function BasePromptEditor({ pushError }: { pushError: (m: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [serverText, setServerText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Stash error callback in a ref so the load effect can call it without
  // capturing a stale reference and without including it in deps.
  const pushErrorRef = useRef(pushError);
  useEffect(() => {
    pushErrorRef.current = pushError;
  }, [pushError]);

  const load = useCallback(async (mode: "init" | "reload") => {
    try {
      const r = await getBasePrompt();
      setServerText(r.text);
      // On reload, blow away local draft. On init, only set if we don't
      // already have content (defensive against a double-mount in dev).
      if (mode === "reload" || text == null) setText(r.text);
    } catch (e) {
      pushErrorRef.current(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount-only fetch.
  useEffect(() => {
    void load("init");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (text == null) {
    return <div className="text-[12px] text-ink-subtle">Loading…</div>;
  }

  const dirty = serverText != null && text !== serverText;

  return (
    <>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        spellCheck={false}
        className="w-full resize-y rounded border border-black/10 p-2 font-mono text-[12px] leading-snug"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={!dirty || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await setBasePrompt(text);
              setServerText(text);
            } catch (e) {
              pushErrorRef.current(e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          }}
          className="inline-flex items-center rounded border border-black/10 px-2.5 py-1 text-[12px] font-medium hover:bg-black/5 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save base prompt"}
        </button>
        <button
          disabled={saving}
          onClick={() => void load("reload")}
          className="inline-flex items-center rounded px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 disabled:opacity-50"
          title="Pull the latest from the server (overwrites your local edits)"
        >
          Reload
        </button>
      </div>
    </>
  );
}

// ─── Scope manager (unchanged behavior; uncontrolled label/desc inputs) ─────

function ScopeManager({
  scopes,
  disabled,
  onChange,
}: {
  scopes: Scope[];
  disabled: boolean;
  onChange: (next: Scope[]) => void;
}) {
  const [draftId, setDraftId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const pushToast = useBoard((s) => s.pushToast);

  const updateScope = (i: number, patch: Partial<Scope>) => {
    const copy = [...scopes];
    copy[i] = { ...scopes[i], ...patch };
    onChange(copy);
  };

  return (
    <div className="space-y-2">
      {scopes.map((s, i) => (
        <ScopeRow
          key={s.id}
          scope={s}
          disabled={disabled}
          onPatch={(patch) => updateScope(i, patch)}
          onRemove={() => onChange(scopes.filter((x) => x.id !== s.id))}
          onPickError={(m) => pushToast({ kind: "error", message: m })}
        />
      ))}

      <div className="rounded border border-dashed border-black/15 p-2">
        <div className="flex gap-2">
          <input
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            placeholder="id (e.g. frontend)"
            disabled={disabled}
            className="w-32 rounded border border-black/10 px-2 py-1 font-mono text-[12px]"
          />
          <input
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            placeholder="Label"
            disabled={disabled}
            className="flex-1 rounded border border-black/10 px-2 py-1 text-[12.5px]"
          />
          <button
            onClick={() => {
              const id = draftId.trim().toLowerCase();
              const label = draftLabel.trim();
              if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !label) return;
              if (scopes.some((s) => s.id === id)) return;
              onChange([...scopes, { id, label, description: "", cwd: null }]);
              setDraftId("");
              setDraftLabel("");
            }}
            disabled={disabled || !draftId || !draftLabel}
            className="inline-flex items-center gap-1 rounded border border-black/10 px-2 py-1 text-[12px] font-medium hover:bg-black/5 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
      </div>
    </div>
  );
}

function ScopeRow({
  scope: s,
  disabled,
  onPatch,
  onRemove,
  onPickError,
}: {
  scope: Scope;
  disabled: boolean;
  onPatch: (patch: Partial<Scope>) => void;
  onRemove: () => void;
  onPickError: (m: string) => void;
}) {
  // Mirror the persisted cwd in local state so the input updates when
  // the picker writes a new value (defaultValue alone wouldn't refresh).
  const [cwdDraft, setCwdDraft] = useState<string>(s.cwd ?? "");
  const lastServerCwd = useRef<string>(s.cwd ?? "");
  const [picking, setPicking] = useState(false);

  // Only adopt a new server cwd when the user hasn't diverged. Otherwise
  // a poll-driven config refresh would wipe out an in-flight edit.
  useEffect(() => {
    const next = s.cwd ?? "";
    if (cwdDraft === lastServerCwd.current) {
      setCwdDraft(next);
    }
    lastServerCwd.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.cwd]);

  const commitCwd = (raw: string) => {
    const trimmed = raw.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next !== (s.cwd ?? null)) onPatch({ cwd: next });
  };

  const onPick = async () => {
    setPicking(true);
    try {
      const res = await pickFolder();
      if ("cancelled" in res) return;
      if (res.relative == null) {
        onPickError(
          `Folder ${res.absolute} is outside BOARD_ROOT (${res.boardRoot}). Pick something inside.`,
        );
        return;
      }
      setCwdDraft(res.relative);
      onPatch({ cwd: res.relative });
    } catch (e) {
      onPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="rounded border border-black/10 p-2">
      <div className="flex items-center gap-2">
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px]">
          {s.id}
        </span>
        <input
          defaultValue={s.label}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== s.label) onPatch({ label: v });
          }}
          disabled={disabled}
          className="flex-1 rounded border border-black/10 px-2 py-1 text-[12.5px]"
        />
        <button
          onClick={onRemove}
          disabled={disabled}
          aria-label="Remove scope"
          className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        defaultValue={s.description}
        placeholder="Guidance injected into helper system prompt for this scope…"
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== s.description) onPatch({ description: v });
        }}
        disabled={disabled}
        rows={3}
        className="mt-1.5 w-full resize-y rounded border border-black/10 p-1.5 text-[12px]"
      />
      <div className="mt-1.5">
        <label className="mb-1 block text-[10.5px] font-medium uppercase tracking-wide text-ink-subtle">
          Working directory (cwd)
        </label>
        <div className="flex gap-1.5">
          <input
            value={cwdDraft}
            onChange={(e) => setCwdDraft(e.target.value)}
            onBlur={(e) => commitCwd(e.target.value)}
            placeholder="(default: worktree / board root)"
            disabled={disabled || picking}
            className="flex-1 rounded border border-black/10 px-2 py-1 font-mono text-[11.5px]"
          />
          <button
            onClick={onPick}
            disabled={disabled || picking}
            aria-label="Pick folder"
            title="Pick folder…"
            className="inline-flex items-center gap-1 rounded border border-black/10 px-2 py-1 text-[11.5px] font-medium hover:bg-black/5 disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {picking ? "…" : "Pick…"}
          </button>
        </div>
        <p className="mt-1 text-[10.5px] text-ink-subtle">
          Project-relative path. When set, helpers cd into this subfolder of
          the worktree (worker) or board root (reviewer/merger).
        </p>
      </div>
    </div>
  );
}

// ─── Toggle ────────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded border border-black/5 bg-[var(--bg-muted)] px-3 py-2 text-left text-[12.5px] hover:bg-black/5"
      role="switch"
      aria-checked={checked}
    >
      <span>{label}</span>
      <span
        className={`relative h-4 w-7 rounded-full transition-colors ${
          checked ? "bg-emerald-600" : "bg-gray-300"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            checked ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}
