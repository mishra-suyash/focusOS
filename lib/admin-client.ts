"use client";

/** Thin fetch wrapper shared by every /admin screen — attaches the caller's ID token and unwraps the JSON error shape once. */
export async function adminFetch<T>(
  user: { getIdToken: () => Promise<string> },
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = await user.getIdToken();
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request to ${path} failed.`);
  return body as T;
}
