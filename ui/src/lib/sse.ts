"use client";

import { useEffect, useRef } from "react";
import { BOARD_SERVER_URL } from "./api";
import type { SseEvent } from "./types";

type Handler = (ev: SseEvent) => void;

interface UseSseOpts {
  /**
   * Called every time the SSE connection is (re)established. Use this to
   * trigger a full re-fetch so any events missed during the disconnect
   * window are caught up. Won't fire on the very first open if you don't
   * want it to — the caller is expected to do an initial fetch anyway.
   */
  onReconnect?: () => void;
}

/**
 * Subscribe to /api/events with auto-reconnect (exponential backoff up to 30s).
 * The handler ref is allowed to mutate without resubscribing.
 */
export function useSse(handler: Handler, opts: UseSseOpts = {}) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const onReconnectRef = useRef(opts.onReconnect);
  onReconnectRef.current = opts.onReconnect;

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let retryMs = 500;
    let lastEventId: string | null = null;
    let opensSeen = 0;

    const connect = () => {
      if (cancelled) return;
      // EventSource doesn't expose Last-Event-ID directly; the browser handles
      // it automatically over reconnects on the same instance. After a manual
      // close+reopen, server can backfill via timestamps in payload if needed.
      // BOARD_SERVER_URL is "" in same-origin mode; URL() needs a real
      // base, so fall back to window.location.origin in that case.
      const base =
        BOARD_SERVER_URL ||
        (typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost");
      const url = new URL("/api/events", base);
      if (lastEventId) url.searchParams.set("last", lastEventId);
      es = new EventSource(url.toString(), { withCredentials: false });

      es.onopen = () => {
        retryMs = 500;
        opensSeen += 1;
        // Skip the very first open — the page mount already does an initial
        // fetch. Every subsequent reopen means we may have missed events.
        if (opensSeen > 1) onReconnectRef.current?.();
      };

      const dispatch = (ev: MessageEvent) => {
        if (ev.lastEventId) lastEventId = ev.lastEventId;
        try {
          const data = JSON.parse(ev.data);
          // Server may wrap payload under {type, ts, payload} or send flat.
          const flat: SseEvent =
            data && typeof data === "object" && "payload" in data
              ? ({ type: data.type, ...data.payload } as SseEvent)
              : (data as SseEvent);
          handlerRef.current(flat);
        } catch (err) {
          // Malformed event — drop silently.
          if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.warn("sse: bad payload", err);
          }
        }
      };

      // Default unnamed events.
      es.onmessage = dispatch;
      // Server sends named events ("event: card_created\n..."), which the
      // browser dispatches via addEventListener — NOT onmessage. Subscribe
      // to every type the core SseEvent union knows about so we receive
      // them all.
      const NAMED_EVENTS = [
        "card_created",
        "card_updated",
        "card_status_changed",
        "card_archived",
        "card_cancel_requested",
        "comment_added",
        "history_added",
        "worker_heartbeat",
        "worker_started",
        "worker_ended",
        "config_changed",
        // Composer events — sidebar / chat / preview-gate updates.
        "composer_thread_changed",
        "composer_message_appended",
        "composer_tool_pending",
        "composer_tool_resolved",
        "composer_turn_state",
      ];
      for (const name of NAMED_EVENTS) {
        es.addEventListener(name, dispatch as EventListener);
      }

      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        const wait = retryMs;
        retryMs = Math.min(retryMs * 2, 30_000);
        setTimeout(connect, wait);
      };
    };

    connect();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);
}
