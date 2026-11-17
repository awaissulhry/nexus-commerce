import { readFileSync } from 'node:fs'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { permissionCheck } from '../../../lib/session/session'
import { firstOfficePage, OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { takesParty } from '../_shared/customer/model'
import { listQueryOf, termsOf } from '../work-orders/list/model'
import { officeArea } from '../nav'
import { ROW_KINDS, WIP_STAGES, type Issues, type Overview } from './api'
import { ALPHA, BETA, designScreen, EVERY_ANSWER, LIMITED_ANSWER, LIMITED_ISSUES } from './fixtures'
import {
  approvalsDoor,
  customerCodesOf,
  EXCEPTION_COLUMNS,
  exceptionRows,
  issueLineOf,
  issuesSummary,
  nextIssuesLimit,
  nothingOpen,
  overviewAddress,
  overviewQueryOf,
  overviewTermsOf,
  overviewTouches,
  STAGE_VIEW,
  tilesOf,
  urgentFooter,
  urgentLineOf,
  wipRows,
  workOrdersDoor,
  type OverviewTerms,
} from './model'

/**
 * F-PR-04 — Production › Overview (production plan §5; 06-tree A.1; B-PR-33's read): the address (the customer filter and Only mine),
 * every figure as a door to Work orders with the same filter (the list reads it back into the very API filter B-PR-33's PG test counts
 * against), Customer requests to Home › Approvals, WIP by stage, Most urgent "10 of N · Show all", the open issues, the live rule, the
 * navigation (the area's first row; `/production` opens it) and the words in both languages.
 *
 * PW-01 (web side; 06-tree §0.6 "Overview: rep-B tiles, brand rows, WIP and urgent list hold only B; Total = B only; manager sees A and
 * B"): the screen draws only the rows the API gave and its Total is the API's `overall`, never a sum made here; a person limited to
 * Brand Beta meets nothing of Brand Alpha anywhere on the page, and every door names only Beta. Made-up data only.
 */

const PREFIX = '/w/DEMO'
const MODES = ['table', 'board', 'calendar', 'cards'] as const
const NONE: OverviewTerms = { party: null, mine: false }
const view = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => designScreen.cases.find((item) => item.id === id)!
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, caseOf(id).model, locale)
const hrefsOf = (html: string): string[] => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replace(/&amp;/g, '&'))
const queryOf = (href: string) => new URLSearchParams(href.split('?')[1] ?? '')
/** What the Work orders page reads from a door and sends to the API (its own termsOf + listQueryOf). */
const listReadOf = (href: string) => listQueryOf(termsOf(queryOf(href), MODES))
const en = createTranslator('en', messagesFor('en', ['production']).production!)

describe('F-PR-04 — the page’s address', () => {
  it('reads the customer filter (`?party=`, an id only) and Only mine (`?supervisor=me`), and writes them back', () => {
    expect(overviewTermsOf(new URLSearchParams(`party=${ALPHA.id}&supervisor=me`))).toEqual({ party: ALPHA.id, mine: true })
    expect(overviewTermsOf(new URLSearchParams('party=not-an-id&supervisor=someone'))).toEqual({ party: null, mine: false })
    expect(overviewTermsOf(null)).toEqual(NONE)
    expect(overviewAddress('/w/DEMO/production/overview', { party: ALPHA.id, mine: true })).toBe(`/w/DEMO/production/overview?party=${ALPHA.id}&supervisor=me`)
    expect(overviewAddress('/w/DEMO/production/overview', NONE)).toBe('/w/DEMO/production/overview')
  })

  it('reads the API with the same terms: partyId, supervisor=me, Most urgent 10 a page', () => {
    expect(overviewQueryOf({ party: BETA.id, mine: true })).toEqual({ partyId: BETA.id, supervisor: 'me', limit: 10 })
    expect(overviewQueryOf(NONE)).toEqual({ limit: 10 })
  })

  it('mirrors the API’s stages and row kinds (B-PR-33 tally.ts and contract.ts)', () => {
    const tally = readFileSync(new URL('../../../../../factory-api/src/modules/production/overview/tally.ts', import.meta.url), 'utf8')
    expect(tally).toContain(`export const WIP_STAGES = [${WIP_STAGES.map((value) => `'${value}'`).join(', ')}] as const`)
    const contract = readFileSync(new URL('../../../../../factory-api/src/modules/production/overview/contract.ts', import.meta.url), 'utf8')
    expect(contract).toContain(`kind: z.enum([${ROW_KINDS.map((value) => `'${value}'`).join(', ')}])`)
  })
})

