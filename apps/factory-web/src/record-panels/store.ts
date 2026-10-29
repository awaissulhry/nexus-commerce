import type { Presigned } from './api'

/**
 * The file bytes, which never pass through the factory API's JSON routes (apps/factory-api "Files on R2"): an upload is
 * announced (POST /files), its bytes go STRAIGHT to the store with the presigned request of the answer, then it is
 * confirmed; a download is a presigned GET that lives 60 seconds. These two requests are the store's, not API calls:
 *  - R2 (LIVE, SANDBOX): an absolute https address, sent without cookies;
 *  - the local store of a FAKE account (local and test runs): `/local-files?token=…` on the factory API, reached through
 *    this app's `/api` like every API route (next.config.ts), so the browser never needs the API's own address.
 * Only the signed headers are sent (content type, the SHA-256 the store checks); the browser sets the length itself.
 */

export class StoreError extends Error {
  override name = 'StoreError'
  constructor(readonly status: number) {
    super(`The file store answered ${status}.`)
  }
}

/** A presigned address as this browser reaches it. */
export function storeUrl(url: string): string {
  if (url.startsWith('/') && !url.startsWith('//')) return `/api${url}`
  if (/^https:\/\//i.test(url)) return url
  // Plain http only for a loopback store in a local run; anything else is refused before a byte leaves.
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return url
  throw new TypeError('The file store gave an address this app does not send files to.')
}

const UNSENDABLE = new Set(['content-length', 'host', 'connection', 'cookie'])

/** The signed headers of a presigned request (minus those a browser sets itself). */
export function storeHeaders(presigned: Pick<Presigned, 'headers'>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(presigned.headers)) if (!UNSENDABLE.has(name.toLowerCase())) headers.set(name, value)
  return headers
}

/** SHA-256 of the bytes, 64 lower-case hex digits (the store refuses a body that does not match what was announced). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const credentialsFor = (url: string): RequestCredentials => (url.startsWith('/') ? 'same-origin' : 'omit')

/** Sends the bytes with the presigned PUT. */
export async function putToStore(presigned: Presigned, body: Blob | ArrayBuffer, doFetch: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<void> {
  const url = storeUrl(presigned.url)
  const response = await doFetch(url, { method: 'PUT', headers: storeHeaders(presigned), body, credentials: credentialsFor(url), cache: 'no-store' })
  if (!response.ok) throw new StoreError(response.status)
}

/** Reads the bytes with the presigned GET (a PDF for the viewer: read once, so a 60-second address cannot run out). */
export async function readFromStore(presigned: Presigned, doFetch: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<Uint8Array> {
  const url = storeUrl(presigned.url)
  const response = await doFetch(url, { method: 'GET', headers: storeHeaders(presigned), credentials: credentialsFor(url), cache: 'no-store' })
  if (!response.ok) throw new StoreError(response.status)
  return new Uint8Array(await response.arrayBuffer())
}
