import { readFileSync } from 'node:fs'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { everyCase, leftKeys, renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { BRAND_ALPHA } from '../../../lib/testing/two-brands'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { summarySchema, type RecordSummary } from './api'
import { designScreen } from './fixtures'
import { RecordSummaryView } from './view/RecordSummaryView'
import { linkWords, namesRecord, openerOf, parentHrefOf, partyRoleOf, recordLabelOf, recordName, stateTone, SUMMARY_NS, SUMMARY_RIGHT, summaryStateOf, wordsIn } from './model'

/**
 * B-TH-272 — the generic record page (SCR-006-generic; threads plan PL5; O-REC-ANY.summary-F01, O-REC-ANY.thread-F01; walls W26,
 * W34 behind the API's T34 / T09): the summary in the reader's scope (the parent a link only when the API names it), 404 in neutral
 * words, the type and state in the page's language, the name's fallbacks, and every design case in Italian and English with no key
 * left on screen. The container mounts the office's thread only once the record is readable, full page (no RecordFrame dock).
 */

const W = (en: string, it: string) => ({ en, it })
const summary = (over: Partial<RecordSummary> = {}): RecordSummary => ({
  recordType: 'Ddt',
  recordId: 'd1',
  type: W('Delivery note', 'Documento di trasporto'),
  label: 'DDT-2026-0042',
  theirRef: null,
  state: { code: 'ISSUED', words: W('Issued', 'Emesso') },
  parent: null,
  ...over,
})
const NO_OPENER = { label: null, companyId: null, siteId: null }
const view = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)!.model

describe('the summary answer (B-TH-076) as the page reads it', () => {
  // ---- follow-up (th9-web-b): the office answer names the record's party; a portal-shaped answer without it still reads (absent).
  it('reads the record’s party of the office answer, null for none, absent when the answer has none', () => {
    const base = { recordType: 'SalesOrder', recordId: 'o1', type: W('Sales order', 'Ordine di vendita'), label: 'SO-1', state: null, parent: null }
    expect(summarySchema.parse({ summary: { ...base, party: { id: 'p1', name: BRAND_ALPHA.tradeName } } }).summary.party).toEqual({ id: 'p1', name: BRAND_ALPHA.tradeName })
    expect(summarySchema.parse({ summary: { ...base, party: null } }).summary.party).toBeNull()
    expect(summarySchema.parse({ summary: base }).summary.party).toBeUndefined()
  })
  // ---- end follow-up
  it('reads the office answer; their reference is null when the API leaves it out; a parent or none', () => {
    const answer = summarySchema.parse({ summary: { recordType: 'Ddt', recordId: 'd1', type: W('Delivery note', 'Documento di trasporto'), label: 'DDT-1', state: null, parent: null, extra: 'ignored' } })
    expect(answer.summary.theirRef).toBeNull()
    expect(answer.summary.parent).toBeNull()
    expect(answer.summary.state).toBeNull()
  })

  it('a 404 is "missing" (the same words whether it does not exist or is outside the scope), a 403 "no right", the rest a problem', () => {
    expect(summaryStateOf({ kind: 'not_found' })).toBe('missing')
    expect(summaryStateOf({ kind: 'forbidden' })).toBe('noRight')
    expect(summaryStateOf({ kind: 'unavailable' })).toBe('error')
    expect(summaryStateOf(new Error('network'))).toBe('error')
    expect(SUMMARY_RIGHT).toBe('threads.read')
  })
})