describe('F-PR-04 — every number opens Work orders with its filters', () => {
  it('the six tiles: waiting on us / on the customer, late, at risk, blocked → Work orders; Customer requests → Home › Approvals', () => {
    const tiles = tilesOf(EVERY_ANSWER, PREFIX, NONE)
    expect(tiles.map((tile) => tile.id)).toEqual(['waitingOnUs', 'waitingOnCustomer', 'late', 'atRisk', 'blocked', 'customerRequests'])
    expect(tiles.map((tile) => tile.value)).toEqual([12, 3, 3, 4, 3, 3])
    expect(tiles.find((tile) => tile.id === 'waitingOnUs')!.href).toBe('/w/DEMO/production/work-orders?sort=risk&waitingOn=US')
    expect(listReadOf(tiles.find((tile) => tile.id === 'waitingOnCustomer')!.href)).toMatchObject({ open: true, waitingOn: 'BRAND' })
    expect(listReadOf(tiles.find((tile) => tile.id === 'blocked')!.href)).toMatchObject({ open: true, risk: 'BLOCKED' })
    expect(tiles.find((tile) => tile.id === 'customerRequests')!.href).toBe('/w/DEMO/home/approvals?kind=ORDER_CHANGE_REQUEST')
    // Not read yet: "—", never 0.
    expect(tilesOf(null, PREFIX, NONE).every((tile) => tile.value === null)).toBe(true)
  })

  it('the customer filter and Only mine go with every door (the tiles too)', () => {
    const tiles = tilesOf(EVERY_ANSWER, PREFIX, { party: ALPHA.id, mine: true })
    expect(tiles.find((tile) => tile.id === 'late')!.href).toBe(`/w/DEMO/production/work-orders?sort=risk&risk=LATE&party=${ALPHA.id}&supervisor=me`)
    expect(listReadOf(tiles.find((tile) => tile.id === 'late')!.href)).toMatchObject({ risk: 'LATE', partyId: ALPHA.id, supervisor: 'me' })
  })

  it('Exceptions by customer: each column opens the list with the API filter B-PR-33 counts against; a 0 is said plainly', () => {
    const rows = exceptionRows(EVERY_ANSWER, PREFIX, NONE, true)
    expect(rows.map((row) => row.label.kind)).toEqual(['customer', 'customer', 'mixed', 'none', 'total'])
    const alpha = rows[0]!
    expect(alpha.label).toEqual({ kind: 'customer', text: 'Brand Alpha', partyId: ALPHA.id })
    const read = (column: (typeof EXCEPTION_COLUMNS)[number]) => listReadOf(alpha.cells[column].href!)
    expect(read('inProduction')).toMatchObject({ open: true, partyId: ALPHA.id })
    expect(read('late')).toMatchObject({ risk: 'LATE', partyId: ALPHA.id })
    expect(read('atRisk')).toMatchObject({ risk: 'AT_RISK' })
    expect(read('blocked')).toMatchObject({ risk: 'BLOCKED' })
    expect(read('onUs')).toMatchObject({ waitingOn: 'US' })
    expect(read('onCustomer')).toMatchObject({ waitingOn: 'BRAND' })
    expect(read('onSupplier')).toMatchObject({ waitingOn: 'SUPPLIER' })
    expect(read('onWorkshop')).toMatchObject({ waitingOn: 'WORKSHOP' })
    expect(read('onHold')).toMatchObject({ blockedBy: 'HOLD' })
    expect(read('gate')).toMatchObject({ gate: true, open: true })
    expect(read('urgent')).toMatchObject({ customerUrgency: 'URGENT', open: true })
    expect(alpha.cells.requests.href).toBe(approvalsDoor(PREFIX))
    // Alpha has no work order made before the rule: 0, no door.
    expect(alpha.cells.split).toEqual({ value: 0, href: null })
    expect(alpha.pieces).toBe(1240)
  })

  it('the mixed row opens the list’s `mixed` filter, the no-customer row its `noCustomer` one; the Total keeps the page’s filter', () => {
    const rows = exceptionRows(EVERY_ANSWER, PREFIX, NONE, true)
    const mixed = rows.find((row) => row.label.kind === 'mixed')!
    expect(listReadOf(mixed.cells.inProduction.href!)).toMatchObject({ open: true, mixed: true, partyId: undefined })
    expect(listReadOf(mixed.cells.split.href!)).toMatchObject({ mixed: true })
    const none = rows.find((row) => row.label.kind === 'none')!
    expect(listReadOf(none.cells.inProduction.href!)).toMatchObject({ open: true, noCustomer: true, partyId: undefined, mixed: undefined })
    const total = rows.find((row) => row.total)!
    expect(listReadOf(total.cells.late.href!)).toMatchObject({ risk: 'LATE', partyId: undefined, mixed: undefined, noCustomer: undefined })
    const narrowed = exceptionRows(EVERY_ANSWER, PREFIX, { party: BETA.id, mine: true }, true).find((row) => row.total)!
    expect(listReadOf(narrowed.cells.late.href!)).toMatchObject({ partyId: BETA.id, supervisor: 'me' })
  })

  it('WIP by stage: drafts, released and held open their state view; the started stages the work in progress; "—" is not counted', () => {
    expect(STAGE_VIEW).toEqual({ NOT_RELEASED: 'DRAFT', RELEASED: 'RELEASED', CUTTING: 'IN_PROGRESS', SEWING: 'IN_PROGRESS', AT_WORKSHOP: 'IN_PROGRESS', QUALITY: 'IN_PROGRESS', FINISHED: 'IN_PROGRESS', ON_HOLD: 'ON_HOLD' })
    const rows = wipRows(EVERY_ANSWER, PREFIX, NONE, true)
    const alpha = rows[0]!
    const held = alpha.stages.ON_HOLD
    expect(held.counted).toBe(true)
    if (!held.counted) return
    expect(held.value).toBe(50)
    expect(listReadOf(held.href!)).toMatchObject({ status: 'ON_HOLD', partyId: ALPHA.id })
    const sewing = alpha.stages.SEWING
    if (!sewing.counted) throw new Error('Alpha counts sewing')
    expect(listReadOf(sewing.href!)).toMatchObject({ status: 'IN_PROGRESS', partyId: ALPHA.id })
    expect(listReadOf(alpha.pieces.href!)).toMatchObject({ open: true, partyId: ALPHA.id })
    // Beta's sewing is not counted here: "—", never 0.
    const beta = rows[1]!
    expect(beta.stages.SEWING).toEqual({ counted: false })
    expect(beta.stages.QUALITY).toEqual({ counted: false })
    expect(beta.stages.FINISHED).toEqual({ counted: true, value: 0, href: null })
    expect(rows.find((row) => row.total)!.sewingNotCounted).toBe(1)
  })

  it('Most urgent: each row as the Work orders list says it; "3 of 7 · Show all" opens the list by risk with the page’s filters', () => {
    const [late, waiting, raised] = EVERY_ANSWER.mostUrgent.items.map((row) => urgentLineOf(row, PREFIX, true))
    expect(late).toMatchObject({ number: 'WO-0311', href: `/w/DEMO/production/work-orders/${encodeURIComponent(EVERY_ANSWER.mostUrgent.items[0]!.id)}`, daysLate: 3, supervisorKey: 'mark.ME', health: { kind: 'health', input: { computed: 'LATE', daysLate: 3 } } })
    expect(late!.customer).toEqual({ kind: 'customer', text: 'Brand Alpha', partyId: ALPHA.id })
    expect(waiting).toMatchObject({ blockedKey: 'blocked.CUSTOMER', supervisorKey: 'mark.SOMEONE_ELSE', waiting: { who: 'BRAND' } })
    expect(raised!.health).toMatchObject({ kind: 'health', input: { computed: 'ON_TIME', raised: { reason: 'MATERIAL_LATE' } } })
    expect(urgentLineOf(EVERY_ANSWER.mostUrgent.items[0]!, PREFIX, false).customer).toEqual({ kind: 'customer', text: 'BR-ALPHA', partyId: ALPHA.id })
    const footer = urgentFooter(EVERY_ANSWER, PREFIX, { party: null, mine: true })
    expect(footer).toMatchObject({ shown: 3, count: 7 })
    expect(listReadOf(footer.href)).toMatchObject({ sort: 'risk', supervisor: 'me', open: true })
    expect(en('ovw.urgent.shownOf', { shown: 3, count: 7 })).toBe('3 of 7')
  })

  it('nothing open: the empty state (no row, no mixed, no work)', () => {
    expect(nothingOpen(EVERY_ANSWER)).toBe(false)
    const empty: Overview = { ...EVERY_ANSWER, customers: [], mixed: null, noCustomer: null, overall: { ...EVERY_ANSWER.overall, inProduction: { workOrders: 0, pieces: 0 } } }
    expect(nothingOpen(empty)).toBe(true)
  })
})

