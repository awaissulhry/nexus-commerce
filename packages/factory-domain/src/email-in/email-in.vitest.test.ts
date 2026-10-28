import { describe, expect, it } from 'vitest'
import { assertTransition } from '../state/machine'
import {
  addressesOf,
  cleanMessageId,
  cleanSubject,
  companyDomainOf,
  inboundMachine,
  knownSender,
  MAX_INBOUND_TEXT,
  messageIdsOf,
  replyTokensOf,
  SHARED_MAIL_DOMAINS,
  sortMail,
  verdictOf,
  type SortFacts,
  type Verdicts,
} from './rules'
import { cleanInboundText, sanitiseMailHtml, textOfHtml } from './sanitise'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz'
const PASS: Verdicts = { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS', spam: 'PASS', virus: 'PASS' }
const thread = (status: 'OPEN' | 'CLOSED' = 'OPEN', partyId: string | null = 'p1', by: 'TOKEN' | 'HEADERS' = 'TOKEN') => ({ id: 't1', status, partyId, by })
const facts = (over: Partial<SortFacts> = {}): SortFacts => ({ verdicts: PASS, duplicate: false, thread: null, senderKnown: null, senderParty: null, ...over })

describe('reply addresses and headers (COL-020)', () => {
  it('reads the tokens of r-<token>@<reply domain> only, each once, in order', () => {
    const domains = ['reply.acme.example.com']
    expect(replyTokensOf([`R-${TOKEN.toUpperCase()}@Reply.Acme.Example.com`, `r-${TOKEN}@reply.acme.example.com`], domains)).toEqual([TOKEN])
    expect(replyTokensOf([`r-${TOKEN}@other.example.com`, `x-${TOKEN}@reply.acme.example.com`, 'r-short@reply.acme.example.com', `r-${TOKEN}1@reply.acme.example.com`], domains)).toEqual([])
    const second = 'zyxwvutsrqponmlkjihgfedcba'
    expect(replyTokensOf([`r-${second}@reply.acme.example.com`, `r-${TOKEN}@reply.acme.example.com`], domains)).toEqual([second, TOKEN])
  })

  it('reads Message-IDs from In-Reply-To and References, newest kept', () => {
    expect(cleanMessageId(' <a@b.example> ')).toBe('<a@b.example>')
    expect(cleanMessageId('a@b.example')).toBe('<a@b.example>')
    expect(cleanMessageId('<a b@c>')).toBeNull()
    expect(cleanMessageId(`<${'x'.repeat(400)}@b>`)).toBeNull()
    expect(messageIdsOf('<one@x.example>\r\n <two@x.example> junk <one@x.example>')).toEqual(['<one@x.example>', '<two@x.example>'])
    expect(messageIdsOf(Array.from({ length: 30 }, (_, index) => `<m${index}@x.example>`).join(' '))).toHaveLength(20)
    expect(messageIdsOf(undefined)).toEqual([])
  })

  it('cleans subjects and addresses', () => {
    expect(cleanSubject('Re:\r\n  Ordine\t42')).toBe('Re: Ordine 42')
    expect(cleanSubject('  ')).toBeNull()
    expect(addressesOf([' Buyer@Example.com', 'not an address', 'buyer@example.com', null])).toEqual(['buyer@example.com'])
    expect(verdictOf('FAIL')).toBe('FAIL')
    expect(verdictOf('MAYBE')).toBe('GRAY')
  })
})

describe('known senders (COL-022)', () => {
  const known = { contacts: ['anna@buyer.example.com', 'rider@freemail.example'], participants: ['orders@shop.example.org'] }
  // A made-up free-mail domain stands for gmail.com, libero.it and the others (SHARED_MAIL_DOMAINS).
  const shared = new Set(['freemail.example'])

  it('knows a contact, a recipient of the thread mail, and the company domain of a contact; never a shared mail domain', () => {
    expect(knownSender('anna@buyer.example.com', known, shared)).toBe('CONTACT')
    expect(knownSender('orders@shop.example.org', known, shared)).toBe('PARTICIPANT')
    expect(knownSender('luca@buyer.example.com', known, shared)).toBe('DOMAIN')
    expect(knownSender('stranger@freemail.example', known, shared)).toBeNull()
    expect(knownSender('stranger@freemail.example', known, new Set())).toBe('DOMAIN')
    expect(knownSender('someone@elsewhere.example.net', known, shared)).toBeNull()
    expect(knownSender(null, known, shared)).toBeNull()
    expect(companyDomainOf('a@freemail.example', shared)).toBeNull()
    expect(companyDomainOf('a@acme.example.com', shared)).toBe('acme.example.com')
    expect(SHARED_MAIL_DOMAINS.has('libero.it') && SHARED_MAIL_DOMAINS.has('gmail.com')).toBe(true)
  })
})

describe('where a mail goes (A1 §3.7 "Matching")', () => {
  it('a token match from a known sender joins the thread; headers likewise', () => {
    expect(sortMail(facts({ thread: thread(), senderKnown: 'CONTACT' }))).toEqual({ status: 'MATCHED', by: 'TOKEN', threadId: 't1' })
    expect(sortMail(facts({ thread: thread('OPEN', 'p1', 'HEADERS'), senderKnown: 'DOMAIN' }))).toEqual({ status: 'MATCHED', by: 'HEADERS', threadId: 't1' })
  })

  it('holds an unknown sender, a DMARC failure, spam and a closed thread for a person', () => {
    expect(sortMail(facts({ thread: thread() }))).toEqual({ status: 'HELD', reason: 'UNKNOWN_SENDER', threadId: 't1' })
    expect(sortMail(facts({ thread: thread(), senderKnown: 'CONTACT', verdicts: { ...PASS, dmarc: 'FAIL' } }))).toEqual({ status: 'HELD', reason: 'DMARC_FAIL', threadId: 't1' })
    expect(sortMail(facts({ thread: thread(), verdicts: { ...PASS, dmarc: 'FAIL' } }))).toMatchObject({ status: 'HELD', reason: 'DMARC_FAIL' })
    expect(sortMail(facts({ thread: thread(), senderKnown: 'CONTACT', verdicts: { ...PASS, spam: 'FAIL' } }))).toMatchObject({ status: 'HELD', reason: 'SPAM' })
    expect(sortMail(facts({ thread: thread('CLOSED'), senderKnown: 'CONTACT' }))).toEqual({ status: 'HELD', reason: 'THREAD_CLOSED', threadId: 't1' })
  })

  it('rejects a virus and a duplicate; a thread without a party goes to triage', () => {
    expect(sortMail(facts({ thread: thread(), senderKnown: 'CONTACT', verdicts: { ...PASS, virus: 'FAIL' } }))).toEqual({ status: 'REJECTED', reason: 'VIRUS' })
    expect(sortMail(facts({ thread: thread(), senderKnown: 'CONTACT', duplicate: true }))).toEqual({ status: 'REJECTED', reason: 'DUPLICATE' })
    expect(sortMail(facts({ thread: thread('OPEN', null), senderKnown: 'CONTACT' }))).toEqual({ status: 'TRIAGE', threadId: 't1' })
  })

  it('without a thread: a contact of one party with a passing DMARC joins the party thread; anything less waits in triage', () => {
    const senderParty = { partyId: 'p1', thread: { id: null, status: 'OPEN' as const } }
    expect(sortMail(facts({ senderParty }))).toEqual({ status: 'MATCHED', by: 'SENDER', threadId: null })
    expect(sortMail(facts({ senderParty, verdicts: { ...PASS, dmarc: 'GRAY' } }))).toEqual({ status: 'TRIAGE', threadId: null })
    expect(sortMail(facts({ senderParty: { partyId: 'p1', thread: null } }))).toEqual({ status: 'TRIAGE', threadId: null })
    expect(sortMail(facts({ senderParty: { partyId: 'p1', thread: { id: 't9', status: 'CLOSED' } } }))).toEqual({ status: 'HELD', reason: 'THREAD_CLOSED', threadId: 't9' })
    expect(sortMail(facts())).toEqual({ status: 'TRIAGE', threadId: null })
  })

  it('moves only along the machine', () => {
    expect(() => assertTransition(inboundMachine, 'RECEIVED', 'FETCHED')).not.toThrow()
    expect(() => assertTransition(inboundMachine, 'HELD', 'TRIAGE')).not.toThrow()
    expect(() => assertTransition(inboundMachine, 'MATCHED', 'TRIAGE')).toThrow()
    expect(() => assertTransition(inboundMachine, 'TRIAGE', 'HELD')).toThrow()
    expect(() => assertTransition(inboundMachine, 'REJECTED', 'TRIAGE')).toThrow()
  })
})

describe('safe rendering (COL-026)', () => {
  it('drops scripts, handlers, forms, frames and style sheets; keeps formatting', () => {
    const html = sanitiseMailHtml(
      '<html><head><style>body{background:url(https://x.example/t.png)}</style><script>alert(1)</script></head><body>' +
        '<p onclick="steal()" class="x" style="color:#c00; position:fixed; background-image:url(https://x.example/a.png)">Buongiorno <b>Anna</b></p>' +
        '<form action="https://x.example"><input name="iban"></form><iframe src="https://x.example"></iframe><svg><script>alert(2)</script></svg>' +
        '<a href="javascript:alert(3)">click</a> <a href="https://shop.example.com/o/1" onmouseover="x()">order</a> <a href="mailto:a@b.example">mail</a>' +
        '</body></html>after',
    )!
    expect(html).not.toMatch(/script|alert|onclick|onmouseover|steal|<style|<form|<input|<iframe|<svg|position|url\(|class=|javascript|after/i)
    expect(html).toContain('<p style="color:#c00">Buongiorno <b>Anna</b></p>')
    expect(html).toContain('<a rel="noopener noreferrer nofollow" target="_blank">click</a>')
    expect(html).toContain('<a href="https://shop.example.com/o/1" rel="noopener noreferrer nofollow" target="_blank">order</a>')
    expect(html).toContain('href="mailto:a@b.example"')
  })

  it('never loads a picture by itself', () => {
    const html = sanitiseMailHtml('<img src="https://track.example.com/p.gif" width="1" alt="x"><img src="cid:logo@x"><img src="data:image/svg+xml;base64,PHN2Zz4=">')!
    expect(html).toBe('<img alt="x" width="1" data-remote-src="https://track.example.com/p.gif" /><img data-cid="logo@x" /><img />')
    expect(sanitiseMailHtml('<script>only</script>')).toBeNull()
    expect(sanitiseMailHtml(null)).toBeNull()
  })

  it('makes text of HTML and cleans text', () => {
    expect(textOfHtml('<p>Ciao&nbsp;Anna &amp; Luca</p><div>riga 2<br>riga 3</div><script>x()</script>')).toBe('Ciao Anna & Luca\nriga 2\nriga 3\n')
    expect(cleanInboundText('a\r\nb \u0007\n')).toBe('a\nb')
    const long = cleanInboundText('x'.repeat(MAX_INBOUND_TEXT + 10))
    expect(long.length).toBeLessThanOrEqual(MAX_INBOUND_TEXT)
    expect(long.endsWith('…')).toBe(true)
  })
})
