import { readFileSync } from 'node:fs'
import type { BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { createScopedTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { AgeingRow } from '../../../../finance/receivables/api'
import type { Party } from '../../../../parties/_shared/api'
import { CUSTOMERS } from '../../../../parties/_shared/fixtures'
import { failed, loaded, loading } from '../../../../parties/_shared/model'
import type { Glance } from '../../depth/api'
import { glanceOf as demoGlance, withoutPrices } from '../../depth/_demo/fixtures'
import { failedRead, LOADING, ready } from '../../depth/model'
import type { CustomerWork } from '../../list/api'
import { COMPLAINTS, OVERDUE_ROWS, RETURNS } from '../../money/_demo/fixtures'
import type { WorkReads } from '../use-customer-work'
import { DESIGNER_CASES, DESIGNERS, OFFICE_PEOPLE, SUPERVISOR_CASES } from '../../portal/demo' // F-CO-201: made-up office people
import { MONEY_ANCHORS, moneyDoor, promiseDoor, termsDoor } from './doors'
import { boardNumbersOf, headlineOf, HEADLINE_PARTS, waitsOnUsOf } from './headline'
import { COMPLAINTS_READ, OVERVIEW_NAMESPACES, sayOf, sayToolsOf, urgencyOf, type LooksAfter, type OverviewCan, type OverviewHeadline, type OverviewInput, type OverviewMoney, type OverviewRow, type OverviewStrip, type Say } from './model'
import { bandStateOf, datesOf, EARLIEST_FIRST, factsOf, linkedOf, overviewOf, peopleOf, requestsOf } from './rows'
import { stripsOf } from './strips'

/**
 * F-CO-101 (customer page › Overview; 10-design §2–§9; 13-backend §4; lead settles S5–S11, S21–S25, S28) — the Overview's rules,
 * pure: the standing's ladder said in English and Italian, the strips (order, tone, the ONE door, the right that hides it), the
 * rows of each card, "absent ≠ 0" and the first walls (nothing of another customer; no amount without the price grain; a part
 * without its right left out, a button without its right not there — never held for a right). Made-up data only.
 */

const MODA = CUSTOMERS.find((item) => item.code === 'MODA-DEMO')!
const ID = MODA.id
const BASE = `/w/DEMO/sales/customers/${ID}`
const TODAY = '2026-11-24'
const AT = '2026-11-24T08:00:00.000Z'

const party = (over: Partial<Party> = {}): Party => ({ ...MODA, legalName: 'Seed Customer One S.r.l.', tradeName: 'Seed Racing', status: 'ACTIVE', blocked: null, warnings: [], invoiceBlocked: false, internalNote: null, createdAt: '2025-10-28T09:00:00.000Z', updatedAt: '2026-11-20T09:00:00.000Z', ...over })

const board = (byStatus: Readonly<Record<string, number>>, over: { late?: number; waitsForYes?: number; waitsForDeposit?: number } = {}): WorkReads['board'] => ({
  status: 'ready',
  value: {
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
    lanes: [],
    tiles: [{ key: 'late', count: over.late ?? 0, filter: {} }],
    notSent: { waitsForYes: over.waitsForYes ?? 0, waitsForDeposit: over.waitsForDeposit ?? 0 },
    asOf: AT,
  } as never,
})
const BUSY = board({ CONFIRMED: 3, IN_PRODUCTION: 4, READY: 1, SHIPPED: 2, COMPLETED: 3, CANCELLED: 1 }, { late: 1 })
const reads = (over: Partial<WorkReads> = {}): WorkReads => ({
  board: BUSY,
  requests: { status: 'ready', value: { items: [], open: 2, countered: 0 } },
  replies: { status: 'ready', value: { rows: [], count: 1, complete: true } },
  asks: { status: 'ready', value: { items: [], complete: true } },
  tasks: { status: 'ready', value: { items: [], total: 1, complete: true } },
  ...over,
})
const QUIET: Partial<WorkReads> = { requests: { status: 'ready', value: { items: [], open: 0, countered: 0 } }, replies: { status: 'ready', value: { rows: [], count: 0, complete: true } }, tasks: { status: 'ready', value: { items: [], total: 0, complete: true } } }

const counts = (groups: Partial<BeforeOrderCountsAnswer['groups']> = {}, over: Partial<BeforeOrderCountsAnswer> = {}): BeforeOrderCountsAnswer => {
  const all = { WRITING: 0, TO_ANSWER: 0, PREPARING: 0, APPROVAL: 0, WAITING_CUSTOMER: 0, ORDER_WAITS: 0, WON: 0, MOVED: 0, LOST: 0, ...groups }
  return { partyId: ID, asOf: AT, sampleRounds: null, openQuotes: 0, waitsOnUs: (all.TO_ANSWER ?? 0) + (all.ORDER_WAITS ?? 0), groups: all, byKind: { quotes: null, requests: null, portalOrders: null, drafts: null }, ...over }
}
const standing = (over: Partial<CustomerWork> = {}): CustomerWork => ({ partyId: ID, orders: 14, phases: [], late: 1, waitsForYes: 0, depositOpen: 0, requests: { open: 0, firstId: null }, replies: 0, customerUrgent: { count: 0, byCompany: [] }, priority: { top: 0, high: 0 }, nextPromise: '2026-11-27', lastOrderDate: '2026-11-20', ...over })
const glance = (over: Partial<Glance> = {}): Glance => demoGlance('MODA-DEMO', { samples: { count: 0, rows: [] }, repairs: { count: 0, rows: [] }, credit: null, requirements: { count: 0, rows: [] }, ...over })
const hold = (reason: Glance['hold']['holds'][number]['reason'], over: Partial<Glance['hold']['holds'][number]> = {}): Glance['hold']['holds'][number] => ({ id: `h-${reason}`, reason, words: 'Made-up words of the hold.', everyCompany: false, placedAt: '2026-11-15T08:00:00.000Z', placedBy: null, ...over })
const OVER: NonNullable<Glance['credit']> = { state: 'OVER', currency: 'EUR', limit: 2_000_000, used: 2_420_000, available: -420_000, overLimitBy: 420_000, overdue: 0, usedPct: 121, onHold: true }

const NO_MONEY: OverviewMoney = { ageing: loaded<AgeingRow>([]), returns: loaded([]), complaints: loaded([]), orders: loaded([]), returnsHref: null }
const LATE = OVERDUE_ROWS.filter((row) => row.customer.id === ID)
const CAN: OverviewCan = { orders: true, quotesTab: true, moneyTab: true, receivables: true, price: true, returns: true, complaints: true, partners: true, manage: true, block: true, vies: true, workorders: true, samples: true, repairs: true, credit: true }
const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  prefix: '/w/DEMO',
  party: party(),
  can: CAN,
  today: TODAY,
  reads: reads(),
  counts: { counts: counts({ TO_ANSWER: 1 }), failed: false },
  glance: ready(glance()),
  money: NO_MONEY,
  standing: { status: 'ready', value: standing() },
  urgency: { status: 'off' },
  looksAfter: null,
  projects: null,
  viesRunning: false,
  ...over,
})

const tools = (locale: Locale) => sayToolsOf(locale, createScopedTranslator(locale, messagesFor(locale, OVERVIEW_NAMESPACES), 'parties'))
const said = (words: Say, locale: Locale = 'en'): string => sayOf(words, tools(locale))
const sentence = (headline: OverviewHeadline, locale: Locale): string | null => headline.sentence?.map((part) => said(part, locale)).join(' · ') ?? null
const quiet = (headline: OverviewHeadline, locale: Locale): string | null => (headline.quiet ? said(headline.quiet, locale) : null)
const hrefOf = (door: { readonly door: { readonly kind: string; readonly href?: string } } | undefined): string | null => (door && door.door.kind === 'href' ? (door.door.href ?? null) : null)
const stripOf = (rows: readonly OverviewStrip[], kind: OverviewStrip['kind']): OverviewStrip => rows.find((row) => row.kind === kind)!
const valueOf = (row: OverviewRow, locale: Locale = 'en'): string => row.parts.map((part) => said(part.say, locale)).join(' · ')
const rowOf = (rows: readonly OverviewRow[], key: string): OverviewRow => rows.find((row) => row.key === key)!
const allWords = (model: ReturnType<typeof overviewOf>, locale: Locale): string =>
  [
    ...(model.headline.sentence ?? []).map((part) => said(part, locale)),
    ...model.strips.rows.flatMap((row) => [said(row.title, locale), ...row.lines.map((line) => said(line, locale))]),
    ...[...model.people.rows, ...(model.dates?.rows ?? []), ...model.linked.rows].map((row) => valueOf(row, locale)),
    ...model.facts.rows.flatMap((row) => row.parts.map((part) => said(part.say, locale))),
  ].join('\n')

