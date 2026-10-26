/**
 * Reviews area — every read and write the Reviews pages make, on the API's address (`getBackendUrl()`; a relative
 * `/api/reviews…` 404s once deployed). A failed call answers in words a person can act on, never a status code or an
 * error key; a write the API keeps receipts for sends an Idempotency-Key (lib/command-key.ts), so a double press or a
 * retry after a dropped answer cannot run it twice.
 */
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, commandKeyFor, sendCommand, type CommandKey } from '@/lib/command-key'
import { withQuery, type LinkParams } from './reviewsLinks'

export type ReviewsResult<T> = { data: T; error: null; status: number } | { data: null; error: string; status: number }

/** Shown when no answer arrived at all. */
export const UNREACHABLE_WORDS = 'Nexus could not be reached. Check your connection and try again.'

/** A message the API wrote for people (a sentence), as opposed to an error key such as `invalid_status`. */
function sentence(value: unknown): string | null {
  return typeof value === 'string' && /\s/.test(value.trim()) ? value.trim() : null
}

/** What a failed answer means, in words: the API's own sentence when it wrote one, else words for the status. */
export function errorWords(status: number, body: unknown): string {
  const b = body && typeof body === 'object' ? (body as { error?: unknown; message?: unknown }) : {}
  const own = sentence(b.message) ?? sentence(b.error)
  if (status === 401) return 'Your sign-in has ended. Sign in again, then try again.'
  if (status === 403) return own ?? 'You do not have permission to do this here.'
  if (own) return own
  if (status === 404) return 'Nexus could not find this. It may have been removed.'
  if (status === 409) return 'This changed while you were working on it. Reload, then try again.'
  if (status === 429) return 'Too many requests at once. Wait a minute, then try again.'
  if (status >= 500) return 'Nexus could not finish this. Try again in a moment.'
  return 'Nexus could not do this. Check what you entered, then try again.'
}

/** The full URL of a Reviews API path ("/reviews/inbox") with its query. */
export function reviewsUrl(path: string, params?: LinkParams): string {
  return `${getBackendUrl()}/api${withQuery(path, params)}`
}

async function readBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

/** Read from the Reviews API. */
export async function reviewsGet<T>(path: string, params?: LinkParams, init?: { signal?: AbortSignal }): Promise<ReviewsResult<T>> {
  try {
    const response = await fetch(reviewsUrl(path, params), { cache: 'no-store', signal: init?.signal })
    const body = await readBody(response)
    return response.ok ? { data: body as T, error: null, status: response.status } : { data: null, error: errorWords(response.status, body), status: response.status }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return { data: null, error: UNREACHABLE_WORDS, status: 0 }
  }
}

export interface SendOptions {
  /**
   * Send an Idempotency-Key. `true` keeps one key per method + path for the page session; pass a component's own
   * `useCommandKey()` slot when one screen sends the same command for different intents.
   */
  idempotent?: boolean | CommandKey
  /** Names the request in a conflict message: "reply", "import". Default "request". */
  what?: string
}

/** Write to the Reviews API (POST, PATCH, PUT, DELETE). */
export async function reviewsSend<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options: SendOptions = {},
): Promise<ReviewsResult<T>> {
  const url = reviewsUrl(path)
  const init: RequestInit = {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
  try {
    if (options.idempotent) {
      const slot = options.idempotent === true ? commandKeyFor(`reviews:${method} ${path}`) : options.idempotent
      const { response, body: answer, conflict } = await sendCommand<unknown>(slot, url, init)
      if (response.ok) return { data: answer as T, error: null, status: response.status }
      const error = conflict ? commandConflictMessage(conflict, options.what ?? 'request') : errorWords(response.status, answer)
      return { data: null, error, status: response.status }
    }
    const response = await fetch(url, init)
    const answer = await readBody(response)
    return response.ok ? { data: answer as T, error: null, status: response.status } : { data: null, error: errorWords(response.status, answer), status: response.status }
  } catch {
    return { data: null, error: UNREACHABLE_WORDS, status: 0 }
  }
}
