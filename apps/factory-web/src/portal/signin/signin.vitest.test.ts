import { createHash } from 'node:crypto'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { solveChallenge as referenceSolve } from '@nexus/factory-domain/abuse/pow'
import { createApiClient } from '../../lib/api/client'
import { ApiError } from '../../lib/api/errors'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { readHead, signInWithCode, startSignIn } from './api'
import { designScreen } from './fixtures'
import {
  accessOf,
  addressFromCookie,
  addressCookieValue,
  addressOf,
  asksSummaries,
  codeProblemOf,
  companyOfLinkToken,
  destinationOf,
  emailProblem,
  endedOf,
  firstVisitProblems,
  keptNext,
  linkTokenOf,
  NEXT_TTL_MS,
  nextToKeep,
  portalAddress,
  retryAfterMs,
  safeNext,
  waitParts,
  wantsChallenge,
} from './model'
import { hasLeadingZeroBits, solveChallenge } from './pow'

/** SCR-026 (B-W2b-164): the sign-in's rules, its calls and every design case in Italian and English. */

const TENANT = '0190f0e2-1640-7000-8000-00000000000a'
const COMPANY = '0190f0e2-1640-7000-8000-00000000000b'
const PERSON = '0190f0e2-1640-7000-8000-00000000000c'
const SECRET = 'A'.repeat(43)
const TOKEN = `pl1.${TENANT}.${COMPANY}.${PERSON}.${SECRET}`
const issue = (path: string, message = '') => ({ path, message })

describe('whose portal', () => {
  it('takes the invitation address as the API does: a slug, a code or none; the cookie keeps it', () => {
    expect(portalAddress('Seed', 'SCA')).toEqual({ tenant: 'seed', company: 'SCA' })
    expect(portalAddress('seed', null)).toEqual({ tenant: 'seed', company: '' })
    expect(portalAddress('', 'SCA')).toBeNull()
    expect(portalAddress('seed', 'S CA')).toBeNull()
    expect(portalAddress('seed/../x', 'SCA')).toBeNull()
    const kept = addressCookieValue({ tenant: 'seed', company: 'SCA' })
    expect(addressFromCookie(kept)).toEqual({ tenant: 'seed', company: 'SCA' })
    expect(addressFromCookie('seed|SCA|x')).toBeNull()
    expect(addressFromCookie(undefined)).toBeNull()
    // The address the page was opened with wins over the one this device remembers.
    expect(addressOf({ tenant: 'a', company: '' }, { tenant: 'b', company: 'X' })).toEqual({ tenant: 'a', company: '' })
    expect(addressOf(null, { tenant: 'b', company: 'X' })).toEqual({ tenant: 'b', company: 'X' })
  })

  it('reads the mailed link\'s token from the fragment only in its own shape, and the company it names', () => {
    expect(linkTokenOf(`#token=${TOKEN}`)).toBe(TOKEN)
    expect(linkTokenOf(`token=${encodeURIComponent(TOKEN)}`)).toBe(TOKEN)
    expect(linkTokenOf(`#token=ps1.${TENANT}.${COMPANY}.${PERSON}.${SECRET}`)).toBeNull()
    expect(linkTokenOf(`#token=${TOKEN}x`)).toBeNull()
    expect(linkTokenOf('')).toBeNull()
    expect(companyOfLinkToken(TOKEN)).toBe(COMPANY)
  })
})

