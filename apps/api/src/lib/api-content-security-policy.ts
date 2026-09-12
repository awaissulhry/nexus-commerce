import { randomBytes } from 'node:crypto'

const callbackNonces = new WeakMap<object, string>()
const DEFAULT_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"

/** Only a callback handler can opt its own response into executable HTML. */
export function oauthCallbackNonce(reply: object): string {
  const nonce = randomBytes(24).toString('base64')
  callbackNonces.set(reply, nonce)
  return nonce
}

export function apiContentSecurityPolicy(url: string, reply: object): string {
  const path = url.split('?')[0]
  const nonce = callbackNonces.get(reply)
  if (nonce && /^\/api\/cx\/callback\/[a-z_-]+\/?$/i.test(path)) {
    return `${DEFAULT_POLICY}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'none'`
  }
  if (path === '/api/advertising/digest/weekly/preview') {
    return `${DEFAULT_POLICY}; style-src 'unsafe-inline'`
  }
  return DEFAULT_POLICY
}