describe('the record in words', () => {
  it('"<type> <number>" in the page’s language; the type alone without a number', () => {
    expect(recordName({ summary: summary(), opener: NO_OPENER, type: 'Ddt', id: 'd1', locale: 'en' })).toBe('Delivery note DDT-2026-0042')
    expect(recordName({ summary: summary(), opener: NO_OPENER, type: 'Ddt', id: 'd1', locale: 'it' })).toBe('Documento di trasporto DDT-2026-0042')
    expect(recordName({ summary: summary({ label: null }), opener: NO_OPENER, type: 'Ddt', id: 'd1', locale: 'en' })).toBe('Delivery note')
    expect(wordsIn(W('Issued', 'Emesso'), 'it')).toBe('Emesso')
  })

  it('before the summary: the opener’s label, else the type code and the id’s start (never an empty name)', () => {
    expect(recordName({ summary: null, opener: { ...NO_OPENER, label: 'DDT-2026-0042' }, type: 'Ddt', id: 'abcdef0123456789', locale: 'en' })).toBe('DDT-2026-0042')
    expect(recordName({ summary: null, opener: NO_OPENER, type: 'Ddt', id: 'abcdef0123456789', locale: 'en' })).toBe('Ddt abcdef01')
    expect(recordLabelOf(summary(), { ...NO_OPENER, label: 'old' }, 'x')).toBe('DDT-2026-0042')
    expect(recordLabelOf(summary({ label: null }), { ...NO_OPENER, label: 'from the opener' }, 'x')).toBe('from the opener')
    expect(recordLabelOf(null, NO_OPENER, 'Delivery note')).toBe('Delivery note')
  })

  it('the opener’s terms (?label=&company=&site=) keep working; blanks are none', () => {
    expect(openerOf(new URLSearchParams('label=DDT-1&company=c1&site=s1'))).toEqual({ label: 'DDT-1', companyId: 'c1', siteId: 's1' })
    expect(openerOf(new URLSearchParams('label=%20'))).toEqual(NO_OPENER)
    expect(openerOf(null)).toEqual(NO_OPENER)
  })

  it('the ONE pill’s tone follows the state; an unknown state is neutral (its words still show)', () => {
    expect(stateTone('DELIVERED')).toBe('success')
    expect(stateTone('ON_HOLD')).toBe('warning')
    expect(stateTone('REJECTED')).toBe('danger')
    expect(stateTone('IN_PRODUCTION')).toBe('info')
    expect(stateTone('DRAFT')).toBe('neutral')
    expect(stateTone('SOME_NEW_STATE')).toBe('neutral')
  })
})

describe('the parent, only in the reader’s scope (X-G01)', () => {
  it('no parent from the API → no link (never a guessed one)', () => {
    expect(parentHrefOf(summary({ parent: null }), '/w/DEMO', OFFICE_PAGES)).toBeNull()
    expect(parentHrefOf(null, '/w/DEMO', OFFICE_PAGES)).toBeNull()
  })

  it('a parent with its own office page opens there; one without opens its generic page with its label', () => {
    const order = summary({ parent: { recordType: 'SalesOrder', recordId: 'so1', type: W('Sales order', 'Ordine di vendita'), label: 'SO-2026-0101' } })
    expect(parentHrefOf(order, '/w/DEMO', OFFICE_PAGES)).toBe('/w/DEMO/sales/orders/so1')
    const unknown = summary({ parent: { recordType: 'NoPageYet', recordId: 'x1', type: W('Thing', 'Cosa'), label: 'T-1' } })
    expect(parentHrefOf(unknown, '/w/DEMO', OFFICE_PAGES)).toBe('/w/DEMO/records/NoPageYet/x1?label=T-1')
    expect(linkWords(order.parent!, 'en')).toBe('Sales order SO-2026-0101')
    expect(linkWords({ ...order.parent!, label: null }, 'it')).toBe('Ordine di vendita')
  })
})

describe('the thread’s party and live hints', () => {
  it('whom the party is to us: customer or brand, supplier or workshop, else a partner', () => {
    expect(partyRoleOf(['CUSTOMER'])).toBe('customer')
    expect(partyRoleOf(['BRAND'])).toBe('customer')
    expect(partyRoleOf(['SUPPLIER'])).toBe('supplier')
    expect(partyRoleOf(['SUBCONTRACTOR'])).toBe('supplier')
    expect(partyRoleOf(['CUSTOMER', 'SUPPLIER'])).toBe('partner')
    expect(partyRoleOf(['CARRIER'])).toBe('partner')
  })

  it('a live change re-reads the summary only when it names the record', () => {
    expect(namesRecord({ recordId: 'd1', status: 'ISSUED' }, 'd1')).toBe(true)
    expect(namesRecord({ recordId: 'd2' }, 'd1')).toBe(false)
    expect(namesRecord({}, 'd1')).toBe(false)
  })
})