describe('F-PR-04 — the open issues (B-PR-45)', () => {
  const issues = LIMITED_ISSUES.issues
  it('each issue: its record, the customer, what it waits on in words; overdue against the overview’s day', () => {
    const codes = customerCodesOf(EVERY_ANSWER)
    const line = issueLineOf(issues[0]!, PREFIX, true, codes, '2026-11-20')
    expect(line).toMatchObject({ customer: 'Brand Beta', state: { key: 'ovw.issues.state.noReply' }, stateTone: 'warning', taskKey: 'mark.ME', overdue: true })
    expect(line.record.href).toMatch(/^\/w\/DEMO\/sales\/orders\//)
    // Without parties.view: the customer's code (the issues read sends the name only; the page knows the code).
    expect(issueLineOf(issues[0]!, PREFIX, false, codes, null).customer).toBe('BR-BETA')
    expect(issueLineOf(issues[0]!, PREFIX, false, new Map(), null).customer).toBeNull()
    const onWorkOrder = issueLineOf({ ...issues[0]!, note: null, escalation: { step: 2, at: '2026-11-18T07:00:00.000Z' }, record: { type: 'WorkOrder', id: 'x1', label: 'WO-0311' } }, PREFIX, true, codes, null)
    expect(onWorkOrder).toMatchObject({ record: { href: '/w/DEMO/production/work-orders/x1' }, state: { key: 'ovw.issues.state.escalatedOwner' }, overdue: false })
    expect(issueLineOf({ ...issues[0]!, note: null, escalation: null, task: null }, PREFIX, true, codes, null)).toMatchObject({ state: { key: 'ovw.issues.state.waiting' }, stateTone: 'neutral', taskKey: null })
  })

  it('"10 of 23": the open ones, or with Only mine the reader’s own; Show more reads 50 more, at most 200', () => {
    const read: Issues = { ...LIMITED_ISSUES, counts: { open: 23, noReplyYet: 2, escalated: 1, mine: 4 }, more: true }
    expect(issuesSummary(read, false)).toEqual({ shown: 1, count: 23, more: true })
    expect(issuesSummary(read, true)).toEqual({ shown: 1, count: 4, more: true })
    expect(nextIssuesLimit(10)).toBe(60)
    expect(nextIssuesLimit(180)).toBe(200)
  })
})

describe('F-PR-04 — live', () => {
  it('reads again on the events the overview names, on work order, production and issue events; never on others', () => {
    const events = EVERY_ANSWER.live.events
    expect(overviewTouches({ type: 'brand_production.health_changed' }, events)).toBe(true)
    expect(overviewTouches({ type: 'workorder.released' }, [])).toBe(true)
    expect(overviewTouches({ type: 'production.scan' }, [])).toBe(true)
    expect(overviewTouches({ type: 'production_issue.raised' }, [])).toBe(true)
    expect(overviewTouches({ type: 'invoice.issued' }, events)).toBe(false)
  })
})

describe('PW-01 (web side): a person limited to Brand Beta meets nothing of Brand Alpha', () => {
  it('the Total is the API’s `overall`, never a sum made on the screen', () => {
    const odd: Overview = { ...EVERY_ANSWER, overall: { ...EVERY_ANSWER.overall, late: 99, inProduction: { workOrders: 98, pieces: 9700 } } }
    const total = exceptionRows(odd, PREFIX, NONE, true).find((row) => row.total)!
    expect(total.cells.late.value).toBe(99)
    expect(total.cells.inProduction.value).toBe(98)
    expect(total.pieces).toBe(9700)
    expect(wipRows(odd, PREFIX, NONE, true).find((row) => row.total)!.pieces.value).toBe(9700)
  })

  it('only the rows the API gave: Beta and its Total; no mixed or no-customer row; every door names Beta or no customer', () => {
    const rows = exceptionRows(LIMITED_ANSWER, PREFIX, NONE, false)
    expect(rows.map((row) => row.label)).toEqual([{ kind: 'customer', text: 'BR-BETA', partyId: BETA.id }, { kind: 'total' }])
    for (const row of rows) for (const column of EXCEPTION_COLUMNS) {
      const href = row.cells[column].href
      if (href && href.includes('/production/work-orders')) expect([null, BETA.id]).toContain(queryOf(href).get('party'))
    }
    expect(wipRows(LIMITED_ANSWER, PREFIX, NONE, false)).toHaveLength(2)
  })

  it('the page drawn for that person: Beta only, by code; no Alpha name, code, work order or id; every link names Beta or none', () => {
    for (const locale of LOCALES) {
      const html = draw('limited', locale)
      const text = textOf(html)
      expect(text).toContain('BR-BETA')
      for (const alpha of [ALPHA.name, ALPHA.code, ALPHA.id, 'WO-0311', 'WO-0313']) expect(html, `${locale}: ${alpha}`).not.toContain(alpha)
      expect(text).not.toContain(createTranslator(locale, messagesFor(locale, ['production']).production!)('customer.mixed'))
      for (const href of hrefsOf(html)) {
        const party = queryOf(href).get('party')
        if (party) expect(party, href).toBe(BETA.id)
        expect(href, href).not.toContain(`/sales/customers/`)
      }
    }
  })

  it('the production unit sees both customers, the mixed row and the Total', () => {
    const text = textOf(draw('overview'))
    for (const word of ['Brand Alpha', 'Brand Beta', en('customer.mixed'), en('list.noCustomer'), en('ovw.total')]) expect(text).toContain(word)
  })
})

describe('F-PR-04 — the page in both languages', () => {
  it('every case draws in Italian and English with no word key left', () => {
    for (const locale of LOCALES) {
      for (const item of designScreen.cases) {
        const html = renderView(view, item.model, locale)
        expect(leftKeys(html, ['ovw', 'mark', 'blocked', 'error', 'parts']), `${locale} ${item.id}`).toEqual([])
      }
    }
  })

  it('Only mine is a switch in the band, pressed with ?supervisor=me; every Work orders link of that case carries it', () => {
    const html = draw('mine')
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/)
    const doors = hrefsOf(html).filter((href) => href.includes('/production/work-orders?'))
    expect(doors.length).toBeGreaterThan(0)
    for (const href of doors) expect(queryOf(href).get('supervisor'), href).toBe('me')
    expect(draw('overview')).toMatch(/role="switch"[^>]*aria-checked="false"/)
  })

  it('the Italian words: Panoramica, "Urgente (cliente)" (never "Urgente" alone: the rush flag), Supervisore', () => {
    const it = createTranslator('it', messagesFor('it', ['production']).production!)
    const shell = createTranslator('it', messagesFor('it', ['shell']).shell!)
    expect(shell('nav.production.overview')).toBe('Panoramica')
    expect(it('ovw.col.urgent')).toBe('Urgente (cliente)')
    expect(it('ovw.urgent.supervisor')).toBe('Supervisore')
    expect(it('filter.gate')).not.toBe('filter.gate')
    expect(en('ovw.pieces', { count: 1, pieces: '1' })).toBe('1 piece')
  })
})

