/**
 * P2 (2026-09-30, I4-2) — reads the studio started from its URL before the hook that owns them mounted.
 *
 * The first row used to wait for five requests in a row: csrf → me → (product, markets, accounts) → destination → sheet.
 * The destination check and the sheet read need nothing but the URL, so the page starts them at once
 * (`studioPrefetch.ts`) and the hooks ADOPT them here through `fetchStudioRead`. A prefetched read is used at most by the
 * first read of its kind, and only when the URL is exactly the one the hook would have fetched: when the frame resolves a
 * different coordinate (the destination or the scope checks disagree with the URL), the prefetch is dropped and the hook
 * reads for itself. Nothing here ever serves a read twice, so a later refresh can never receive page-load data.
 *
 * Audit B03 — the URL names the product, scope, market, languages and account, but not WHO asked: the fetch patch adds
 * the business from the page's path and the session cookie is the browser's. So a read is adopted only by the business
 * it was started in, and never by another signed-in user (the session may still be loading when a read starts; a user
 * known on both sides must match).
 */
import { browserWorkspaceId } from '@/lib/workspaces/paths'
import { browserUserId } from '@/lib/workspaces/browser-identity'


/** A prefetch nobody adopted is dropped after this long: a page that has not asked for it by then will not. */
export const PREFETCH_TTL_MS = 15_000

type Kind = 'sheet' | 'destination'
interface Owner { workspace: string | null; user: string | null }
interface Entry { url: string; owner: Owner; response: Promise<Response>; controller: AbortController; timer: ReturnType<typeof setTimeout>; adopted?: boolean }

const currentOwner = (): Owner => ({ workspace: browserWorkspaceId(), user: browserUserId() })
const sameOwner = (a: Owner, b: Owner) => a.workspace === b.workspace && (a.user === null || b.user === null || a.user === b.user)

const entries = new Map<Kind, Entry>()

/** Which studio read a URL is — only these two are ever prefetched. */
export function prefetchKind(url: string): Kind | null {
  let path: string
  try { path = new URL(url, 'http://studio.invalid').pathname } catch { return null }
  return /\/studio\/sheet$/.test(path) ? 'sheet' : /\/studio\/destination$/.test(path) ? 'destination' : null
}

function drop(kind: Kind, abort: boolean): void {
  const entry = entries.get(kind)
  if (!entry) return
  entries.delete(kind)
  clearTimeout(entry.timer)
  if (abort) entry.controller.abort()
}

/** Start one read now. The same URL twice (a StrictMode double effect) is one request. */
export function startPrefetch(url: string, doFetch: typeof fetch = (...args) => fetch(...args)): void {
  const kind = prefetchKind(url)
  if (!kind) return
  const owner = currentOwner()
  const existing = entries.get(kind)
  if (existing?.url === url && sameOwner(existing.owner, owner)) return
  drop(kind, true)
  const controller = new AbortController()
  // No credentials or headers here: the patched fetch (`install-fetch.ts`) adds them to every API read, this one included.
  const response = doFetch(url, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
  // A failure is the adopter's to handle (it reads for itself); never an unhandled rejection here.
  response.catch(() => {})
  entries.set(kind, { url, owner, response, controller, timer: setTimeout(() => drop(kind, true), PREFETCH_TTL_MS) })
}

/**
 * The prefetched answer for exactly this URL, or `null`. A different URL of the same kind drops the prefetch: the page
 * asked for something else, so it will never want it. The read is consumed once an adopter that was not cancelled
 * receives it (a StrictMode remount cancels the first adopter and adopts again).
 */
export function adoptPrefetch(url: string, signal?: AbortSignal): Promise<Response> | null {
  const kind = prefetchKind(url)
  const entry = kind ? entries.get(kind) : undefined
  if (!kind || !entry) return null
  if (entry.url !== url || !sameOwner(entry.owner, currentOwner())) { drop(kind, true); return null }
  // Adopted: the read is wanted now, however long it takes (its own 30 s bound still holds). The expiry only forgets it
  // (a cancelled adopter that never comes back), it no longer aborts it (P2 review 5).
  if (!entry.adopted) {
    entry.adopted = true
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => drop(kind, false), PREFETCH_TTL_MS)
  }
  return entry.response.then((response) => {
    if (!signal?.aborted && entries.get(kind) === entry) drop(kind, false)
    return response.clone()
  })
}

/** Test seam: forget every prefetch. */
export function clearPrefetches(): void {
  for (const kind of [...entries.keys()]) drop(kind, true)
}