describe('the standing: ONE sentence, the first true line of the ladder, in English and Italian', () => {
  const LADDER: ReadonlyArray<{ readonly line: OverviewHeadline['line']; readonly given: Partial<OverviewInput>; readonly en: string; readonly it: string; readonly quietEn: string | null; readonly quietIt: string | null }> = [
    {
      line: 'ARCHIVED',
      given: { party: party({ status: 'ARCHIVED' }), reads: reads({ board: board({ COMPLETED: 5 }), ...QUIET }), counts: { counts: counts(), failed: false }, standing: { status: 'ready', value: standing({ nextPromise: null }) } },
      en: 'Archived',
      it: 'Archiviato',
      quietEn: 'Read only until it is reactivated (⋯ › Reactivate).',
      quietIt: 'Solo lettura finché non viene riattivato (⋯ › Riattiva).',
    },
    {
      line: 'BLOCKED',
      given: { party: party({ status: 'BLOCKED', blocked: { reason: 'Made-up reason.', at: '2026-11-12T09:00:00.000Z' } }), reads: reads({ board: board({ CONFIRMED: 3, COMPLETED: 9 }), ...QUIET }), counts: { counts: counts(), failed: false }, standing: { status: 'ready', value: standing({ nextPromise: '2026-12-04' }) } },
      en: 'Blocked since 12/11/2026 · 3 open orders · next promise 04/12/2026',
      it: 'Bloccato dal 12/11/2026 · 3 ordini aperti · prossima promessa 04/12/2026',
      quietEn: 'No new quotes, orders or shipments.',
      quietIt: 'Niente nuovi preventivi, ordini o spedizioni.',
    },
    {
      line: 'ON_HOLD',
      given: { glance: ready(glance({ hold: { onHold: true, holds: [hold('CREDIT')] } })), reads: reads({ board: board({ CONFIRMED: 5, COMPLETED: 7 }, { late: 1 }), ...QUIET }), counts: { counts: counts({ ORDER_WAITS: 1 }), failed: false } },
      en: 'On hold (Credit) · 5 open orders · 1 late · 1 thing waits on us',
      it: 'In blocco (Fido) · 5 ordini aperti · 1 in ritardo · 1 cosa tocca a noi',
      quietEn: 'New orders and shipments wait; new quotes show a warning.',
      quietIt: 'Nuovi ordini e spedizioni attendono; i nuovi preventivi mostrano un avviso.',
    },
    {
      line: 'PROSPECT',
      given: { party: party({ status: 'PROSPECT' }), reads: reads({ board: board({}), ...QUIET }), standing: { status: 'ready', value: null } },
      en: 'Prospect · 1 thing waits on us',
      it: 'Potenziale · 1 cosa tocca a noi',
      quietEn: 'Activate it to take orders.',
      quietIt: 'Attivalo per poter prendere ordini.',
    },
    { line: 'NO_ORDER', given: { reads: reads({ board: board({}), ...QUIET }), counts: { counts: counts(), failed: false }, standing: { status: 'ready', value: null } }, en: 'No order yet', it: 'Ancora nessun ordine', quietEn: null, quietIt: null },
    {
      line: 'NO_OPEN',
      given: { reads: reads({ board: board({ COMPLETED: 5, CANCELLED: 1 }), ...QUIET }), counts: { counts: counts(), failed: false }, standing: { status: 'ready', value: standing({ nextPromise: null, lastOrderDate: '2026-09-03' }) } },
      en: 'No open order',
      it: 'Nessun ordine aperto',
      quietEn: 'Last order 03/09/2026',
      quietIt: 'Ultimo ordine 03/09/2026',
    },
    {
      line: 'OPEN',
      given: {},
      en: '8 open orders · 1 late · 4 things wait on us · next promise 27/11/2026',
      it: '8 ordini aperti · 1 in ritardo · 4 cose toccano a noi · prossima promessa 27/11/2026',
      quietEn: 'Last order 20/11/2026',
      quietIt: 'Ultimo ordine 20/11/2026',
    },
    {
      // S7: a reader without orders.view — the board is never asked; the status word, then only the parts whose reads are in.
      line: 'STATUS',
      given: { can: { ...CAN, orders: false }, reads: reads({ board: { status: 'off' }, ...QUIET }), standing: { status: 'off' } },
      en: 'Active · 1 thing waits on us',
      it: 'Attivo · 1 cosa tocca a noi',
      quietEn: null,
      quietIt: null,
    },
  ]
  for (const step of LADDER) {
    it(`${step.line}: "${step.en}" / "${step.it}"`, () => {
      const headline = headlineOf(input(step.given))
      expect(headline.line).toBe(step.line)
      expect(sentence(headline, 'en')).toBe(step.en)
      expect(sentence(headline, 'it')).toBe(step.it)
      expect(quiet(headline, 'en')).toBe(step.quietEn)
      expect(quiet(headline, 'it')).toBe(step.quietIt)
    })
  }

  it('only orders that wait for a yes: the sentence says so (they are not "open")', () => {
    const headline = headlineOf(input({ reads: reads({ board: board({ PENDING_APPROVAL: 2, COMPLETED: 1 }, { waitsForYes: 2 }), ...QUIET }), counts: { counts: counts(), failed: false }, standing: { status: 'ready', value: standing({ nextPromise: null }) } }))
    expect(headline.line).toBe('NO_OPEN')
    expect(sentence(headline, 'en')).toBe('2 orders wait for a yes')
    expect(sentence(headline, 'it')).toBe('2 ordini aspettano un sì')
  })

  it('several holds are counted; four parts at most, cut from the end; S25: "next promise", never "next delivery"', () => {
    const headline = headlineOf(input({ glance: ready(glance({ hold: { onHold: true, holds: [hold('CREDIT'), hold('LEGAL')] } })) }))
    expect(sentence(headline, 'en')).toBe('On hold (2 holds) · 8 open orders · 1 late · 4 things wait on us')
    expect(sentence(headline, 'it')).toBe('In blocco (2 blocchi) · 8 ordini aperti · 1 in ritardo · 4 cose toccano a noi')
    expect(headline.sentence).toHaveLength(HEADLINE_PARTS)
    for (const locale of LOCALES) expect(allWords(overviewOf(input()), locale)).not.toMatch(/next delivery|prossima consegna/i)
  })
})

describe('absent ≠ 0: a part whose read is not in is left out; a failed read never shows 0', () => {
  it('while the board (or the hold) is still read the sentence is not said at all', () => {
    expect(headlineOf(input({ reads: reads({ board: { status: 'reading' } }) })).sentence).toBeNull()
    expect(headlineOf(input({ glance: LOADING })).sentence).toBeNull()
    // A blocked or archived customer's standing does not wait for the hold.
    expect(sentence(headlineOf(input({ glance: LOADING, party: party({ status: 'ARCHIVED' }) })), 'en')).toMatch(/^Archived/)
  })
  it('a board that could not be read: the status word, never "0 open orders" or "No order yet"', () => {
    const headline = headlineOf(input({ reads: reads({ board: { status: 'failed' } }) }))
    expect(headline.line).toBe('STATUS')
    expect(sentence(headline, 'en')).toBe('Active · 4 things wait on us · next promise 27/11/2026')
    expect(bandStateOf(input({ reads: reads({ board: { status: 'failed' } }) }))).toBe('band')
  })
  it('the joined read without this customer (the reader\'s orders do not reach it): no next promise, no last order, no priority — never zeros', () => {
    const given = input({ standing: { status: 'ready', value: null } })
    const headline = headlineOf(given)
    expect(sentence(headline, 'en')).toBe('8 open orders · 1 late · 4 things wait on us')
    expect(headline.quiet).toBeNull()
    expect(datesOf(given)?.rows.map((row) => row.key)).toEqual(['late'])
    expect(valueOf(rowOf(linkedOf(given).rows, 'orders'))).toBe('8 open of 14 · 1 late')
  })
  it('"things wait on us" waits for its reads and adds only what is in', () => {
    expect(waitsOnUsOf(input({ reads: reads({ replies: { status: 'reading' } }) }))).toBeNull()
    expect(waitsOnUsOf(input({ counts: { counts: null, failed: false } }))).toBeNull()
    expect(waitsOnUsOf(input({ counts: { counts: null, failed: true } }))).toBe(3)
    expect(waitsOnUsOf(input({ reads: reads({ requests: { status: 'off' }, replies: { status: 'off' } }), counts: { counts: counts({}, { waitsOnUs: null }), failed: false } }))).toBeNull()
  })
  it('the open orders are the board\'s own counts by state (the domain\'s open states), never a count of rows', () => {
    expect(boardNumbersOf((BUSY as Extract<WorkReads['board'], { status: 'ready' }>).value)).toEqual({ total: 14, open: 8, late: 1, waitsForYes: 0 })
  })
})

