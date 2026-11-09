import { describe, expect, it } from 'vitest'
import { MAX_BODY_LENGTH } from '@nexus/factory-domain/threads/rules'
import { COMPOSER_REASONS } from '@nexus/factory-domain/threads/partner/rules'
import type { EmailSettings, PortalTask } from './api'
import {
  addressNamesParty,
  allNonEssentialOff,
  badgesOf,
  emailChanges,
  emailDraftOf,
  idleEndAfterCall,
  kindsOf,
  noticesOf,
  PORTAL_IDLE_MS,
  portalKeyAction,
  portalLink,
  portalPathOf,
  portalPrefix,
  RESERVED_SEGMENTS,
  sessionEndOf,
  shownNotice,
  signInHref,
  stillThereAt,
  staying,
  taskGroupsOf,
  withNonEssential,
} from './model'
import { recordTypeKey, THREAD_BODY_LIMIT, threadHeldKey } from './thread-model'

const PARTY = { id: '0190f0e2-1111-7000-8000-000000000001', code: 'SEED-C1' }

describe('the portal address (B-W2b-173)', () => {
  it('names the party by its code in any case, or by its id; never another', () => {
    expect(addressNamesParty('SEED-C1', PARTY)).toBe(true)
    expect(addressNamesParty('seed-c1', PARTY)).toBe(true)
    expect(addressNamesParty(PARTY.id, PARTY)).toBe(true)
    expect(addressNamesParty('SEED-S1', PARTY)).toBe(false)
    expect(addressNamesParty('%E0%A4%A', PARTY)).toBe(false)
  })

  it('keeps the sign-in and unsubscribe pages apart from any party', () => {
    expect([...RESERVED_SEGMENTS]).toEqual(['signin', 'unsubscribe'])
  })

  it('splits the portal path off its prefix; Home is /', () => {
    const prefix = portalPrefix('SEED C1')
    expect(prefix).toBe('/p/SEED%20C1')
    expect(portalPathOf(prefix, prefix)).toBe('/')
    expect(portalPathOf(`${prefix}/`, prefix)).toBe('/')
    expect(portalPathOf(`${prefix}/open/SalesOrder/x`, prefix)).toBe('/open/SalesOrder/x')
  })

  it('sends a person without a session to sign in and back to the whole address, anchor included', () => {
    expect(signInHref('/p/SEED-C1/open/Quote/x#task:t1')).toBe('/p/signin?next=%2Fp%2FSEED-C1%2Fopen%2FQuote%2Fx%23task%3At1')
    expect(signInHref(null)).toBe('/p/signin')
  })

  it("tells the sign-in why the session ended (B-W2b-164's banner), keeping next; a chosen sign-out says nothing", () => {
    expect(signInHref('/p/SEED-C1/orders', 'idle')).toBe('/p/signin?next=%2Fp%2FSEED-C1%2Forders&ended=idle')
    expect(signInHref('/p/SEED-C1/open/Quote/x#task:t1', 'revoked')).toBe('/p/signin?next=%2Fp%2FSEED-C1%2Fopen%2FQuote%2Fx%23task%3At1&ended=revoked')
    expect(signInHref(null, 'idle')).toBe('/p/signin?ended=idle')
    expect(signInHref('/p/SEED-C1', null)).toBe('/p/signin?next=%2Fp%2FSEED-C1')
    // What the sign-in page reads back.
    const read = new URL(signInHref('/p/SEED-C1/orders?q=a b', 'idle'), 'https://portal.example.test').searchParams
    expect([read.get('next'), read.get('ended')]).toEqual(['/p/SEED-C1/orders?q=a b', 'idle'])
  })

  it("keeps the API's own links and puts a bare one under the prefix", () => {
    expect(portalLink('/p/SEED-C1/open/Quote/x#task:1', '/p/OTHER')).toBe('/p/SEED-C1/open/Quote/x#task:1')
    expect(portalLink('/open/Quote/x', '/p/SEED-C1')).toBe('/p/SEED-C1/open/Quote/x')
  })
})

describe('who reads the portal as which kind', () => {
  const me = (partnerKind: string | null, kinds: string[]) => ({ user: { id: 'u', email: 'e', displayName: 'n', locale: 'it', partnerKind, accessUntil: null }, party: { id: 'p', name: 'P', code: 'P', kinds } })
  it('a person by their own kind; an office preview by every kind of the party, in a fixed order', () => {
    expect(kindsOf(me('SUPPLIER', ['SUPPLIER', 'SUBCONTRACTOR']))).toEqual(['SUPPLIER'])
    expect(kindsOf(me(null, ['SUBCONTRACTOR', 'SUPPLIER']))).toEqual(['SUPPLIER', 'SUBCONTRACTOR'])
    expect(kindsOf(me(null, []))).toEqual([])
    expect(kindsOf(me('SOMETHING', ['CUSTOMER']))).toEqual(['CUSTOMER'])
  })
})

