/**
 * The shared mail sender never puts a character an HTTP header cannot carry in a header, and never strips one.
 *
 * Live (the daily Claude ads report e-mail): "Cannot convert argument to a ByteString because the character at index 10
 * has a value of 8230 which is greater than 255". 8230 is "…". The request's only dynamic header is
 * `Authorization: Bearer <key>`: "Bearer " is 7 characters and "re_" 3, so index 10 is the 4th character of a shortened
 * placeholder key "re_…" — the report text (subject "Claude ads · Xavia Racing — …") goes in the JSON body. Proven here:
 *   · the exact error comes from that header, and the key is refused (named, never echoed) before fetch;
 *   · a report with "…", "€", "à" in its subject, sender name and bodies is sent: every request header is a ByteString
 *     (the mock builds `new Headers`, which throws as fetch does), and the text arrives in the JSON body as written;
 *   · the message's own extra headers (raw mail header lines, ASCII by law) are RFC 2047 encoded, and decode back whole.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sendEmail, mailHeaderValue, __test } from './transport.js'

const saved = { enable: process.env.NEXUS_ENABLE_OUTBOUND_EMAILS, key: process.env.RESEND_API_KEY, fetch: globalThis.fetch }
let calls: Array<{ headers: Headers; body: Record<string, unknown> }> = []

beforeEach(() => {
  calls = []
  process.env.NEXUS_ENABLE_OUTBOUND_EMAILS = 'true'
  process.env.RESEND_API_KEY = 're_Test1234567890abcdef'
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    // Exactly what fetch does with a header value: a character above 255 throws "Cannot convert argument to a ByteString".
    const headers = new Headers(init?.headers)
    calls.push({ headers, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = saved.fetch
  for (const [k, v] of [['NEXUS_ENABLE_OUTBOUND_EMAILS', saved.enable], ['RESEND_API_KEY', saved.key]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** RFC 2047 "B" encoded-words back to text (what a mail client does). */
const decode = (v: string) => v.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=(?:\s+(?==\?UTF-8\?B\?))?/g, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'))
const REPORT = {
  to: ['owner@example.com'],
  subject: 'Claude ads · Xavia Racing — 3 ran, 2 wait for you · 1 problem…',
  from: 'Xavia Società à <ship@example.com>',
  html: '<p>Spesa €12,50 — più vendite… già</p>',
  text: 'Spesa €12,50 — più vendite… già',
  tag: 'claude-ads-run',
}

describe('the live error came from the key in the Authorization header, not from the report', () => {
  it('🔴 "Bearer re_…" is the exact error: the character at index 10, value 8230', () => {
    expect(() => new Headers({ Authorization: 'Bearer re_…' }))
      .toThrow('Cannot convert argument to a ByteString because the character at index 10 has a value of 8230 which is greater than 255')
  })

  it('a placeholder key is refused before fetch, named and never echoed', async () => {
    process.env.RESEND_API_KEY = 're_…'
    const r = await sendEmail(REPORT)
    expect(r).toMatchObject({ ok: false, provider: 'resend', dryRun: false })
    expect(r.error).toContain('RESEND_API_KEY is not a real key')
    expect(r.error).not.toContain('re_…')
    expect(calls).toHaveLength(0)
  })
})

describe('a report with "…", "€", "à" is sent with its text whole', () => {
  it('🔴 every request header is a ByteString; subject, sender, bodies arrive in the JSON body as written', async () => {
    const r = await sendEmail(REPORT)
    expect(r).toMatchObject({ ok: true, provider: 'resend', messageId: 'msg-1' })
    expect(calls).toHaveLength(1)
    const [{ headers, body }] = calls
    expect([...headers.keys()].sort()).toEqual(['authorization', 'content-type'])
    expect(headers.get('authorization')).toBe('Bearer re_Test1234567890abcdef')
    expect(body).toMatchObject({ subject: REPORT.subject, from: REPORT.from, html: REPORT.html, text: REPORT.text, to: REPORT.to })
  })

  it('the message’s own headers are RFC 2047 encoded (ASCII on the wire) and decode back to the same text', async () => {
    const value = 'Rapporto … €12,50 — già'
    await sendEmail({ ...REPORT, headers: { 'X-Nexus-Report': value, 'List-Unsubscribe': '<https://example.com/u?t=1>' } })
    const sent = calls[0].body.headers as Record<string, string>
    expect(sent['X-Nexus-Report']).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=( =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)*$/)
    expect(decode(sent['X-Nexus-Report'])).toBe(value)
    // An ASCII header (the one-click unsubscribe) is untouched.
    expect(sent['List-Unsubscribe']).toBe('<https://example.com/u?t=1>')
  })
})

describe('mailHeaderValue', () => {
  it.each(['…', '€', 'à', 'Già pronto … costa €5', 'Claude ads · Xavia Racing — 3 ran'])('%s → ASCII, decodes back whole', (value) => {
    const out = mailHeaderValue(value)
    expect(out).toMatch(/^[\x20-\x7e]+$/)
    expect(decode(out)).toBe(value)
  })

  it('a long value is split into words of at most 75 characters, never inside a character', () => {
    const value = 'àèìòù€…'.repeat(20)
    const out = mailHeaderValue(value)
    const words = out.split(' ')
    expect(words.length).toBeGreaterThan(1)
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75)
      // Each word alone is whole UTF-8: a split character would decode to U+FFFD.
      expect(decode(w)).not.toContain('�')
    }
    expect(decode(out)).toBe(value)
  })

  it('ASCII stays as it is; a line break (which would start a new header) becomes one space', () => {
    expect(mailHeaderValue('<mailto:u@example.com>, <https://example.com/u>')).toBe('<mailto:u@example.com>, <https://example.com/u>')
    expect(mailHeaderValue('one\r\n  two\nthree')).toBe('one two three')
    expect(decode(mailHeaderValue('già\r\nfatto'))).toBe('già fatto')
  })
})

describe('header names', () => {
  it('a name no header can have refuses the send, naming it, and fetch is never called', async () => {
    const r = await sendEmail({ ...REPORT, headers: { 'X-Bad:Name': 'x' } })
    expect(r).toMatchObject({ ok: false, provider: 'resend', dryRun: false })
    expect(r.error).toContain('"X-Bad:Name"')
    expect(calls).toHaveLength(0)
    expect(__test.isHeaderName('List-Unsubscribe-Post')).toBe(true)
    expect(__test.isHeaderName('Prezzo€')).toBe(false)
  })
})