describe('the strips: what stops the customer, most blocking first', () => {
  const everything = input({
    party: party({
      status: 'BLOCKED',
      blocked: { reason: 'Made-up reason.', at: '2026-11-13T09:00:00.000Z' },
      invoiceBlocked: true,
      warnings: [
        { code: 'NO_TAX_IDENTITY', message: '', blocksInvoice: true },
        { code: 'NO_REGISTERED_ADDRESS', message: '', blocksInvoice: true },
        { code: 'VIES_NOT_PROVEN', message: '', blocksInvoice: false },
      ],
    }),
    glance: ready(glance({ hold: { onHold: true, holds: [hold('CREDIT'), hold('QUALITY_DISPUTE', { everyCompany: true, placedBy: 'Alex Demo' })] }, credit: OVER })),
    money: { ...NO_MONEY, ageing: loaded(LATE) },
    counts: { counts: counts({ ORDER_WAITS: 2 }), failed: false },
    urgency: { status: 'ready', value: { on: true, max: 3, now: 4, dormant: null, overQuota: { it: 'x', en: 'x' } } },
  })

  it('their order and tones; a Credit hold says the limit as its own line (S8: ONE strip)', () => {
    const strips = stripsOf(everything)
    expect(strips.rows.map((row) => row.kind)).toEqual(['blocked', 'hold', 'hold', 'invoice', 'vies', 'overdue', 'orderWaits', 'urgency'])
    expect(strips.rows.map((row) => row.tone)).toEqual(['danger', 'danger', 'danger', 'danger', 'warning', 'warning', 'warning', 'info'])
    const credit = strips.rows[1]!
    expect(said(credit.title)).toBe('On hold — Credit · Officina Demo S.r.l.')
    expect(said(credit.title, 'it')).toBe('In blocco — Fido · Officina Demo S.r.l.')
    expect(credit.lines.map((line) => said(line))).toEqual(['Made-up words of the hold.', 'Over the credit limit: over by €4,200.00 of a €20,000.00 limit', 'Since 15/11/2026, by a credit check'])
    expect(said(strips.rows[2]!.title)).toBe('On hold — Quality dispute · Every company')
    expect(strips.rows[2]!.lines.map((line) => said(line)).at(-1)).toBe('Since 15/11/2026, by Alex Demo')
  })

  it('over the limit with no Credit hold: its own strip, a door to Money at the credit; the amounts only when the read carries them', () => {
    const strips = stripsOf(input({ glance: ready(glance({ credit: OVER })) }))
    const strip = stripOf(strips.rows, 'credit')
    expect(said(strip.title)).toBe('Over the credit limit')
    expect(strip.lines.map((line) => said(line))).toEqual(['Over by €4,200.00 of a €20,000.00 limit'])
    expect(hrefOf(strip.doors[0])).toBe(`${BASE}?tab=money#credit`)
    const bare = stripOf(stripsOf(input({ glance: ready(withoutPrices(glance({ credit: OVER }))) })).rows, 'credit')
    expect(bare.lines).toEqual([])
  })

  it('S23: the Blocked strip has NO button; the line that names the ⋯ menu only with parties.block', () => {
    const blocked = stripOf(stripsOf(everything).rows, 'blocked')
    expect(blocked.doors).toEqual([])
    expect(blocked.lines.map((line) => said(line))).toEqual(['Reason: Made-up reason.', 'Unblock it from the ⋯ menu above.'])
    expect(blocked.lines.map((line) => said(line, 'it')).at(-1)).toBe('Sbloccalo dal menu ⋯ qui sopra.')
    expect(stripOf(stripsOf({ ...everything, can: { ...CAN, block: false } }).rows, 'blocked').lines.map((line) => said(line))).toEqual(['Reason: Made-up reason.'])
  })

  it('each strip\'s ONE door lands where the thing is lifted', () => {
    const rows = stripsOf(everything).rows
    expect(hrefOf(rows[1]!.doors[0])).toBe(`${BASE}?tab=terms#party-hold`)
    expect(hrefOf(stripOf(rows, 'overdue').doors[0])).toBe(`${BASE}?tab=money#collect`)
    expect(hrefOf(stripOf(rows, 'orderWaits').doors[0])).toBe(`${BASE}?tab=quotes&group=ORDER_WAITS`)
    expect(hrefOf(stripOf(rows, 'urgency').doors[0])).toBe(`${BASE}?tab=portal`)
    // Can't invoice yet: today's own step per kind of warning (the identity dialog in place, the address on People & addresses).
    const invoice = stripOf(rows, 'invoice')
    expect(invoice.doors.map((door) => door.key)).toEqual(['identity', 'address'])
    expect(invoice.doors[0]!.door).toEqual({ kind: 'act', act: 'identity' })
    expect(hrefOf(invoice.doors[1])).toBe(`${BASE}?tab=people`)
    expect(stripOf(rows, 'vies').doors[0]!.door).toEqual({ kind: 'act', act: 'checkVies' })
    // S21: the money doors come from ONE constant.
    expect(MONEY_ANCHORS).toEqual({ collect: 'collect', credit: 'credit' })
    expect(moneyDoor('/w/DEMO', ID, 'collect')).toBe(`${BASE}?tab=money#collect`)
    expect(termsDoor('/w/DEMO', ID, 'requirements')).toBe(`${BASE}?tab=terms#party-requirements`)
    expect(promiseDoor('/w/DEMO', ID)).toBe(`${BASE}?tab=work&rows=open&sort=promise`)
  })

  it('S22: Overdue never says a count of late invoices — the amount with the price grain, the words without it', () => {
    const priced = stripOf(stripsOf(input({ money: { ...NO_MONEY, ageing: loaded(LATE) } })).rows, 'overdue')
    expect(said(priced.title)).toBe('Overdue · €4,270.00')
    expect(priced.lines.map((line) => said(line))).toEqual(['Oldest 38 days late'])
    expect(priced.lines.map((line) => said(line, 'it'))).toEqual(['La più vecchia: 38 giorni di ritardo'])
    const bare = stripOf(stripsOf(input({ money: { ...NO_MONEY, ageing: loaded(LATE.map((row) => ({ ...row, open: undefined, overdue: undefined, buckets: undefined }))) } })).rows, 'overdue')
    expect(said(bare.title)).toBe('Invoices are late')
    expect(said(bare.title, 'it')).toBe('Ci sono fatture scadute')
    // The ageing rows hold 3 open invoices and no late count of the API's (S39's field absent): the strip says no number of invoices.
    for (const strip of [priced, bare]) for (const locale of LOCALES) expect([said(strip.title, locale), ...strip.lines.map((line) => said(line, locale))].join(' ')).not.toMatch(/\d+\s+(invoices?|fattur[ae])/i)
    expect([said(bare.title), ...bare.lines.map((line) => said(line))].join(' ')).not.toMatch(/€|\d[\d.,]*\s?EUR/)
  })

  it('S39: with the price grain the API\'s own count of late invoices joins the quiet line; Sales keeps the words; a row without the field says no count', () => {
    const overdueWith = (rows: readonly AgeingRow[], can: OverviewCan = CAN) => stripOf(stripsOf(input({ can, money: { ...NO_MONEY, ageing: loaded(rows) } })).rows, 'overdue')
    // This customer's ageing rows (one per company and currency) carry the API's count: the strip says their sum.
    const withCount = LATE.map((row, index) => ({ ...row, lateInvoices: index === 0 ? 2 : 1 }))
    const sum = withCount.reduce((total, row) => total + row.lateInvoices, 0)
    const owner = overdueWith(withCount)
    expect(owner.lines.map((line) => said(line))).toEqual([`${sum} invoices late · Oldest 38 days late`])
    expect(owner.lines.map((line) => said(line, 'it'))).toEqual([`${sum} fatture scadute · La più vecchia: 38 giorni di ritardo`])
    // Another customer's row in the same answer never counts (one customer's reads).
    const another = { ...withCount[0]!, customer: { ...withCount[0]!.customer, id: 'another-made-up-customer' }, lateInvoices: 9 }
    expect(overdueWith([...withCount, another]).lines.map((line) => said(line))).toEqual([`${sum} invoices late · Oldest 38 days late`])
    // Sales (no price grain): the words, never the count — even when the read carries it.
    const sales = overdueWith(withCount, { ...CAN, price: false })
    expect(said(sales.title)).toBe('Invoices are late')
    for (const locale of LOCALES) expect([said(sales.title, locale), ...sales.lines.map((line) => said(line, locale))].join(' '), locale).not.toMatch(/\d+\s+(invoices?|fattur[ae])/i)
    // A row without the field: no count at all (absent ≠ 0); a count of 0: none said.
    expect(overdueWith([{ ...withCount[0]!, lateInvoices: undefined }, ...withCount.slice(1)]).lines.map((line) => said(line))).toEqual(['Oldest 38 days late'])
    expect(overdueWith(withCount.map((row) => ({ ...row, lateInvoices: 0 }))).lines.map((line) => said(line))).toEqual(['Oldest 38 days late'])
  })

  it('a door or a button without its right is NOT there (never held for a right); held with words only by state', () => {
    const bare = stripsOf({ ...everything, can: { ...CAN, manage: false, vies: false, moneyTab: false, quotesTab: false, partners: false, block: false } }).rows
    expect(stripOf(bare, 'invoice').doors).toEqual([])
    expect(stripOf(bare, 'vies').doors).toEqual([])
    expect(stripOf(bare, 'overdue').doors).toEqual([])
    expect(stripOf(bare, 'orderWaits').doors).toEqual([])
    expect(stripOf(bare, 'urgency').doors).toEqual([])
    expect(bare.flatMap((row) => row.doors).every((door) => door.held === null)).toBe(true)
    // By state: a check that runs, an archived customer.
    const warned = party({ warnings: [{ code: 'VIES_NOT_PROVEN', message: '', blocksInvoice: false }] })
    expect(stripOf(stripsOf(input({ party: warned })).rows, 'vies').doors[0]!.held).toBeNull()
    expect(said(stripOf(stripsOf(input({ party: warned, viesRunning: true })).rows, 'vies').doors[0]!.held!)).toBe('A check is running')
    expect(said(stripOf(stripsOf(input({ party: { ...warned, status: 'ARCHIVED' } })).rows, 'vies').doors[0]!.held!)).toBe('Archived: reactivate it first')
  })

  it('a strip whose right or read is missing is absent; the glance\'s failure is said, never silent', () => {
    expect(stripsOf(input({ money: { ...NO_MONEY, ageing: loaded(LATE) }, can: { ...CAN, receivables: false } })).rows).toEqual([])
    expect(stripsOf(input({ counts: { counts: counts({ ORDER_WAITS: null }), failed: false } })).rows).toEqual([])
    expect(stripsOf(input()).rows).toEqual([])
    expect(stripsOf(input({ glance: LOADING }))).toMatchObject({ rows: [], reading: true, failed: null })
    const lost = stripsOf(input({ glance: failedRead('problem.unavailable') }))
    expect(lost.reading).toBe(false)
    expect(said(lost.failed!)).toBe('The holds and the credit could not be read')
    expect(said(lost.failed!, 'it')).toBe('Impossibile leggere i blocchi e il fido')
  })
})