describe('the notices: one banner, the most serious first', () => {
  it('orders the connection before the preview, the end of access, and a read-only record', () => {
    const all = noticesOf({ preview: { viewer: 'A', company: 'C', party: 'P' }, offlineSince: '10:42', accessEnds: '12/11/2026', record: { key: 'notice.readOnly' } })
    expect(all.map((notice) => notice.id)).toEqual(['offline', 'access-ends', 'preview', 'record'])
    expect(noticesOf({})).toEqual([])
  })

  it('keeps a dismissal for its value only: a new end date shows again; a preview cannot be dismissed', () => {
    const notices = noticesOf({ accessEnds: '12/11/2026', preview: { viewer: 'A', company: 'C', party: 'P' } })
    expect(shownNotice(notices, {})?.id).toBe('access-ends')
    expect(shownNotice(notices, { 'access-ends': '12/11/2026' })?.id).toBe('preview')
    expect(shownNotice(noticesOf({ accessEnds: '20/11/2026' }), { 'access-ends': '12/11/2026' })?.id).toBe('access-ends')
    expect(notices.find((notice) => notice.id === 'preview')?.value).toBeUndefined()
  })
})

describe('Still there? (the idle sign-out after 30 minutes)', () => {
  const t0 = Date.parse('2026-11-08T08:00:00Z')
  const absolute = t0 + 12 * 60 * 60_000
  it('an answer moves the idle end to at least 29 minutes later (the API slides it once a minute), never back, never past 12 hours', () => {
    expect(idleEndAfterCall(t0 + PORTAL_IDLE_MS, t0 + 10 * 60_000, absolute)).toBe(t0 + 39 * 60_000)
    expect(idleEndAfterCall(t0 + 50 * 60_000, t0 + 10 * 60_000, absolute)).toBe(t0 + 50 * 60_000)
    expect(idleEndAfterCall(t0, absolute - 60_000, absolute)).toBe(absolute)
  })

  it('asks two minutes before the end; Stay helps only while the idle end comes first', () => {
    expect(stillThereAt(t0 + PORTAL_IDLE_MS, absolute)).toBe(t0 + 28 * 60_000)
    expect(stillThereAt(absolute + 60_000, absolute)).toBe(absolute - 2 * 60_000)
    expect(staying(t0 + PORTAL_IDLE_MS, absolute)).toBe(true)
    expect(staying(absolute, absolute)).toBe(false)
  })

  it('says why the session ended: the idle clock ran out → idle; refused before it, or the 12 hours → revoked', () => {
    const idleEnd = t0 + PORTAL_IDLE_MS
    expect(sessionEndOf(idleEnd, idleEnd, absolute)).toBe('idle')
    expect(sessionEndOf(idleEnd + 5_000, idleEnd, absolute)).toBe('idle')
    // The API answered 401 ten minutes before the frame's idle end: the office (or another tab) ended it.
    expect(sessionEndOf(idleEnd - 10 * 60_000, idleEnd, absolute)).toBe('revoked')
    // The idle end clamped to the 12 hours: not idleness.
    expect(sessionEndOf(absolute, absolute, absolute)).toBe('revoked')
  })
})

const task = (over: Partial<PortalTask>): PortalTask => ({
  id: 't1',
  kind: 'CONFIRM_PO',
  verb: { it: 'Conferma', en: 'Confirm' },
  words: { it: "Conferma l'ordine PO-1", en: 'Confirm order PO-1' },
  record: { type: 'PurchaseOrder', id: 'po1', label: 'PO-1' },
  dueAt: '2026-11-10T12:00:00.000Z',
  due: 'SOON',
  askedBy: null,
  status: 'OPEN',
  area: 'orders',
  version: 1,
  link: '/p/SEED-S1/open/PurchaseOrder/po1#task:t1',
  canMarkDone: false,
  canUndo: false,
  ...over,
})