describe('F-PR-04 — the navigation', () => {
  it('Overview is Production’s first row (workorders.view); `/production` opens it; the customer filter is carried there', () => {
    const items = officeArea.area.sections![0]!.items
    expect(items[0]).toMatchObject({ id: 'production-overview', href: '/production/overview', permission: 'workorders.view' })
    expect(OFFICE_PAGES.has('/production/overview')).toBe(true)
    expect(firstOfficePage(officeNavFor(permissionCheck(['workorders.view'])), { areaId: 'production' })).toBe('/production/overview')
    // Without workorders.view the row is not there: the area opens the person's first other page.
    expect(firstOfficePage(officeNavFor(permissionCheck(['production.reports.view'])), { areaId: 'production' })).toBe('/production/reports')
    expect(takesParty('/w/DEMO/production/overview')).toBe(true)
  })

  it('a door is the Work orders list’s own address (its sort written, every term as the list reads it)', () => {
    const href = workOrdersDoor(PREFIX, { kind: 'CUSTOMER', partyId: BETA.id }, { gate: true }, { party: ALPHA.id, mine: false })
    // The row's own customer wins over the page's filter (a row of Beta opens Beta's work orders).
    expect(href).toBe(`/w/DEMO/production/work-orders?sort=risk&party=${BETA.id}&gate=true`)
  })
})