describe('the cards: People, Next dates, Requests & changes, Linked records, Customer facts', () => {
  it('People: each contact once with its roles; nobody → "Nobody yet" and Add contact only with parties.manage', () => {
    const people = peopleOf(input())
    expect(people.rows.map((row) => [said(row.label), valueOf(row)])).toEqual([
      ['Their contact for orders', 'Anna Demo'],
      ['Their contact for invoices', 'Bruno Esempio'],
    ])
    expect(hrefOf(people.head)).toBe(`${BASE}?tab=people`)
    const both = peopleOf(input({ party: party({ contacts: [{ ...MODA.contacts[0]!, roles: ['ORDERS', 'INVOICES'] }] }) }))
    expect(both.rows.map((row) => said(row.label, 'it'))).toEqual(['Il loro contatto per ordini e fatture'])
    const nobody = peopleOf(input({ party: party({ contacts: [] }) })).rows
    expect(nobody.map((row) => valueOf(row))).toEqual(['Nobody yet'])
    expect(nobody[0]!.doors?.map((door) => door.key)).toEqual(['contact'])
    expect(peopleOf(input({ party: party({ contacts: [] }), can: { ...CAN, manage: false } })).rows[0]!.doors).toBeUndefined()
  })

  it('People, both sides (F-CO-201, S10): who looks after — office only, each Change… under its OWN right, a window of the page — then the contacts and the portal', () => {
    const looks = (over: Partial<LooksAfter> = {}): LooksAfter => ({ supervisor: SUPERVISOR_CASES.saved, designer: DESIGNER_CASES.set, ...over })
    const people = peopleOf(input({ looksAfter: looks() }))
    expect(people.state).toBe('ready')
    const keys = people.rows.map((row) => row.key)
    expect(keys.slice(0, 3)).toEqual(['supervisor', 'backup', 'designer'])
    expect(keys.slice(3, -1).every((key) => key.startsWith('contact-'))).toBe(true)
    expect(keys.at(-1)).toBe('portal')
    const row = (key: string) => rowOf(people.rows, key)
    expect(valueOf(row('supervisor'))).toBe(OFFICE_PEOPLE.bea.name)
    expect([said(row('supervisor').tag!.say), said(row('supervisor').tag!.say, 'it'), row('supervisor').tag!.mark]).toEqual(['Office only', 'Solo ufficio', 'office'])
    expect(row('supervisor').doors!.map((door) => [door.key, door.door, door.held])).toEqual([['changeSupervisor', { kind: 'act', act: 'changeSupervisor' }, null]])
    expect(valueOf(row('backup'))).toBe(OFFICE_PEOPLE.carlo.name)
    expect(valueOf(row('designer'))).toBe(`${DESIGNERS.giulia.name} · backup ${DESIGNERS.elena.name}`)
    expect(valueOf(row('designer'), 'it')).toBe(`${DESIGNERS.giulia.name} · sostituto ${DESIGNERS.elena.name}`)
    expect(said(row('designer').tag!.say)).toBe('Seed Racing sees this name')
    expect(row('designer').under!.map((line) => said(line))).toEqual(["Seed Racing sees only this person's name when it asks for design help."])
    expect(row('designer').doors!.map((door) => door.door)).toEqual([{ kind: 'act', act: 'changeDesigner' }])
    expect(valueOf(row('portal'))).toBe('On · Portal settings')
    expect(valueOf(row('portal'), 'it')).toBe('Attivo · Impostazioni del portale')
    expect(hrefOf({ door: row('portal').parts[1]!.door! })).toBe(`${BASE}?tab=portal`)
    // Each Change… reads its OWN right: without it, no button (never held for a right).
    const noRights = peopleOf(input({ looksAfter: looks({ supervisor: SUPERVISOR_CASES.held, designer: DESIGNER_CASES.held }) }))
    expect(rowOf(noRights.rows, 'supervisor').doors).toBeUndefined()
    expect(rowOf(noRights.rows, 'designer').doors).toBeUndefined()
    // Held with words only by reach (not at every company the customer works with) or state (archived).
    const reach = peopleOf(input({ looksAfter: looks({ supervisor: SUPERVISOR_CASES.everyCompany, designer: DESIGNER_CASES.everyCompany }) }))
    for (const key of ['supervisor', 'designer']) expect(said(rowOf(reach.rows, key).doors![0]!.held!), key).toContain('every company')
    const archived = peopleOf(input({ party: party({ status: 'ARCHIVED' }), looksAfter: looks() }))
    for (const key of ['supervisor', 'designer']) expect(said(rowOf(archived.rows, key).doors![0]!.held!), key).toBe('Archived: reactivate it first')
    // The supervisor's read out: the card's skeleton; failed: the card says so (its Try again is the page's retryPeople).
    expect(peopleOf(input({ looksAfter: looks({ supervisor: { ...SUPERVISOR_CASES.saved, state: 'loading', read: null } }) }))).toMatchObject({ rows: [], state: 'reading', problem: null })
    const lost = peopleOf(input({ looksAfter: looks({ supervisor: { ...SUPERVISOR_CASES.saved, state: 'error', read: null, problem: 'failed.title' } }) }))
    expect(lost.state).toBe('failed')
    expect(said(lost.problem!)).toBe("Couldn't load the portal access")
    // The designer's read alone: its row (and the portal's) say it; the supervisor's rows stand.
    const designerOut = peopleOf(input({ looksAfter: looks({ designer: DESIGNER_CASES.error }) }))
    expect(said(rowOf(designerOut.rows, 'designer').parts[0]!.say)).toBe("Couldn't read the factory designer")
    expect(rowOf(designerOut.rows, 'designer').doors!.map((door) => door.door)).toEqual([{ kind: 'act', act: 'retryDesigner' }])
    expect(rowOf(designerOut.rows, 'portal').state).toBe('unread')
    expect(valueOf(rowOf(designerOut.rows, 'supervisor'))).toBe(OFFICE_PEOPLE.bea.name)
    expect(rowOf(peopleOf(input({ looksAfter: looks({ designer: DESIGNER_CASES.loading }) })).rows, 'designer').state).toBe('reading')
    // Office names to the office only: without partners.view nothing is read — the customer's own contacts, no Portal row.
    expect(peopleOf(input()).rows.every((each) => each.key.startsWith('contact-') || each.key.startsWith('nobody'))).toBe(true)
    expect(allWords(overviewOf(input()), 'en')).not.toContain(OFFICE_PEOPLE.bea.name)
    expect(allWords(overviewOf(input({ looksAfter: looks() })), 'en')).toContain(OFFICE_PEOPLE.bea.name)
    // The customer's urgency: the SAME production read (no second read); off without partners.view.
    expect(urgencyOf(null)).toEqual({ status: 'off' })
    expect(urgencyOf(looks())).toEqual({ status: 'ready', value: SUPERVISOR_CASES.saved.read!.production.urgency })
    expect(urgencyOf(looks({ supervisor: { ...SUPERVISOR_CASES.saved, state: 'loading', read: null } }))).toEqual({ status: 'reading' })
    expect(urgencyOf(looks({ supervisor: { ...SUPERVISOR_CASES.saved, state: 'error', read: null } }))).toEqual({ status: 'failed' })
  })

  it('Next dates: a late one first, then the nearest; the VALUE is the door; nothing at all → the card is left out (S24)', () => {
    const dates = datesOf(
      input({
        glance: ready(glance({ samples: { count: 1, rows: [{ id: 's1', number: 'SEED-SR-0001', kind: 'FIT', roundNo: 1, stage: 'IN_MAKING', style: { id: 'st', code: 'SEED-ST', name: 'Seed style' }, dueDate: TODAY, daysLate: 0 }] }, promises: { open: 8, late: 1, noPromise: 1, next: '2026-11-27' } })),
        money: { ...NO_MONEY, orders: loaded([{ id: 'o13', number: 'SEED-SO-0013', currency: 'EUR', deposit: { state: 'OPEN', dueDate: '2026-11-25' } }]), complaints: loaded(COMPLAINTS) },
      }),
    )!
    expect(dates.rows.map((row) => row.key)).toEqual(['late', 'complaint', 'sample', 'deposit', 'promise'])
    expect(valueOf(rowOf(dates.rows, 'late'))).toBe('1 order past the promise date')
    expect(said(rowOf(dates.rows, 'late').tag!.say, 'it')).toBe('in ritardo')
    expect(valueOf(rowOf(dates.rows, 'sample'))).toBe('SEED-SR-0001 · 24/11/2026')
    expect(said(rowOf(dates.rows, 'sample').tag!.say)).toBe('today')
    expect(said(rowOf(dates.rows, 'deposit').tag!.say)).toBe('in 1 d')
    expect(hrefOf({ door: rowOf(dates.rows, 'deposit').parts[0]!.door! })).toBe(`${BASE}?tab=money#collect`)
    // S5: "n without a promise date" as plain words inside the next-promise row (no door).
    const promise = rowOf(dates.rows, 'promise')
    expect(said(promise.label)).toBe('Next promise')
    expect(valueOf(promise)).toBe('27/11/2026 · 1 without a promise date')
    expect(promise.parts[1]!.door).toBeUndefined()
    expect(said(rowOf(dates.rows, 'complaint').tag!.say)).toBe('19 d late')
    // Without the Money tab a deposit's door is the Work tab's orders waiting for a deposit.
    const noMoney = datesOf(input({ can: { ...CAN, moneyTab: false }, money: { ...NO_MONEY, orders: loaded([{ id: 'o13', number: 'SEED-SO-0013', currency: 'EUR', deposit: { state: 'OPEN', dueDate: '2026-11-25' } }]) } }))!
    expect(hrefOf({ door: rowOf(noMoney.rows, 'deposit').parts[0]!.door! })).toBe(`${BASE}?tab=work&deposit=OPEN`)
    // Nothing to say: left out. Still read: a skeleton. The glance failed: said, with no other row.
    const calm: Partial<OverviewInput> = { reads: reads({ board: board({ COMPLETED: 2 }), ...QUIET }), standing: { status: 'ready', value: standing({ nextPromise: null }) } }
    expect(datesOf(input(calm))).toBeNull()
    expect(datesOf(input({ ...calm, money: { ...NO_MONEY, complaints: loading() } }))).toMatchObject({ rows: [], reading: true })
    expect(said(datesOf(input({ ...calm, glance: failedRead('problem.unavailable') }))!.failed!)).toBe('The sample dates could not be read')
  })

  it('Requests & changes: the Work band\'s own counts by who waits, each a door; nothing waits → the card is left out (S24)', () => {
    const card = requestsOf(input({ reads: reads({ asks: { status: 'ready', value: { items: [], complete: true } }, requests: { status: 'ready', value: { items: [], open: 2, countered: 1 } } }), counts: { counts: counts({ TO_ANSWER: 1, ORDER_WAITS: 1 }), failed: false } }))!
    expect(card.state).toBe('ready')
    expect(card.groups.map((group) => [said(group.title), group.count, group.rows.map((row) => `${said(row.words)} ${row.count}`)])).toEqual([
      ['Waiting on us', '5', ['Requests to answer 2', 'Replies waiting on us 1', 'To answer 1', 'Accepted, order waits 1']],
      ['Waiting on Seed Racing', '1', ['Waiting for Seed Racing 1']],
      ['Tasks', '1', ['Open tasks 1']],
    ])
    const [us, them, tasks] = card.groups
    expect(us!.rows.map((row) => hrefOf(row.door ?? undefined))).toEqual([`${BASE}?tab=work`, `${BASE}?tab=work&dock=all&thread=open`, `${BASE}?tab=quotes&group=TO_ANSWER`, `${BASE}?tab=quotes&group=ORDER_WAITS`])
    // The two windows open on the Work tab (the page goes there first).
    expect(them!.rows[0]!.door!.door).toEqual({ kind: 'window', window: 'customer' })
    expect(tasks!.rows[0]!.door!.door).toEqual({ kind: 'window', window: 'tasks' })
    expect(said(us!.title, 'it')).toBe('Tocca a noi')
    expect(requestsOf(input({ reads: reads(QUIET), counts: { counts: counts(), failed: false } }))).toBeNull()
    expect(requestsOf(input({ reads: reads({ tasks: { status: 'reading' } }) }))).toEqual({ state: 'reading', groups: [] })
    expect(requestsOf(input({ reads: reads({ replies: { status: 'failed' } }) }))).toEqual({ state: 'failed', groups: [] })
    // Without the Work tab (no orders.view) and without Quotes & incoming: the counts stay, the doors are not there.
    const bare = requestsOf(input({ can: { ...CAN, orders: false, quotesTab: false } }))!
    expect(bare.groups.flatMap((group) => group.rows).every((row) => row.door === null)).toBe(true)
  })

  it('Linked records: one row per kind whose value is the door; a kind with nothing joins "None yet"; a kind without its right is left out', () => {
    const linked = linkedOf(
      input({
        standing: { status: 'ready', value: standing({ customerUrgent: { count: 3, byCompany: [] }, priority: { top: 1, high: 1 } }) },
        counts: { counts: counts({ TO_ANSWER: 1, WRITING: 2, ORDER_WAITS: 1 }, { openQuotes: 3 }), failed: false },
        glance: ready(glance({ samples: demoGlance('MODA-DEMO').samples, repairs: demoGlance('MODA-DEMO').repairs })),
        money: { ...NO_MONEY, returns: loaded(RETURNS), complaints: loaded(COMPLAINTS), returnsHref: '/w/DEMO/sales/returns?partyId=x' },
        projects: { open: 1, all: 2 },
      }),
    )
    const orders = rowOf(linked.rows, 'orders')
    expect(valueOf(orders)).toBe('8 open of 14 · 1 late · Urgent (customer) 3 · Priority Top 1 · Priority High 1')
    expect(valueOf(orders, 'it')).toBe('8 aperti su 14 · 1 in ritardo · Urgente (cliente) 3 · Priorità Massima 1 · Priorità Alta 1')
    expect(orders.parts.map((part) => hrefOf({ door: part.door! }))).toEqual([`${BASE}?tab=work&rows=open`, `${BASE}?tab=work&late=true`, `${BASE}?tab=work&customerUrgency=URGENT`, `${BASE}?tab=work&rows=open&priority=URGENT`, `${BASE}?tab=work&rows=open&priority=HIGH`])
    expect(valueOf(rowOf(linked.rows, 'quotes'))).toBe('3 open · 1 accepted, order waits')
    expect(valueOf(rowOf(linked.rows, 'incoming'))).toBe('1 to answer · 2 drafts')
    expect(valueOf(rowOf(linked.rows, 'samples'))).toBe('3 in progress · next SR-2026-0041 due 24/10/2026')
    expect(valueOf(rowOf(linked.rows, 'repairs'))).toMatch(/^1 in progress · oldest RP-2026-0007, opened \d{2}\/10\/2026$/)
    expect(valueOf(rowOf(linked.rows, 'returns'))).toBe('2 open · oldest RMA-2026-0007, asked 12/09/2026')
    expect(valueOf(rowOf(linked.rows, 'returns'), 'it')).toBe('2 aperti · il più vecchio RMA-2026-0007, richiesto il 12/09/2026')
    // S28: a complaints list with the customer as its term exists (Quality › Complaints reads ?partyId=): the row opens it.
    const complaints = rowOf(linked.rows, 'complaints')
    expect(valueOf(complaints)).toBe('1 open · next answer CMP-2026-0004 due 05/11/2026')
    expect(hrefOf({ door: complaints.parts[0]!.door! })).toBe(`/w/DEMO/quality/complaints?partyId=${ID}`)
    expect(valueOf(rowOf(linked.rows, 'projects'))).toBe('1 open of 2')
    expect(linked.none).toEqual([])
    expect(linked.quiet.map((door) => hrefOf(door))).toEqual([`/w/DEMO/production/work-orders?party=${ID}`, `/w/DEMO/finance/receivables?party=${ID}`])
    // A quiet customer: every readable kind with nothing is named once; no row says 0.
    const calm = linkedOf(input({ reads: reads({ board: board({}), ...QUIET }), counts: { counts: counts(), failed: false }, projects: { open: 0, all: 0 } }))
    expect(calm.rows).toEqual([])
    expect(calm.none.map((label) => said(label))).toEqual(['Orders', 'Quotes', 'Incoming', 'Sample rounds', 'Repairs', 'Returns', 'Complaints', 'Projects'])
    // No right: the kind is left out (the API sends null / the read is never made), and its door with it.
    const walled = linkedOf(input({ can: { ...CAN, orders: false, quotesTab: false, returns: false, complaints: false, workorders: false, receivables: false }, reads: reads({ board: { status: 'off' } }), counts: { counts: counts({ TO_ANSWER: null, WRITING: null, ORDER_WAITS: null }, { openQuotes: null, waitsOnUs: null }), failed: false }, glance: ready(glance({ samples: null, repairs: null })) }))
    expect(walled.rows).toEqual([])
    expect(walled.none).toEqual([])
    expect(walled.quiet).toEqual([])
    // A failed read says so in its row.
    expect(rowOf(linkedOf(input({ money: { ...NO_MONEY, returns: failed('problem.unavailable') } })).rows, 'returns').state).toBe('unread')
    expect(rowOf(linkedOf(input({ reads: reads({ board: { status: 'reading' } }) })).rows, 'orders').state).toBe('reading')
  })

  it('S33: "n open" of returns and complaints only from a WHOLE read; a cut read says "Open" and its door — no number, no named one', () => {
    // The complaints read's limit is the one the page asks (../../money/api.ts): the rule's constant follows it, letter for letter.
    expect(readFileSync(new URL('../../money/api.ts', import.meta.url), 'utf8')).toContain(`query: { partyId, view: 'open', limit: ${COMPLAINTS_READ} }`)
    const RETURNS_HREF = `/w/DEMO/sales/returns?partyId=${ID}`
    const complaintsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ ...COMPLAINTS[0]!, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, number: `CMP-2026-${String(index + 1).padStart(4, '0')}` }))
    const linkedWith = (returns: OverviewMoney['returns'], complaints: OverviewMoney['complaints']) => linkedOf(input({ money: { ...NO_MONEY, returns, complaints, returnsHref: RETURNS_HREF } }))

    // Whole: the API did not cut the returns (more false); the open complaints came back shorter than the limit.
    const whole = linkedWith(loaded(RETURNS, false), loaded(complaintsOf(COMPLAINTS_READ - 1)))
    expect(valueOf(rowOf(whole.rows, 'returns'))).toBe('2 open · oldest RMA-2026-0007, asked 12/09/2026')
    expect(valueOf(rowOf(whole.rows, 'complaints'))).toBe(`${COMPLAINTS_READ - 1} open · next answer CMP-2026-0001 due 05/11/2026`)

    // Cut: the API says more returns exist; the complaints filled the limit. The state and the door — no figure, no named one.
    const cut = linkedWith(loaded(RETURNS, true), loaded(complaintsOf(COMPLAINTS_READ)))
    for (const key of ['returns', 'complaints'] as const) {
      const row = rowOf(cut.rows, key)
      expect(row.parts).toHaveLength(1)
      for (const locale of LOCALES) {
        expect(valueOf(row, locale), `${key} ${locale}`).toBe(locale === 'en' ? 'Open' : 'Aperti')
        expect(valueOf(row, locale), `${key} ${locale}`).not.toMatch(/\d/)
      }
    }
    expect(hrefOf({ door: rowOf(cut.rows, 'returns').parts[0]!.door! })).toBe(RETURNS_HREF)
    expect(hrefOf({ door: rowOf(cut.rows, 'complaints').parts[0]!.door! })).toBe(`/w/DEMO/quality/complaints?partyId=${ID}`)
    expect(cut.none).toEqual([])
    // Next dates names the complaint whose answer is due first only from a whole read (a cut one may miss it).
    const datesWith = (count: number) => (datesOf(input({ money: { ...NO_MONEY, complaints: loaded(complaintsOf(count)) } }))?.rows ?? []).map((row) => row.key)
    expect(datesWith(COMPLAINTS_READ - 1)).toContain('complaint')
    expect(datesWith(COMPLAINTS_READ)).not.toContain('complaint')

    // Cut with no open one in it: neither a row nor "None yet" (an older one may still be open; a whole read with none says "None yet").
    const closedOnly = RETURNS.filter((entry) => entry.status === 'CLOSED')
    expect(linkedWith(loaded(closedOnly, true), loaded([])).rows.some((row) => row.key === 'returns')).toBe(false)
    expect(linkedWith(loaded(closedOnly, true), loaded([])).none.map((label) => said(label))).not.toContain('Returns')
    expect(linkedWith(loaded(closedOnly, false), loaded([])).none.map((label) => said(label))).toContain('Returns')
  })

  it('S37: a next date (or an oldest one) from a read that may be cut is named only when that read is ordered earliest first by that day; else it is left out', () => {
    // How each read is ordered where it is cut (checked in the API): only the glance's sample rounds are earliest first.
    expect(EARLIEST_FIRST).toEqual({ deposits: false, tasks: false, asks: false, complaints: false, samples: true, repairs: false })
    const keysOf = (given: Partial<OverviewInput>): string[] => (datesOf(input(given))?.rows ?? []).map((row) => row.key)
    // Deposits (the open orders' read, newest order first): whole → named; a next page exists → left out.
    expect(keysOf({ money: { ...NO_MONEY, orders: loaded([{ id: 'o13', number: 'SEED-SO-0013', currency: 'EUR', deposit: { state: 'OPEN', dueDate: '2026-11-25' } }], false) } })).toContain('deposit')
    expect(keysOf({ money: { ...NO_MONEY, orders: loaded([{ id: 'o13', number: 'SEED-SO-0013', currency: 'EUR', deposit: { state: 'OPEN', dueDate: '2026-11-25' } }], true) } })).not.toContain('deposit')
    // Tasks and our asks (the newest by creation are read, then sorted by due day): complete → named; not complete → left out.
    const TASKS = [{ id: 't1', title: 'Made-up task', dueDate: '2026-11-26' }] as never
    const ASKS = [{ id: 'a1', status: 'OPEN', dueAt: '2026-11-26T10:00:00.000Z', words: { it: 'Una richiesta inventata', en: 'A made-up ask' } }] as never
    for (const complete of [true, false]) {
      const keys = keysOf({ reads: reads({ tasks: { status: 'ready', value: { items: TASKS, total: 1, complete } }, asks: { status: 'ready', value: { items: ASKS, complete } } }) })
      expect(keys.includes('task'), `tasks complete: ${complete}`).toBe(complete)
      expect(keys.includes('ask'), `asks complete: ${complete}`).toBe(complete)
    }
    // Sample rounds (by due day, nearest first): named from a cut read too (3 in progress, 2 rows sent).
    const samples = demoGlance('MODA-DEMO').samples!
    expect(samples.rows.length).toBeLessThan(samples.count)
    expect(keysOf({ glance: ready(glance({ samples })) })).toContain('sample')
    // Linked records' repairs (newest first): "oldest …" only when every repair is in the read; the count is a count read and stays.
    const repairs = demoGlance('MODA-DEMO').repairs!
    const repairsSaid = (value: NonNullable<Glance['repairs']>): string => valueOf(rowOf(linkedOf(input({ glance: ready(glance({ repairs: value })) })).rows, 'repairs'))
    expect(repairsSaid(repairs)).toMatch(/^1 in progress · oldest RP-2026-0007, opened \d{2}\/10\/2026$/)
    expect(repairsSaid({ ...repairs, count: 7 })).toBe('7 in progress')
  })

  it('the glance\'s parts (10-design §7, §9; picture 20, failed): still read → the row\'s skeleton, failed → "Could not be read" in the row; without the part\'s own right → left out', () => {
    const stateOf = (rows: readonly { readonly key: string; readonly state?: 'reading' | 'unread' }[], key: string) => rows.find((row) => row.key === key)?.state ?? null
    for (const [read, state] of [[LOADING, 'reading'], [failedRead('problem.unavailable'), 'unread']] as const) {
      const linked = linkedOf(input({ glance: read })).rows
      expect(stateOf(linked, 'samples'), state).toBe(state)
      expect(stateOf(linked, 'repairs'), state).toBe(state)
      const facts = factsOf(input({ glance: read })).rows
      expect(stateOf(facts, 'requirements'), state).toBe(state)
      expect(stateOf(facts, 'credit'), state).toBe(state)
      // Without its right a part is never named, whatever the glance's state (the requirements need no right beyond the page's).
      const walled = { ...CAN, samples: false, repairs: false, credit: false }
      expect(linkedOf(input({ glance: read, can: walled })).rows.some((row) => row.key === 'samples' || row.key === 'repairs'), state).toBe(false)
      expect(factsOf(input({ glance: read, can: walled })).rows.map((row) => row.key).filter((key) => key === 'requirements' || key === 'credit'), state).toEqual(['requirements'])
    }
    // The facts keep their place in the card while the glance is out (requirements, then credit, then since).
    expect(factsOf(input({ glance: LOADING })).rows.map((row) => row.key).slice(4, 8)).toEqual(['identity', 'requirements', 'credit', 'since'])
    // Read: the credit only with its right, even when the answer carries it.
    expect(factsOf(input({ glance: ready(glance({ credit: OVER })), can: { ...CAN, credit: false } })).rows.some((row) => row.key === 'credit')).toBe(false)
    // Quotes & incoming's ONE count read out: Quotes AND Incoming each say so in their row (reading, then failed).
    const beforeStates = (failed: boolean) => linkedOf(input({ counts: { counts: null, failed } })).rows.filter((row) => row.key === 'quotes' || row.key === 'incoming').map((row) => [row.key, row.state])
    expect(beforeStates(false)).toEqual([['quotes', 'reading'], ['incoming', 'reading']])
    expect(beforeStates(true)).toEqual([['quotes', 'unread'], ['incoming', 'unread']])
    // Next dates' failed line names the sample dates: only for a reader who may read them.
    const calm: Partial<OverviewInput> = { reads: reads({ board: board({ COMPLETED: 2 }), ...QUIET }), standing: { status: 'ready', value: standing({ nextPromise: null }) } }
    expect(datesOf(input({ ...calm, glance: failedRead('problem.unavailable') }))?.failed).not.toBeNull()
    expect(datesOf(input({ ...calm, glance: failedRead('problem.unavailable'), can: { ...CAN, samples: false } }))).toBeNull()
  })

  it('Customer facts: ONE Edit (parties.manage); the credit only when the read carries it; what is to complete with today\'s own step', () => {
    const facts = factsOf(input({ party: party({ internalNote: 'Made-up office note.', warnings: [{ code: 'NO_DEFAULT_SHIP_TO', message: '', blocksInvoice: false }, { code: 'NO_DEFAULT_BILL_TO', message: '', blocksInvoice: false }] }), glance: ready(glance({ credit: { ...OVER, state: 'WITHIN', available: 1_580_000, overLimitBy: 0 }, requirements: demoGlance('MODA-DEMO').requirements })) }))
    const value = (key: string, locale: Locale = 'en') => facts.rows.find((row) => row.key === key)!.parts.map((part) => said(part.say, locale)).join(' · ')
    expect(facts.rows.map((row) => row.key)).toEqual(['legalName', 'tradeName', 'kind', 'payment', 'identity', 'requirements', 'credit', 'since', 'complete-NO_DEFAULT_SHIP_TO', 'complete-NO_DEFAULT_BILL_TO', 'note'])
    expect(value('kind')).toBe('Company · Italian')
    expect(value('kind', 'it')).toBe('Azienda · Italiano')
    // "valid from …": quiet words after the door, on the same line (10-design §8; picture 20) — no door of its own.
    expect(value('identity')).toBe('Italian business · VAT IT00000000000 · 00000000000 · SDI DEMO123 · valid from 01/01/2026')
    const identity = facts.rows.find((row) => row.key === 'identity')!
    expect(identity.parts.map((part) => [part.door?.kind ?? null, part.quiet === true])).toEqual([['href', false], [null, true]])
    expect(value('requirements')).toBe('3')
    expect(value('credit')).toBe('€15,800.00 free of a €20,000.00 limit')
    expect(value('since')).toBe('28/10/2025 · changed 20/11/2026')
    expect(value('note')).toBe('Made-up office note.')
    expect(facts.edit?.door).toEqual({ kind: 'act', act: 'edit' })
    // ONE "Add address" for two address warnings.
    expect(facts.rows.filter((row) => row.key.startsWith('complete-')).map((row) => row.door?.key ?? null)).toEqual(['address', null])
    // Without the price grain the API drops the amounts: the words alone. Without sales.credit.view: no credit fact at all.
    const bare = factsOf(input({ glance: ready(withoutPrices(glance({ credit: { ...OVER, state: 'WITHIN' } }))) }))
    expect(bare.rows.find((row) => row.key === 'credit')!.parts.map((part) => said(part.say))).toEqual(['Within the limit'])
    expect(factsOf(input()).rows.some((row) => row.key === 'credit')).toBe(false)
    // Without parties.manage: no Edit and no step button; archived: Edit held with words.
    const reader = factsOf(input({ can: { ...CAN, manage: false }, party: party({ warnings: [{ code: 'NO_DEFAULT_SHIP_TO', message: '', blocksInvoice: false }] }) }))
    expect(reader.edit).toBeNull()
    expect(reader.rows.every((row) => row.door === undefined)).toBe(true)
    expect(said(factsOf(input({ party: party({ status: 'ARCHIVED' }) })).edit!.held!)).toBe('Archived: reactivate it first')
    expect(said(factsOf(input()).rows.find((row) => row.key === 'note')!.parts[0]!.say, 'it')).toBe('Nessuna nota')
  })

  it('card 2: the band — or, with no order at all, one quiet line; off without orders.view', () => {
    expect(bandStateOf(input())).toBe('band')
    expect(bandStateOf(input({ reads: reads({ board: { status: 'reading' } }) }))).toBe('band')
    expect(bandStateOf(input({ reads: reads({ board: board({}) }) }))).toBe('none')
    expect(bandStateOf(input({ can: { ...CAN, orders: false } }))).toBe('off')
  })
})

