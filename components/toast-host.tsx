"use client";

import { clsx } from "clsx";
import { AlertTriangle, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * plan/18 §5.4 — transient in-app messages. Deliberately not a notification centre: no history, no
 * unread count, at most `MAX_TOASTS` on screen, gone when dismissed or timed out (plan/02 §12's
 * "a second inbox" anti-feature). Never rendered into the floating widget.
 *
 * `broadcast` exists because the tab that does the work is often not the tab being looked at — the
 * focus timer's session is logged by whichever tab reached zero first (`claimRun`), frequently a
 * background one. A broadcast toast shows in every open tab; its action, if any, runs back in the
 * tab that raised it (which holds the closure), and dismissing it anywhere dismisses it everywhere.
 */

type Tone = "info" | "error";

export interface ToastInput {
  message: string;
  tone?: Tone;
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss after this long. 0 = stays until dismissed. Default 6 s, or sticky for errors with an action. */
  ms?: number;
  broadcast?: boolean;
}

interface ToastItem {
  id: string;
  message: string;
  tone: Tone;
  actionLabel?: string;
  ms: number;
}

type ChannelMessage =
  | { type: "show"; toast: ToastItem }
  | { type: "act"; id: string }
  | { type: "dismiss"; id: string };

const MAX_TOASTS = 3;
const DEFAULT_MS = 6000;
const CHANNEL_NAME = "focusos-toast";

const ToastContext = createContext<((input: ToastInput) => void) | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Actions live only in the raising tab: a closure can't cross a BroadcastChannel.
  const actionsRef = useRef(new Map<string, () => void>());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const timersRef = useRef(new Map<string, number>());

  const removeLocal = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  const showLocal = useCallback(
    (toast: ToastItem) => {
      setToasts((current) => [...current.filter((item) => item.id !== toast.id), toast].slice(-MAX_TOASTS));
      if (toast.ms > 0) timersRef.current.set(toast.id, window.setTimeout(() => removeLocal(toast.id), toast.ms));
    },
    [removeLocal]
  );

  const dismiss = useCallback(
    (id: string) => {
      removeLocal(id);
      actionsRef.current.delete(id);
      channelRef.current?.postMessage({ type: "dismiss", id } satisfies ChannelMessage);
    },
    [removeLocal]
  );

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const message = event.data;
      if (message.type === "show") showLocal(message.toast);
      if (message.type === "dismiss") {
        removeLocal(message.id);
        actionsRef.current.delete(message.id);
      }
      if (message.type === "act") {
        const action = actionsRef.current.get(message.id);
        if (action) {
          actionsRef.current.delete(message.id);
          action();
          dismiss(message.id);
        }
      }
    };
    const timers = timersRef.current;
    return () => {
      channel.close();
      channelRef.current = null;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [showLocal, removeLocal, dismiss]);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const tone = input.tone ?? "info";
      const item: ToastItem = {
        id,
        message: input.message,
        tone,
        actionLabel: input.action?.label,
        ms: input.ms ?? (tone === "error" && input.action ? 0 : DEFAULT_MS)
      };
      if (input.action) actionsRef.current.set(id, input.action.onClick);
      showLocal(item);
      if (input.broadcast) channelRef.current?.postMessage({ type: "show", toast: item } satisfies ChannelMessage);
    },
    [showLocal]
  );

  function act(item: ToastItem) {
    const action = actionsRef.current.get(item.id);
    if (action) {
      actionsRef.current.delete(item.id);
      action();
      dismiss(item.id);
    } else {
      // Raised by another tab — ask it to run its action; it dismisses everywhere once it has.
      channelRef.current?.postMessage({ type: "act", id: item.id } satisfies ChannelMessage);
      removeLocal(item.id);
    }
  }

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? (
        // Above the mobile nav, and above the slot the End-day / delete-block undo toasts use, so the two never overlap.
        <div className="pointer-events-none fixed bottom-20 right-4 z-[60] lg:bottom-16 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2" role="status" aria-live="polite">
          {toasts.map((item) => (
            <div
              key={item.id}
              className={clsx(
                "pointer-events-auto flex items-center gap-3 rounded-md border px-3 py-2 text-sm shadow-lg",
                item.tone === "error"
                  ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                  : "border-ink-200 bg-white text-ink-800 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
              )}
            >
              {item.tone === "error" ? <AlertTriangle className="h-4 w-4 shrink-0" /> : null}
              <span>{item.message}</span>
              {item.actionLabel ? (
                <button className="font-medium text-moss-700 hover:underline dark:text-moss-400" onClick={() => act(item)}>
                  {item.actionLabel}
                </button>
              ) : null}
              <button className="opacity-60 hover:opacity-100" onClick={() => dismiss(item.id)} aria-label="Dismiss">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
