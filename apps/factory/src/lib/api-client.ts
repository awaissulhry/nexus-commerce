/**
 * F1 — same-origin fetch helper: mirrors the CSRF double-submit cookie into
 * the x-factory-csrf header on mutations. Single origin means cookies ride
 * automatically — none of Nexus's cross-site fetch patching exists here.
 */
"use client";

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function ensureCsrf(): Promise<string> {
  const existing = readCookie("factory_csrf");
  if (existing) return existing;
  const res = await fetch("/api/auth/csrf");
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("x-factory-csrf", await ensureCsrf());
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return fetch(path, { ...init, headers });
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  const body = (await res.json().catch(() => null)) as T & { error?: string };
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
  return body as T;
}