describe('the walls (13-backend §4)', () => {
  const RULES = ['./model.ts', './headline.ts', './strips.ts', './rows.ts', './doors.ts'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
  const [, HEADLINE, STRIPS, ROWS] = RULES

  it('nothing of another customer: the rules take ONE customer\'s reads, read no list of customers and count nothing from a list of orders or quotes', () => {
    for (const source of [HEADLINE!, STRIPS!, ROWS!]) {
      expect(source).not.toContain('.items.length')
      expect(source).not.toContain('.filter(')
      expect(source).not.toMatch(/byParty|partyIds|listOrders|listQuotes|model\.orders|model\.quotes/)
    }
    // Pure: no React, no hook, no fetch.
    for (const source of RULES) expect(source).not.toMatch(/from 'react'|useEffect|useState|api\.get\(|fetch\(/)
    // Every door is this customer's own address (its id), a record of its own, or a list with it as the term.
    const model = overviewOf(input({ money: { ...NO_MONEY, ageing: loaded(LATE), returns: loaded(RETURNS), complaints: loaded(COMPLAINTS) }, projects: { open: 1, all: 1 } }))
    const doors = [...model.strips.rows.flatMap((row) => row.doors), ...model.linked.quiet, model.people.head].map((door) => hrefOf(door)).filter((href): href is string => href !== null)
    const values = [...model.people.rows, ...(model.dates?.rows ?? []), ...model.linked.rows].flatMap((row) => row.parts).flatMap((part) => (part.door?.kind === 'href' ? [part.door.href] : []))
    for (const href of [...doors, ...values]) expect(href.includes(ID) || href.includes(MODA.code) || /\/quality\/complaints\//.test(href), href).toBe(true)
  })

  it('no amount without the price grain: with the amounts dropped by the API no word of the tab holds one', () => {
    const noGrain = input({
      glance: ready(withoutPrices(glance({ hold: { onHold: true, holds: [hold('CREDIT')] }, credit: OVER }))),
      money: { ...NO_MONEY, ageing: loaded(LATE.map((row) => ({ ...row, open: undefined, overdue: undefined, buckets: undefined }))), orders: loaded([{ id: 'o13', number: 'SEED-SO-0013', currency: 'EUR', deposit: { state: 'OPEN', dueDate: '2026-11-25' } }]) },
    })
    for (const locale of LOCALES) {
      const words = allWords(overviewOf(noGrain), locale)
      expect(words, locale).not.toMatch(/€|\d[\d.,]*\s?(EUR|€)/)
      expect(words, locale).toContain(locale === 'en' ? 'Over the credit limit' : 'Oltre il fido')
      expect(words, locale).toContain(locale === 'en' ? 'Invoices are late' : 'Ci sono fatture scadute')
    }
    // The web's own half of the wall: even if a read carried the fields, a reader without money.price is said no amount.
    const leaked = overviewOf(input({ can: { ...CAN, price: false }, glance: ready(glance({ hold: { onHold: true, holds: [hold('CREDIT')] }, credit: OVER })), money: { ...NO_MONEY, ageing: loaded(LATE) } }))
    for (const locale of LOCALES) expect(allWords(leaked, locale), locale).not.toMatch(/€|\d[\d.,]*\s?(EUR|€)/)
    expect(allWords(overviewOf(input({ can: { ...CAN, price: false }, glance: ready(glance({ credit: { ...OVER, state: 'WITHIN', available: 1_580_000 } })) })), 'en')).toContain('Within the limit')
    // With the grain the same reads carry them.
    expect(allWords(overviewOf(input({ glance: ready(glance({ credit: OVER })), money: { ...NO_MONEY, ageing: loaded(LATE) } })), 'en')).toContain('€4,270.00')
  })

  it('office names to the office only: the model names the customer\'s own contacts and who placed a hold — no other person', () => {
    const model = overviewOf(input({ glance: ready(glance({ hold: { onHold: true, holds: [hold('LEGAL', { placedBy: 'Alex Demo' })] } })) }))
    const words = allWords(model, 'en')
    expect(words).toContain('Alex Demo')
    expect(words).toContain('Anna Demo')
    // No read of the Overview is a portal route, and none names a floor worker (the reads are the office's: see ../CustomerRecord.tsx).
    // F-CO-201: the rules read "Who looks after" through the office side's own folder (Customer › Portal settings, cu/portal/*: its
    // models, read with partners.view) — the ONLY "portal" path they may name; never a portal route.
    for (const source of RULES) {
      expect(source).not.toMatch(/['"`]\/portal\/|operator|worker/i)
      expect(source.replace(/\.\.\/\.\.\/portal\/(?:designer|limits)\/(?:model|api)'/g, '').replace(/\.\.\/\.\.\/portal\/CustomerSupervisor\.tsx/g, '')).not.toMatch(/\/portal\//)
    }
  })

  it('left out, hidden, never held for a right: every held word is a STATE\'s, in both languages no key is left', () => {
    const everything = overviewOf(
      input({
        party: party({ status: 'ARCHIVED', invoiceBlocked: true, warnings: [{ code: 'NO_TAX_IDENTITY', message: '', blocksInvoice: true }, { code: 'VIES_NOT_PROVEN', message: '', blocksInvoice: false }, { code: 'FISCAL_DRAWER', message: '', blocksInvoice: false }] }),
        glance: ready(glance({ hold: { onHold: true, holds: [hold('CREDIT')] }, credit: OVER })),
        money: { ...NO_MONEY, ageing: loaded(LATE), returns: loaded(RETURNS), complaints: loaded(COMPLAINTS) },
      }),
    )
    const held = [...everything.strips.rows.flatMap((row) => row.doors), ...everything.facts.rows.flatMap((row) => (row.door ? [row.door] : [])), ...(everything.facts.edit ? [everything.facts.edit] : [])].flatMap((door) => (door.held ? [door.held] : []))
    expect(held.length).toBeGreaterThan(2)
    for (const words of held) expect(said(words)).toBe('Archived: reactivate it first')
    for (const locale of LOCALES) {
      const text = [allWords(everything, locale), ...held.map((words) => said(words, locale)), ...everything.facts.rows.map((row) => said(row.label, locale)), ...everything.linked.none.map((label) => said(label, locale))].join('\n')
      expect(text).not.toMatch(/Not shown: your role|Non mostrato: il tuo ruolo/)
      expect(text.match(/\b(?:customers|status|side|record|warning|step|vies|held|field|kind|taxMode|identity|list|common|credit|promises|reason|hold|prom|col|work|group|urgency|limits|customerCard|tab)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/)?.[0] ?? null, locale).toBeNull()
      expect(text).not.toMatch(/\{[a-z]+\}/)
    }
  })
})
