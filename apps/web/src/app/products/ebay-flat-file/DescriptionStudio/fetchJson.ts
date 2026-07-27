/**
 * DS-1 — the Studio's ONE fetch contract: every request resolves to
 * `{ ok: true, data }` or `{ ok: false, error, … }`, and BOTH arms render
 * somewhere. `catch {}` with an empty body is banned in the Studio — a failed
 * fetch that leaves the UI silently pretending is exactly the class of lie
 * this rebuild exists to kill.
 *
 * Aborts (superseded debounced requests) come back as `aborted: true` so
 * callers can skip state updates without treating them as failures.
 */

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; aborted?: boolean; body?: unknown }

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<FetchResult<T>> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, error: 'aborted', aborted: true }
    }
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }
  const text = await res.text().catch(() => '')
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null // non-JSON body — the raw text below is the error surface
    }
  }
  if (!res.ok) {
    const serverError = (body as { error?: string } | null)?.error
    return {
      ok: false,
      error: serverError ?? (text ? text.slice(0, 300) : `HTTP ${res.status}`),
      status: res.status,
      body,
    }
  }
  return { ok: true, data: body as T }
}
