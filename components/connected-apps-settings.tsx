"use client";

/**
 * plan/19 §4.1/§5.3 — Settings → Connected apps. Shows every Claude connection to this account (OAuth
 * approvals from claude.ai and personal access tokens for Claude Code), lets the person revoke any of
 * them, make a token, and see the last 50 changes Claude made, with what each field was before.
 */
import { Copy, Plug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";

interface Connection {
  familyId: string;
  kind: "pat" | "oauth";
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface ActivityEntry {
  id: string;
  at: string;
  tool: string;
  clientName: string;
  targetType: string;
  targetId: string;
  title?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  more?: { targetType: string; title?: string }[];
}

interface Data {
  access: { ok: boolean; reason?: string };
  mcpUrl: string;
  connections: Connection[];
  activity: ActivityEntry[];
}

function when(iso?: string) {
  return iso ? new Date(iso).toLocaleString() : "never";
}

function describe(entry: ActivityEntry) {
  const verb = entry.tool.replace(/_/g, " ");
  const extra = entry.more?.length ? ` (+${entry.more.length} more change${entry.more.length === 1 ? "" : "s"})` : "";
  return `${verb}${entry.title ? `: ${entry.title}` : ""}${extra}`;
}

function ChangeDetail({ before, after }: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (keys.length === 0) return null;
  const show = (value: unknown) => (value === null || value === undefined ? "—" : typeof value === "string" ? value : JSON.stringify(value));
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-ink-500">
      {keys.map((key) => (
        <div key={key} className="contents">
          <dt className="font-medium">{key}</dt>
          <dd className="break-words">
            {before === null ? "" : `${show(before?.[key])} → `}
            {after === null ? "removed" : show(after?.[key])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ConnectedAppsSettings() {
  const { user } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("Claude Code");
  const [allowWrite, setAllowWrite] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openActivity, setOpenActivity] = useState<string | null>(null);

  const call = useCallback(
    async (method: "GET" | "POST" | "DELETE", query = "", body?: unknown) => {
      if (!user) throw new Error("Not signed in.");
      const token = await user.getIdToken();
      const response = await fetch(`/api/mcp/connections${query}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Request failed.");
      return json;
    },
    [user]
  );

  const load = useCallback(() => {
    call("GET")
      .then((json: Data) => setData(json))
      .catch((err: Error) => setError(err.message));
  }, [call]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function createToken() {
    setBusy(true);
    setError("");
    try {
      const json = (await call("POST", "", { label, scopes: allowWrite ? ["read", "write"] : ["read"] })) as { token: string };
      setNewToken(json.token);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  async function revoke(connection: Connection) {
    if (!window.confirm(`Disconnect "${connection.name}"? Claude will have to be connected again to use FocusLab.`)) return;
    setBusy(true);
    try {
      await call("DELETE", `?familyId=${encodeURIComponent(connection.familyId)}`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  const live = data?.connections.filter((c) => !c.revokedAt) ?? [];
  const command = newToken && data ? `claude mcp add --transport http focuslab ${data.mcpUrl} --header "Authorization: Bearer ${newToken}"` : "";

  return (
    <section className="card p-5 lg:col-span-2">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Plug className="h-4 w-4" aria-hidden /> Connected apps
      </h2>
      <p className="mb-4 text-sm text-ink-600 dark:text-ink-300">
        Let Claude see your FocusLab and, if you allow it, make changes. In claude.ai, add a custom connector with the URL below; you&apos;ll approve it on a FocusLab screen.
      </p>
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {!data ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Connector URL</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-ink-100 px-2 py-1 text-sm dark:bg-ink-800">{data.mcpUrl}</code>
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => void navigator.clipboard?.writeText(data.mcpUrl)} aria-label="Copy connector URL">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            {!data.access.ok ? <p className="mt-2 text-sm text-amberline">{data.access.reason}</p> : null}
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Connections</p>
            {live.length === 0 ? (
              <p className="mt-1 text-sm text-ink-500">Nothing is connected.</p>
            ) : (
              <ul className="mt-1 divide-y divide-ink-100 dark:divide-ink-800">
                {live.map((connection) => (
                  <li key={connection.familyId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span>
                      <span className="font-medium">{connection.name}</span>
                      <span className="text-ink-500">
                        {" "}
                        · {connection.kind === "pat" ? "token" : "approved"} {new Date(connection.createdAt).toLocaleDateString()} · {connection.scopes.includes("write") ? "can make changes" : "read only"} · last used {when(connection.lastUsedAt)}
                      </span>
                    </span>
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => void revoke(connection)} disabled={busy}>
                      Disconnect
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.access.ok ? (
            <details className="rounded-md border border-ink-200 p-3 text-sm dark:border-ink-800">
              <summary className="cursor-pointer font-medium">Make a token for Claude Code</summary>
              <div className="mt-3 space-y-3">
                <label className="block">
                  Name
                  <input className="input mt-1" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} />
                  Can make changes
                </label>
                <button className="btn-primary" onClick={() => void createToken()} disabled={busy}>
                  Create token
                </button>
                {newToken ? (
                  <div className="space-y-1">
                    <p className="text-ink-600 dark:text-ink-300">Shown once. Run this in a terminal to add it to Claude Code:</p>
                    <div className="flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all rounded bg-ink-100 px-2 py-1 text-xs dark:bg-ink-800">{command}</code>
                      <button className="btn-secondary px-2 py-1 text-xs" onClick={() => void navigator.clipboard?.writeText(command)} aria-label="Copy command">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">What Claude changed</p>
            {data.activity.length === 0 ? (
              <p className="mt-1 text-sm text-ink-500">No changes yet.</p>
            ) : (
              <ul className="mt-1 divide-y divide-ink-100 text-sm dark:divide-ink-800">
                {data.activity.map((entry) => (
                  <li key={entry.id} className="py-2">
                    <button className="w-full text-left" onClick={() => setOpenActivity(openActivity === entry.id ? null : entry.id)} aria-expanded={openActivity === entry.id}>
                      <span className="font-medium">{describe(entry)}</span>
                      <span className="block text-xs text-ink-500">
                        {new Date(entry.at).toLocaleString()} · {entry.clientName}
                      </span>
                    </button>
                    {openActivity === entry.id ? <ChangeDetail before={entry.before} after={entry.after} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
