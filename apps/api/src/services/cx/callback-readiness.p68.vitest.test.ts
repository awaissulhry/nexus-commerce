/**
 * P6.8 — a production app whose sign-in has nowhere to come back to.
 *
 * Plan row: *"Shopify and Etsy on production: production app, HTTPS callbacks, real
 * consent, return to the tab."* — marked **"Your app set-up"**, the Owner's.
 *
 * ## Measured 2026-09-21, on rows marked `environment: 'production'`
 *
 * | channel | registered redirect URI | connection |
 * |---|---|---|
 * | ETSY | `https://morbidity-curtly-probe.ngrok-free.dev/api/cx/callback/etsy` — a **development tunnel** | `connected`, last heartbeat 2026-09-10 |
 * | SHOPIFY | **none at all** (`redirectUris` empty) | `connected`, **`lastHeartbeatAt: null`** |
 *
 * 🔴 An ngrok free tunnel changes host every restart, so that Etsy callback died the
 * moment the tunnel that created it closed. A connect would send the operator to a host
 * that no longer exists. An empty list is the same outcome by a different route.
 *
 * 🔴 And Shopify claims `authStatus: 'connected'` with **no heartbeat, ever**. That
 * status was written when it was connected and has never been tested — P3.6's rule in
 * its original form: a state nothing verified is not health.
 *
 * ## Why an alert and not a gate
 *
 * This is **data**, not source. A pre-push check reads files; it cannot see a
 * `ChannelApp` row. So the fact has to be raised from where the data is.
 *
 * The row itself stays the Owner's — registering a production callback happens in
 * Shopify's and Etsy's developer consoles. What this adds is that the system stops
 * being silent about it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callbackReadinessAlert } from './channel-alerts.service.js'

const PROD = 'production'

describe('callbackReadinessAlert (P6.8)', () => {
  it('raises on the measured Etsy case — an ngrok tunnel', () => {
    const a = callbackReadinessAlert('ETSY', PROD, ['https://morbidity-curtly-probe.ngrok-free.dev/api/cx/callback/etsy'])
    expect(a?.title).toMatch(/development tunnel/)
    expect(a?.body).toMatch(/no longer exists/)
    expect(a?.kind).toBe('channel-callback-not-production')
  })

  it('raises on the measured Shopify case — no callback at all', () => {
    const a = callbackReadinessAlert('SHOPIFY', PROD, [])
    expect(a?.title).toMatch(/no sign-in callback registered/)
    expect(a?.body).toMatch(/nowhere to return to/)
  })

  it('says nothing about a real production callback', () => {
    expect(callbackReadinessAlert('EBAY', PROD, ['https://nexusapi-production-b7bb.up.railway.app/api/cx/callback/ebay'])).toBeNull()
  })

  it('says nothing when a real callback sits BESIDE a dev one', () => {
    // A tunnel kept for local work is not a production problem as long as production
    // has a real URI. Raising here would be an alert nobody can act on.
    expect(callbackReadinessAlert('ETSY', PROD, [
      'https://x.ngrok-free.dev/api/cx/callback/etsy',
      'https://nexusapi-production-b7bb.up.railway.app/api/cx/callback/etsy',
    ])).toBeNull()
  })

  it('never fires for a sandbox app', () => {
    // A sandbox app SHOULD point at a tunnel. Alerting there is noise that teaches
    // people to ignore the one that matters.
    expect(callbackReadinessAlert('ETSY', 'sandbox', ['https://x.ngrok-free.dev/cb'])).toBeNull()
    expect(callbackReadinessAlert('SHOPIFY', 'sandbox', [])).toBeNull()
  })

  it('knows the common tunnel hosts, not just ngrok', () => {
    for (const host of ['https://a.ngrok-free.dev/cb', 'https://b.loca.lt/cb', 'http://localhost:3001/cb', 'http://127.0.0.1:3001/cb', 'https://c.trycloudflare.com/cb']) {
      expect(callbackReadinessAlert('ETSY', PROD, [host]), host).not.toBeNull()
    }
  })

  it('its entity id cannot dedupe against the other ChannelApp alerts', () => {
    const a = callbackReadinessAlert('SHOPIFY', PROD, [])
    expect(a?.entityId).toBe('SHOPIFY:production:callback')
  })
})

describe('the sweep reaches these rows (P6.8)', () => {
  const job = readFileSync(join(import.meta.dirname, '..', '..', 'jobs', 'channel-alerts.job.ts'), 'utf8')

  it('🔴 has NO where-filter on a date', () => {
    // The whole point. The filter was `secretExpiresAt: { not: null }`, then an OR with
    // the signing key. Shopify and Etsy have BOTH dates null — selecting on the
    // presence of a date is exactly how the rows this checks stayed invisible.
    expect(job).toContain('where: {},')
    const code = job.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    expect(code.filter((l) => l.includes('{ not: null }'))).toEqual([])
  })

  it('selects redirectUris and raises the alert', () => {
    expect(job).toContain('redirectUris: true')
    expect(job).toContain('callbackReadinessAlert(app.channelKey, app.environment, app.redirectUris)')
  })

  it('the date-driven alerts keep their own guards', () => {
    // Without the query filter, each alert must decide for itself — otherwise removing
    // the filter would fire a secret-expiry alert on a null date.
    expect(job).toContain('if (app.secretExpiresAt) {')
    expect(job).toContain('if (app.signingKeyExpiresAt) {')
  })
})