describe('the page (SCR-006-generic)', () => {
  it('every case in Italian and English: no key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, ['band', 'summary', 'missing', 'noRight', 'failed', 'thread']), `${id} (${locale})`).toEqual([])
  })

  it('with a party: the type and number, the API’s state words, the parent as a real link, the summary beside the thread', () => {
    const html = renderView(view, caseOf('with-party'))
    const text = textOf(html)
    expect(text).toContain('Delivery note DDT-2026-0042')
    expect(text).toContain('Issued')
    expect(text).toContain(`Part of Sales order ${BRAND_ALPHA.numbers.order}`)
    expect(html).toContain(`href="/w/DEMO/sales/orders/${BRAND_ALPHA.ids.order}"`)
    expect(html).toContain('aria-label="About this record"')
    expect(html).toContain('aria-label="Thread of Delivery note DDT-2026-0042"')
    const it = textOf(renderView(view, caseOf('with-party'), 'it'))
    expect(it).toContain('Documento di trasporto DDT-2026-0042')
    expect(it).toContain('Emesso')
  })

  it('no parent: no "Part of"; no number and no state: the type alone, "No number", no pill', () => {
    expect(textOf(renderView(view, caseOf('notes-only')))).not.toContain('Part of')
    expect(textOf(renderView(view, caseOf('no-number-no-state')))).toContain('Request for a yes')
    const bare = renderView(RecordSummaryView, { summary: summary({ label: null, state: null }), parentHref: null })
    expect(textOf(bare)).toContain('No number')
    expect(bare).not.toContain('nds-pill')
    expect(textOf(bare)).not.toContain('Part of')
  })

  it('404: "You cannot see this record", the way Home, no thread and no summary', () => {
    const html = renderView(view, caseOf('missing'))
    expect(textOf(html)).toContain('You cannot see this record')
    expect(textOf(html)).toContain('Back to Home')
    expect(html).not.toContain('Thread of')
    expect(html).not.toContain('About this record')
    expect(textOf(renderView(view, caseOf('missing'), 'it'))).toContain('Non puoi vedere questo record')
  })

  it('no right: the right in words, never its code; reading shows the opener’s label; a problem offers Try again', () => {
    const noRight = textOf(renderView(view, caseOf('no-right')))
    expect(noRight).not.toContain('threads.read')
    expect(noRight).toContain('You cannot read this record')
    expect(textOf(renderView(view, caseOf('reading')))).toContain('DDT-2026-0042')
    expect(textOf(renderView(view, caseOf('error')))).toContain('Try again')
  })

  it('the catalogue has the same keys in Italian and English', () => {
    const en = Object.keys(CATALOGUE.en[SUMMARY_NS] ?? {}).sort()
    const it = Object.keys(CATALOGUE.it[SUMMARY_NS] ?? {}).sort()
    expect(en.length).toBeGreaterThan(0)
    expect(it).toEqual(en)
  })
})

describe('the container (record-summary/RecordPage.tsx)', () => {
  const source = readFileSync(new URL('./RecordPage.tsx', import.meta.url), 'utf8')

  it('reads the summary first and mounts the office thread full page only once the record is readable (no RecordFrame dock)', () => {
    expect(source).toContain('readRecordSummary(api, record, signal)')
    expect(source).toMatch(/const thread = ready \? \(\s*<OfficeRecordThread\s+docked/)
    expect(source).not.toContain('<RecordFrame')
    expect(source).toContain('<GenericRecordView')
  })

  // ---- follow-up (th9-web-b): the party comes with the summary (office only), so "Reply to <party>" works before the first message.
  it('names "Reply to <party>" from the summary’s party — before any message —, its role only with parties.view, else “partner”', () => {
    expect(source).toContain('summary?.party ?? null')
    expect(source).not.toContain('readThreadParty')
    expect(source).toContain("session.permissions.includes('parties.view')")
    expect(source).toContain('if (!summaryPartyId || !seesParties) return')
    expect(source).toContain("role?.partyId === summaryParty.id ? role.role : 'partner'")
    expect(source).toContain('party={party ? { id: party.id, name: party.name } : null}')
  })
  // ---- end follow-up

  it('keeps the project’s own address (B-TH-249) and prints the thread with ThreadPrint (B-TH-280)', () => {
    expect(source).toContain("if (type === 'Project') return <ToProjectPage id={id} />")
    expect(source).toContain('<ThreadPrint record={threadRecord}')
    expect(source).not.toContain('RecordPanels')
  })
})