describe('the one task list (COL-043) as the DS ActionList takes it', () => {
  it('groups by kind in the order read, in the page language; a request with no answer of its own runs in place', () => {
    const groups = taskGroupsOf([task({}), task({ id: 't2', kind: 'UPLOAD_DOCUMENT', canMarkDone: true, due: 'NONE', dueAt: null, askedBy: 'Anna' }), task({ id: 't3', due: 'OVERDUE' })], 'en', '/p/SEED-S1')
    expect(groups.map((group) => [group.kind, group.rows.map((row) => row.id)])).toEqual([
      ['CONFIRM_PO', ['t1', 't3']],
      ['UPLOAD_DOCUMENT', ['t2']],
    ])
    expect(groups[0].rows[0]).toMatchObject({ title: 'Confirm order PO-1', verb: 'Confirm', act: 'link', href: '/p/SEED-S1/open/PurchaseOrder/po1#task:t1', due: { state: 'soon', at: '2026-11-10T12:00:00.000Z' } })
    expect(groups[0].rows[1].due?.state).toBe('overdue')
    expect(groups[1].rows[0]).toMatchObject({ act: 'inline', due: null, askedBy: 'Anna' })
  })

  it('a badge only for what waits (never 0); nothing known: no badges at all', () => {
    expect(badgesOf(null, 'it')).toBeNull()
    expect(badgesOf([{ area: 'orders', count: 2, words: { it: '2 da confermare', en: '2 to confirm' } }, { area: 'documents', count: 0, words: { it: '', en: '' } }], 'it')).toEqual({ orders: { count: 2, words: '2 da confermare' } })
  })
})

const SETTINGS: EmailSettings = {
  nonEssentialOff: false,
  topics: [
    { topic: 'ORDERS', frequency: 'INSTANT', locked: true, stored: false, words: { it: 'Ordini', en: 'Orders' }, reason: { it: 'r', en: 'r' } },
    { topic: 'DATES', frequency: 'DAILY', locked: false, stored: false, words: { it: 'Date', en: 'Dates' }, reason: null },
    { topic: 'MESSAGES', frequency: 'INSTANT', locked: false, stored: true, words: { it: 'Messaggi', en: 'Messages' }, reason: null },
  ],
}

describe('E-mail settings (COL-063): the draft and what a save sends', () => {
  it('sends only the topics changed, never a locked one', () => {
    const draft = { ...emailDraftOf(SETTINGS), ORDERS: 'OFF' as const, DATES: 'WEEKLY' as const }
    expect(emailChanges(SETTINGS, draft)).toEqual([{ topic: 'DATES', frequency: 'WEEKLY' }])
    expect(emailChanges(SETTINGS, emailDraftOf(SETTINGS))).toEqual([])
  })

  it('the one switch turns every non-essential topic off, and back to a daily summary', () => {
    const off = withNonEssential(SETTINGS, emailDraftOf(SETTINGS), true)
    expect(off).toEqual({ ORDERS: 'INSTANT', DATES: 'OFF', MESSAGES: 'OFF' })
    expect(allNonEssentialOff(SETTINGS, off)).toBe(true)
    expect(withNonEssential(SETTINGS, off, false)).toEqual({ ORDERS: 'INSTANT', DATES: 'DAILY', MESSAGES: 'DAILY' })
  })
})

describe('the keys', () => {
  const chords = { h: '/', o: '/orders', d: '/documents' }
  it('/ searches, ? lists the keys, g then a letter goes to an area; anything else is not the portal’s', () => {
    expect(portalKeyAction('/', false, chords)).toEqual({ kind: 'search' })
    expect(portalKeyAction('?', false, chords)).toEqual({ kind: 'shortcuts' })
    expect(portalKeyAction('g', false, chords)).toEqual({ kind: 'chord' })
    expect(portalKeyAction('o', true, chords)).toEqual({ kind: 'go', href: '/orders' })
    expect(portalKeyAction('x', true, chords)).toBeNull()
    expect(portalKeyAction('o', false, chords)).toBeNull()
  })
})

describe('the conversation’s rules, said in our words', () => {
  it('counts toward the domain’s own limit and says every composer reason', () => {
    expect(THREAD_BODY_LIMIT).toBe(MAX_BODY_LENGTH)
    for (const reason of COMPOSER_REASONS) expect(threadHeldKey(reason)).toBe(`thread.held.${reason}`)
    expect(threadHeldKey('SOMETHING_NEW')).toBe('thread.held.other')
    expect(recordTypeKey('SalesOrder')).toBe('record.type.SalesOrder')
    expect(recordTypeKey('Unknown')).toBe('record.type.other')
  })
})

describe('the band a page fills', () => {
  it('calls the page’s latest callbacks, never a stale closure', async () => {
    const { bandCalling } = await import('./frame')
    const calls: string[] = []
    const latest = { current: { actions: [{ id: 'send', label: 'Send', onClick: () => calls.push('first') }], more: [{ id: 'pdf', label: 'PDF', onSelect: () => calls.push('pdf-first') }] } }
    const band = bandCalling(latest)!
    latest.current = { actions: [{ id: 'send', label: 'Send', onClick: () => calls.push('second') }], more: [{ id: 'pdf', label: 'PDF', onSelect: () => calls.push('pdf-second') }] }
    band.actions![0].onClick!()
    band.more![0].onSelect!()
    expect(calls).toEqual(['second', 'pdf-second'])
    expect(bandCalling({ current: null })).toBeNull()
  })
})