describe('where a signed-in person goes', () => {
  it('back to the portal page they were going to, never elsewhere; else Home by the party\'s code (or id)', () => {
    expect(safeNext('/p/SEED-C1/open/Quote/x#task:t1')).toBe('/p/SEED-C1/open/Quote/x#task:t1')
    expect(safeNext('/p/SEED-C1?tab=2')).toBe('/p/SEED-C1?tab=2')
    for (const bad of ['//evil.example/p/x', 'https://evil.example/p/x', '/w/SCA', '/p/signin', '/p/SIGNIN/continue', '/p/unsubscribe', '/p/', '/p/x\\y', '/p/a\nb', null, '']) expect(safeNext(bad), String(bad)).toBeNull()
    expect(destinationOf('/p/SEED-C1/orders', { id: 'p1', code: 'SEED-C1' })).toBe('/p/SEED-C1/orders')
    expect(destinationOf(null, { id: 'p1', code: 'SEED C1' })).toBe('/p/SEED%20C1')
    expect(destinationOf('//evil', { id: 'p1' })).toBe('/p/p1')
  })

  it('keeps the page for the mailed link\'s tab for 15 minutes only', () => {
    const kept = nextToKeep('/p/SEED-C1/orders', 1_000)
    expect(keptNext(kept, 1_000 + NEXT_TTL_MS - 1)).toBe('/p/SEED-C1/orders')
    expect(keptNext(kept, 1_000 + NEXT_TTL_MS + 1)).toBeNull()
    expect(nextToKeep('https://evil.example', 1_000)).toBeNull()
    expect(keptNext('{"next":"//evil","at":1000}', 1_000)).toBeNull()
    expect(keptNext('not json', 1_000)).toBeNull()
    expect(endedOf('idle')).toBe('idle')
    expect(endedOf('x')).toBeNull()
  })
})

describe('what the API said, in the page\'s terms', () => {
  it('the e-mail\'s own check', () => {
    expect(emailProblem('  ')).toBe('required')
    expect(emailProblem('anna.demo')).toBe('format')
    expect(emailProblem(' anna@brand.example ')).toBeNull()
  })

  it('a refused code: wrong with the tries counted, tried out, expired, a wait, our side', () => {
    expect(codeProblemOf(new ApiError('signed_out', 401, 'unauthenticated', 'x', null, [issue('code', 'That code does not match. 4 tries left.')]))).toEqual({ kind: 'wrong', triesLeft: 4 })
    expect(codeProblemOf(new ApiError('signed_out', 401, 'unauthenticated', 'x', null, [issue('code', 'That code does not match. 1 try left.')]))).toEqual({ kind: 'wrong', triesLeft: 1 })
    expect(codeProblemOf(new ApiError('signed_out', 401, 'unauthenticated', 'x', null, [issue('code/TRIED_OUT')]))).toEqual({ kind: 'triedOut' })
    expect(codeProblemOf(new ApiError('signed_out', 401, 'unauthenticated', 'x', null, [issue('code/EXPIRED')]))).toEqual({ kind: 'expired' })
    expect(codeProblemOf(new ApiError('invalid', 400, 'invalid', 'x', null, [issue('body/code')]))).toEqual({ kind: 'format' })
    expect(codeProblemOf(new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [issue('retryAfter', '240')]))).toEqual({ kind: 'wait', ms: 240_000 })
    expect(codeProblemOf(new ApiError('unavailable', 0, 'network', 'x'))).toEqual({ kind: 'failed' })
  })

  it('a 429: the wait in seconds or minutes, or a challenge to solve first', () => {
    const wait = new ApiError('rate_limited', 429, 'rate_limited', 'Wait 4 minutes before asking again.', null, [issue('retryAfter', '221')])
    expect(retryAfterMs(wait)).toBe(221_000)
    expect(waitParts(221_000)).toEqual({ unit: 'minutes', count: 4 })
    expect(waitParts(42_000)).toEqual({ unit: 'seconds', count: 42 })
    expect(wantsChallenge(wait)).toBe(false)
    expect(wantsChallenge(new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [issue('challenge', 'Required.')]))).toBe(true)
    expect(retryAfterMs(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBeNull()
  })

  it('a proved sign-in refused: the problem, and the end of access when the sentence names it', () => {
    const ended = new ApiError('forbidden', 403, 'forbidden', 'Your access to the Seed A portal ended on 31/10/2026. Contact Seed A.', null, [issue('access/ENDED')])
    expect(accessOf(ended)).toEqual({ problem: 'ENDED', endedOn: '31/10/2026' })
    expect(accessOf(new ApiError('forbidden', 403, 'forbidden', 'x', null, [issue('access/PORTAL_OFF')]))).toEqual({ problem: 'PORTAL_OFF', endedOn: null })
    expect(accessOf(new ApiError('forbidden', 403, 'forbidden', 'x', null, [issue('access/SOMETHING')]))).toBeNull()
    expect(accessOf(new ApiError('signed_out', 401, 'x', 'x', null, [issue('access/PAUSED')]))).toBeNull()
  })

  it('the first visit: a name and the terms; summaries asked only while none were chosen', () => {
    expect(firstVisitProblems({ displayName: ' ', accepted: false })).toEqual({ name: 'required', terms: 'required' })
    expect(firstVisitProblems({ displayName: 'x'.repeat(121), accepted: true })).toEqual({ name: 'tooLong' })
    expect(firstVisitProblems({ displayName: 'Anna', accepted: true })).toEqual({})
    expect(asksSummaries([{ locked: true, stored: false }, { locked: false, stored: false }])).toBe(true)
    expect(asksSummaries([{ locked: false, stored: true }])).toBe(false)
  })
})

