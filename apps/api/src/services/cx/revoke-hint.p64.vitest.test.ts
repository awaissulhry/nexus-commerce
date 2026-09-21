/**
 * P6.4 — a disconnect says what happened AT THE CHANNEL, and where to finish.
 *
 * Plan row: *"Revoke at the channel where it can be done; where not, clear locally and
 * show the channel page link."*
 * Plan §4.1: *"Disconnect calls the channel only for eBay."*
 *
 * ## Measured 2026-09-21
 *
 * | fact | state |
 * |---|---|
 * | channels declaring `revokeUrl` | **1 of 5** — eBay only |
 * | `revokedAtChannel` returned by `POST /accounts/:id/disconnect` | yes, and read by **no web caller** |
 * | a "where to revoke" link anywhere in the tree | **none** |
 * | what the screen said when nothing was revoked | *"Disconnected — the stored grant was removed from Nexus."*, tone **success** |
 *
 * 🔴 So for Amazon SP-API, Amazon Ads, Shopify and Etsy, a disconnect cleared **our
 * copy** of the credentials while the grant **kept existing at the channel** — and the
 * operator was shown a green "Disconnected" with nothing to click. A green for a
 * half-done job is the kind that teaches people the screen is not worth reading.
 *
 * P4.5e found the same class from the other side: the Ads client kept calling Amazon
 * after a disconnect because the legacy row still held a token. This is the part the
 * operator can see.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const spec = (name: string) => readFileSync(join(HERE, 'connectors', name, 'spec.ts'), 'utf8')

/** Every channel, and whether it can be revoked through an API. */
const CHANNELS = [
  { dir: 'ebay', revokable: true },
  { dir: 'amazon-sp', revokable: false },
  { dir: 'amazon-ads', revokable: false },
  { dir: 'shopify', revokable: false },
  { dir: 'etsy', revokable: false },
] as const

describe('revoke coverage (P6.4)', () => {
  it('exactly one channel has a revoke endpoint — the measured fact this rests on', () => {
    const withUrl = CHANNELS.filter((c) => spec(c.dir).includes('revokeUrl:')).map((c) => c.dir)
    expect(withUrl).toEqual(['ebay'])
  })

  it('every channel that CANNOT be revoked names where a human does it', () => {
    for (const c of CHANNELS.filter((x) => !x.revokable)) {
      const src = spec(c.dir)
      expect(src, `${c.dir} has no revokeHint`).toContain('revokeHint: {')
      expect(src, `${c.dir}'s hint has no url`).toMatch(/revokeHint: \{[\s\S]{0,400}url: 'https:\/\//)
    }
  })

  it('the one channel that CAN be revoked does not need a hint', () => {
    // A hint beside a working revoke would tell the operator to go and redo something
    // already done — the false instruction P6.2 avoided in its alert wording.
    expect(spec('ebay')).not.toContain('revokeHint')
  })

  it('each hint carries a sentence saying what is left, not just a link', () => {
    for (const c of CHANNELS.filter((x) => !x.revokable)) {
      const src = spec(c.dir)
      const at = src.indexOf('revokeHint: {')
      const block = src.slice(at, at + 500)
      expect(block, `${c.dir}`).toContain('label:')
      expect(block, `${c.dir}`).toContain('detail:')
      // The detail must say something about the grant, not repeat the label.
      expect(block.match(/detail: '[^']{40,}'/), `${c.dir}'s detail is too short to be useful`).toBeTruthy()
    }
  })
})

describe('the route (P6.4)', () => {
  const route = readFileSync(join(HERE, '..', '..', 'routes', 'accounts.routes.ts'), 'utf8')

  it('returns the hint', () => {
    expect(route).toContain('const revokeHint = !revokedAtChannel ? (spec?.auth.revokeHint ?? null) : null;')
    expect(route).toContain('revokeHint,')
  })

  it('returns NULL when the channel really did revoke it', () => {
    // Nothing left to do, so nothing to show. The ternary above is the whole rule and
    // this is the arm that would otherwise nag after a successful eBay revoke.
    expect(route).toContain('!revokedAtChannel ?')
  })
})

describe('the sentence an operator sees (P6.4)', () => {
  const data = readFileSync(
    join(HERE, '..', '..', '..', '..', 'web', 'src', 'app', 'settings', 'channels', '[type]', 'channelDetail.ts'),
    'utf8',
  )
  const client = readFileSync(
    join(HERE, '..', '..', '..', '..', 'web', 'src', 'app', 'settings', 'channels', '[type]', 'ChannelDetailClient.tsx'),
    'utf8',
  )

  it('three outcomes get three sentences', () => {
    expect(data).toContain('export function disconnectNote(')
    expect(data).toContain('Disconnected, and the grant was revoked at the channel.')
    expect(data).toContain('Disconnected here, and the grant still exists at the channel.')
  })

  it('a half-done disconnect is NOT green', () => {
    // 🔴 The whole point. It used to be `tone: 'success'` either way.
    const fn = data.slice(data.indexOf('export function disconnectNote('))
    const body = fn.slice(0, 1200)
    expect(body).toContain("tone: 'success'") // the genuinely-revoked arm
    expect((body.match(/tone: 'warning'/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('the screen uses it, and renders the link', () => {
    expect(client).toContain('setNote(disconnectNote(r))')
    expect(client).toContain('{note.link && (')
    expect(client).toContain('rel="noreferrer noopener"')
  })

  it('there is still a sentence when a channel has no hint at all', () => {
    // A channel added later with neither a revokeUrl nor a hint must not produce an
    // empty banner — "could not measure" must not render as nothing.
    const fn = data.slice(data.indexOf('export function disconnectNote('))
    expect(fn.slice(0, 1600)).toContain('offers no way to revoke the grant from our side')
  })
})
