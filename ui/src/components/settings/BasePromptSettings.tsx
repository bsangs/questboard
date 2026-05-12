"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBasePrompt, setBasePrompt } from "@/lib/api";
import { SettingsSection as Section } from "./shared";

export function BasePromptSettings({
  pushError,
}: {
  pushError: (message: string) => void;
}) {
  return (
    <Section title="Base prompt">
      <p className="mb-2 text-[11.5px] text-ink-subtle">
        Shown to every Worker / Reviewer / Merger spawned. Use it for
        project description, conventions, test commands, etc.
      </p>
      <BasePromptEditor pushError={pushError} />
    </Section>
  );
}

function BasePromptEditor({ pushError }: { pushError: (m: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [serverText, setServerText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pushErrorRef = useRef(pushError);
  useEffect(() => {
    pushErrorRef.current = pushError;
  }, [pushError]);

  const load = useCallback(async (mode: "init" | "reload") => {
    try {
      const r = await getBasePrompt();
      setServerText(r.text);
      if (mode === "reload" || text == null) setText(r.text);
    } catch (e) {
      pushErrorRef.current(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load("init");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (text == null) {
    return <div className="text-[12px] text-ink-subtle">Loading...</div>;
  }

  const dirty = serverText != null && text !== serverText;

  return (
    <>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        spellCheck={false}
        className="w-full resize-y rounded border border-border-strong p-2 font-mono text-[12px] leading-snug"
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
          className="inline-flex items-center rounded border border-border-strong px-2.5 py-1 text-[12px] font-medium hover:bg-surface-muted disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save base prompt"}
        </button>
        <button
          disabled={saving}
          onClick={() => void load("reload")}
          className="inline-flex items-center rounded px-2 py-1 text-[12px] text-ink-muted hover:bg-surface-muted disabled:opacity-50"
          title="Pull the latest from the server (overwrites your local edits)"
        >
          Reload
        </button>
      </div>
    </>
  );
}