describe('the proof of work', () => {
  it('finds the same nonce as the API\'s reference, in batches', async () => {
    const digest = async (data: Uint8Array) => {
      const hash = createHash('sha256').update(data).digest()
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer
    }
    const challenge = 'pw1.portal.signin.start.abc.10.salt.mac'
    expect(await solveChallenge(challenge, 10, { digest })).toBe(referenceSolve(challenge, 10))
    expect(hasLeadingZeroBits(new Uint8Array([0, 0x0f]), 12)).toBe(true)
    expect(hasLeadingZeroBits(new Uint8Array([0, 0x1f]), 12)).toBe(false)
    expect(await solveChallenge(challenge, 30, { digest, limit: 100 })).toBeNull()
  })
})

describe('the calls', () => {
  /** A fake API: each route answers what the test says; every request is kept. */
  const fake = (answer: (method: string, url: string, body: unknown) => { status: number; body: unknown }) => {
    const seen: { method: string; url: string; body: unknown; headers: Headers }[] = []
    const api = createApiClient({
      baseUrl: '/api',
      csrfToken: () => 'csrf-1',
      fetch: (async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        seen.push({ method: String(init.method), url, body, headers: new Headers(init.headers) })
        const out = answer(String(init.method), url, body)
        return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })
    return { api, seen }
  }
  const HEAD = {
    tenant: 'seed',
    company: { id: COMPANY, code: 'SCA', name: 'Seed A' },
    branding: { companyId: COMPANY, name: 'Seed A portal', companyName: 'Seed A', logoPath: null, logoDarkPath: null, accentColour: '#1f5fa8' },
    contact: { email: 'noreply@seed.example.com' },
    legal: { it: { name: 'Seed Company A', lines: [] }, en: { name: 'Seed Company A', lines: [] } },
  }

  it('reads the head by the address, or by the link\'s company', async () => {
    const { api, seen } = fake(() => ({ status: 200, body: { head: HEAD } }))
    expect(await readHead(api, { tenant: 'seed', company: '' })).toEqual(HEAD)
    await readHead(api, { companyId: COMPANY })
    expect(seen.map((entry) => entry.url)).toEqual(['/api/branding/portal-sign-in?tenant=seed', `/api/branding/portal-sign-in?companyId=${COMPANY}`])
  })

  it('asks the CSRF cookie first, then the e-mail; a challenge is solved and sent once with the proof', async () => {
    let starts = 0
    const { api, seen } = fake((_, url) => {
      if (url.startsWith('/api/auth/csrf')) return { status: 200, body: { csrfToken: 'csrf-1' } }
      if (url.startsWith('/api/abuse/challenge')) return { status: 200, body: { challenge: 'pw1.portal.signin.start.x.8.s.m', bits: 8 } }
      starts++
      return starts === 1 ? { status: 429, body: { error: { code: 'rate_limited', message: 'x', issues: [{ path: 'challenge', message: 'Required.' }] } } } : { status: 200, body: { status: 'sent', expiresInSeconds: 900, resendAfterSeconds: 60 } }
    })
    let checked = false
    const sent = await startSignIn(api, { tenant: 'seed', company: 'SCA', email: ' anna@brand.example ' }, () => (checked = true))
    expect(sent).toEqual({ status: 'sent', expiresInSeconds: 900, resendAfterSeconds: 60 })
    expect(checked).toBe(true)
    const posts = seen.filter((entry) => entry.method === 'POST')
    expect(posts[0]!.body).toEqual({ tenant: 'seed', company: 'SCA', email: 'anna@brand.example' })
    expect(posts[1]!.body).toMatchObject({ tenant: 'seed', company: 'SCA', email: 'anna@brand.example', proof: { challenge: 'pw1.portal.signin.start.x.8.s.m' } })
    expect(posts[1]!.headers.get('x-csrf-token')).toBe('csrf-1')
    expect(seen[0]!.url).toBe('/api/auth/csrf')
    expect(seen.find((entry) => entry.url.startsWith('/api/abuse/challenge'))!.url).toBe('/api/abuse/challenge?policy=portal.signin.start')
  })

  it('a wrong code comes back as the API\'s error for the page to read', async () => {
    const { api } = fake((_, url) =>
      url.startsWith('/api/auth/csrf') ? { status: 200, body: {} } : { status: 401, body: { error: { code: 'unauthenticated', message: 'That code does not match. 3 tries left.', issues: [{ path: 'code', message: 'That code does not match. 3 tries left.' }] } } },
    )
    const error = await signInWithCode(api, { tenant: 'seed', company: 'SCA', email: 'anna@brand.example', code: '123456' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(codeProblemOf(error as ApiError)).toEqual({ kind: 'wrong', triesLeft: 3 })
  })
})

describe('SCR-026 draws every case in both languages with no key left on screen', () => {
  const LEFT_KEY = /\b(?:meta|head|email|wait|check|code|link|first|ended|paused|unknown|foot|privacy|language)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
  const View = designScreen.view as ComponentType<{ model: unknown }>

  it('the catalogue has the same keys in both languages', () => {
    const [first, ...rest] = LOCALES.map((locale) => Object.keys(CATALOGUE[locale]['portal-signin'] ?? {}).sort())
    expect(first!.length).toBeGreaterThan(50)
    for (const keys of rest) expect(keys).toEqual(first)
  })

  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal-signin', 'ds-words']) }, createElement(View, { model: item.model })))
        // Words and addresses (mailto, the notice's tab) are in the markup; no message key is.
        expect(html.replace(/(?:href|src)="[^"]*"/g, '').match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('the access words name the company and whom to ask, in the reader\'s language', () => {
    const paused = designScreen.cases.find((item) => item.id === 'paused')!
    const it = renderToString(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['portal-signin', 'ds-words']) }, createElement(View, { model: paused.model })))
    expect(it).toContain('Il tuo accesso al portale Officina Demo è sospeso. Contatta ordini@officina-demo.example.com.')
    expect(it).toContain('href="mailto:ordini@officina-demo.example.com"')
    const code = designScreen.cases.find((item) => item.id === 'code')!
    const en = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['portal-signin', 'ds-words']) }, createElement(View, { model: code.model })))
    expect(en).toContain('If anna.demo@brand.example.com is invited, we sent a link and a code. They work for 15 minutes.')
    expect(en).toContain('autoComplete="one-time-code"')
  })
})
