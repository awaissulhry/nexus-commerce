import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PARTY_TAX_MODES } from '@nexus/factory-domain/parties/tax'
import { PARTY_STATUSES } from '@nexus/factory-domain/parties/rules'
import { VIES_STATES } from '@nexus/factory-domain/parties/vies'
import { QUOTE_ISSUE_CODES } from '@nexus/factory-domain/sales/quotes/quotes'
import { SEND_CHECK_CODES } from '@nexus/factory-domain/sales/quotes/send'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { permissionCheck } from '../../../lib/session/session'
import { firstOfficePage, navPages, officeNavFor } from '../../../shell/nav/office-nav'
import { designScreen as sendScreen } from '../../_shared/document-send/fixtures'
import { orderedChecks, parseCc, sendHeld } from '../../_shared/document-send/model'
import { designScreen as approvalsScreen } from '../../home/approvals/fixtures'
import { APPROVAL_VIEWS, heldKey, recheck } from '../../home/approvals/model'
import { designScreen as acceptScreen } from '../../../links/quote-accept/fixtures'
import { declineNote, DECLINE_REASONS, groupedIban, privacyCompany } from '../../../links/quote-accept/model'
import { APPROVAL_REASONS, APPROVAL_STATUSES, DECIDE_HELD, QUOTE_ORDER_WAITS, VERSION_STATUSES } from './api'
import { designScreen as listScreen } from './list/fixtures'
import {
  abilitiesOf,
  decideHeld,
  filtersOfTile,
  gridShapeOf,
  grainsOf,
  isExpiring,
  lineWrites,
  linkSummary,
  marginTone,
  nextAfter,
  nextStep,
  parsePercent,
  parsePrice,
  QUOTE_TABS,
  QUOTE_TILES,
  MERGED_TABS,
  tabOf,
  styleBlocks,
  termsDraftOf,
  termsPatch,
  tileCount,
  tileOfFilters,
} from './model'
import { designScreen as recordScreen, belowFloor, CAN, pending, PEOPLE, quote, SENT_VERSION, STYLE, version } from './record/fixtures'
import { PASSING_CHECKS, sendItems } from './record/send-model'
// ---- F-SA-277: the Quotes list lifted for the customer's Quotes & incoming ----
import { createTranslator } from '../../../lib/i18n/messages'
import type { ListToolsTransport } from '../../../list-frame/tools/transport'
import { scopedTransport } from '../_shared/scoped-list-tools/ScopedListTools'
import { NO_FILTERS, type ListFilters } from './model'
import { filtersOf, QUOTES_LIST_KEY, quotesAddress, quotesFiltersFor, quotesFromQuery, quotesReadOf, quotesTileReadOf, quotesToolsQuery, searchOf } from './list/use-quotes-list'
// ---- end F-SA-277
// ---- F-CP-146: no price key from a person without the price grain ----
import type { ApiClient } from '../../../lib/api/client'
import { addLine, editLine } from './api'
import { pricedSendHeld, QUOTE_LINE_PRICE_KEYS, quoteLineBody } from './model'
// ---- end F-CP-146
import { quoteSchema } from './api' // B-CP-012: the quote as the API answers a person without the price grain
import { needsApprovalKey } from './model' // B-CP-012

/**
 * The quote screens' rules (SCR-030, 034, 035, 037, 099): the next step and why it is held, four eyes, the grid → line
 * writes, the tiles, the send checks, the link page's helpers; every key they name in both languages; and every design
 * case drawn in it and en with no key left on screen (the cases render on the server, as /design first draws them).
 */

const echo = (key: string, params?: Record<string, string | number>) => (params ? `${key}:${JSON.stringify(params)}` : key)

describe('the next step of a quote, held with its reason (design "Next step by state")', () => {
  const sales = CAN.sales
  it('a draft: Send, or Ask for approval when a rule breaks (held while something blocks the request)', () => {
    expect(nextStep(quote(), PEOPLE.sales, sales)).toEqual({ step: 'send', held: null })
    expect(nextStep(belowFloor(), PEOPLE.sales, sales)).toEqual({ step: 'askApproval', held: null })
    const blocked = belowFloor({ canAskApproval: false, issues: [{ code: 'COST_INCOMPLETE', severity: 'BLOCKS', path: 'lines/0', message: '', lineId: null, size: null }] })
    expect(nextStep(blocked, PEOPLE.sales, sales)).toEqual({ step: 'askApproval', held: { key: 'issue.COST_INCOMPLETE', params: { size: '' } } })
    expect(nextStep(quote(), PEOPLE.finance, CAN.finance).held).toEqual({ key: 'held.noSend' })
  })

  it('waiting: the requester withdraws; an approver decides; sent: a new version', () => {
    expect(nextStep(pending(), PEOPLE.sales, sales).step).toBe('withdraw')
    expect(nextStep(pending(), PEOPLE.finance, CAN.finance).step).toBe('decide')
    expect(nextStep(pending(PEOPLE.owner), PEOPLE.owner, CAN.owner).step).toBe('withdraw')
    const sent = quote({ status: 'SENT', current: { status: 'SENT' } })
    expect(nextStep(sent, PEOPLE.sales, sales)).toEqual({ step: 'revise', held: null })
    expect(nextStep(quote({ status: 'ACCEPTED', current: { status: 'ACCEPTED' } }), PEOPLE.sales, sales).step).toBe('none')
  })

  it('four eyes: never the requester; a margin request needs the margin grain', () => {
    const grains = grainsOf(['money.price', 'money.margin'])
    expect(decideHeld(pending(PEOPLE.owner), PEOPLE.owner, CAN.owner, grains)).toBe('decide.held.OWN_REQUEST')
    expect(decideHeld(pending(), PEOPLE.finance, CAN.finance, grains)).toBeNull()
    expect(decideHeld(pending(), PEOPLE.finance, CAN.finance, grainsOf(['money.price']))).toBe('decide.held.NEEDS_MARGIN')
    expect(decideHeld(pending(), PEOPLE.finance, CAN.sales, grains)).toBe('decide.held.NO_RIGHT')
    expect(decideHeld(quote(), PEOPLE.finance, CAN.finance, grains)).toBe('decide.held.NOT_WAITING')
  })

  it('reads grains and abilities from the session permissions', () => {
    expect(grainsOf(['money.price', 'money.margin'])).toEqual({ price: true, cost: false, margin: true })
    expect(abilitiesOf(['quotes.view', 'quotes.send'])).toEqual({ view: true, manage: false, approve: false, send: true })
    expect(marginTone('18.9', '20')).toBe('warning')
    expect(marginTone('-2', '20')).toBe('danger')
    expect(marginTone('34.5', '20')).toBe('success')
    expect(marginTone(undefined, '20')).toBeNull()
  })
})

describe('a typed size grid becomes line writes (a line has at least one piece)', () => {
  const lines = quote().lines
  const [blk, red] = lines
  it('adds a colourway that got pieces, edits a changed line, removes one left empty, leaves the rest', () => {
    expect(
      lineWrites(lines, {
        [blk!.colourwayId]: { '50': 2, '52': 4, '54': 2 },
        [red!.colourwayId]: { '50': 0, '52': 0, '54': 0 },
        WHITE: { '50': 1 },
      }),
    ).toEqual([
      { kind: 'remove', lineId: red!.id, colourwayId: red!.colourwayId },
      { kind: 'add', colourwayId: 'WHITE', sizes: [{ size: '50', quantity: 1 }] },
    ])
    expect(lineWrites(lines, { [blk!.colourwayId]: { '50': 3, '52': 4, '54': 2 } })).toEqual([{ kind: 'edit', lineId: blk!.id, colourwayId: blk!.colourwayId, sizes: [{ size: '50', quantity: 3 }, { size: '52', quantity: 4 }, { size: '54', quantity: 2 }] }])
    expect(lineWrites(lines, { EMPTY: { '50': 0 } })).toEqual([])
  })

  it('groups lines by style and draws the style\'s sizes and offered cells', () => {
    expect(styleBlocks(lines).map((block) => [block.code, block.lines.length])).toEqual([['DEMO-JKT-01', 2]])
    const shape = gridShapeOf(lines, STYLE, [STYLE.colourways[2]!.id])
    expect(shape.sizes.map((size) => size.key)).toEqual(['46', '48', '50', '52', '54', '56'])
    expect(shape.colours.map((colour) => [colour.label, colour.offered?.length])).toEqual([
      ['BLK · Nero', 6],
      ['RED · Rosso', 5],
      ['WHT · Bianco', 4],
    ])
    // Without the style (not readable): what the lines hold.
    expect(gridShapeOf(lines, null).sizes.map((size) => size.key)).toEqual(['50', '52', '54'])
  })

  it('reads prices and percentages typed either way', () => {
    expect(parsePrice('450')).toBe('450')
    expect(parsePrice('1.250,50')).toBe('1250.50')
    expect(parsePrice('1,250.50')).toBe('1250.50')
    expect(parsePrice('€ 99,9')).toBe('99.9')
    expect(parsePrice('abc')).toBeNull()
    expect(parsePrice('-3')).toBeNull()
    expect(parsePercent('12,5')).toBe('12.5')
    expect(parsePercent('101')).toBeNull()
  })

  it('a terms form sends only what changed (empty text = none)', () => {
    const before = termsDraftOf(quote())
    expect(termsPatch(before, before)).toEqual({})
    expect(termsPatch(before, { ...before, customerRef: '', depositPct: '25', firmOffer: true })).toEqual({ customerRef: null, depositPct: '25', firmOffer: true })
  })
})

describe('the list: tiles are saved filters, counted honestly', () => {
  const rows = listScreen.cases.find((item) => item.id === 'owner')!.model.rows.items!
  it('each tile is one filter set, and the pressed tile is found from the filters', () => {
    for (const tile of QUOTE_TILES) expect(tileOfFilters(filtersOfTile(tile))).toBe(tile)
    expect(tileOfFilters({ ...filtersOfTile('sent'), q: 'x' })).toBeNull()
  })
  it('counts: mine by the creator, expiring within 7 days; unknown is null, never 0', () => {
    expect(tileCount('expiring', rows.filter((row) => row.status === 'SENT'), false, '2026-10-29', PEOPLE.sales).count).toBe(1)
    expect(isExpiring({ status: 'SENT', validUntil: '2026-10-28' }, '2026-10-29')).toBe(false)
    expect(tileCount('myDrafts', null, false, '2026-10-29', PEOPLE.sales)).toEqual({ count: null, more: false })
    expect(tileCount('accepted', rows.filter((row) => row.status === 'ACCEPTED'), true, '2026-10-29', PEOPLE.sales)).toEqual({ count: 1, more: true, value: 5400000 })
  })
})

describe('sending: the checks and the held Send (SCR-037)', () => {
  it('failing checks first with their Fix tab, then what passes', () => {
    const items = sendItems(
      { checks: [{ code: 'NO_PROMISE_DATE', severity: 'BLOCKS', path: 'promiseDate', message: '', lineId: null, size: null }, { code: 'CERTIFICATE', severity: 'WARNING', path: 'lines', message: '', lineId: null, size: '56' }] },
      echo,
      (tab) => `/q?tab=${tab}`,
    )
    expect(items.slice(0, 2)).toEqual([
      { id: 'NO_PROMISE_DATE-0', state: 'blocks', label: 'check.NO_PROMISE_DATE:{"size":""}', fix: { label: 'check.fix', href: '/q?tab=terms' } },
      { id: 'CERTIFICATE-1', state: 'warning', label: 'check.CERTIFICATE:{"size":"56"}', fix: { label: 'check.fix', href: '/q?tab=lines' } },
    ])
    expect(items.filter((item) => item.state === 'passes').map((item) => item.id)).toEqual(PASSING_CHECKS.filter((entry) => entry.id !== 'certificates').map((entry) => `pass-${entry.id}`))
    expect(orderedChecks([...items].reverse())[0]!.state).toBe('blocks')
  })

  it('Send is held with the first blocking check, then the address, never silently disabled', () => {
    const words = { loading: 'loading', busy: 'busy', noRight: 'noRight', noEmail: 'noEmail', cc: (list: string) => `cc ${list}`, sent: 'sent' }
    const ready = { checks: { status: 'ready' as const, items: [] }, sending: false, canSend: true, recipient: { name: 'A', email: 'a@example.com' }, result: null }
    expect(sendHeld(ready, [], words)).toBeNull()
    expect(sendHeld({ ...ready, checks: { status: 'ready', items: [{ id: 'x', state: 'blocks', label: 'Fix me' }] } }, [], words)).toBe('Fix me')
    expect(sendHeld({ ...ready, recipient: { name: 'A', email: null } }, [], words)).toBe('noEmail')
    expect(sendHeld(ready, ['nope'], words)).toBe('cc nope')
    expect(sendHeld({ ...ready, canSend: false }, [], words)).toBe('noRight')
    expect(parseCc('a@example.com; b@example.com, nope a@example.com')).toEqual({ valid: ['a@example.com', 'b@example.com'], invalid: ['nope'] })
  })

  it('the link card: the live link, else the newest one', () => {
    expect(linkSummary([version()])).toBeNull()
    expect(linkSummary([SENT_VERSION])).toMatchObject({ state: 'LIVE', revision: 1 })
  })
})

describe('approvals and the accept link', () => {
  it('re-check: still current only while the quote waits at the version asked about', () => {
    const quoteNow = pending()
    expect(recheck({ status: 'PENDING', quoteVersion: quoteNow.version }, quoteNow)).toBe('current')
    expect(recheck({ status: 'PENDING', quoteVersion: quoteNow.version - 1 }, quoteNow)).toBe('changed')
    expect(recheck({ status: 'APPROVED', quoteVersion: quoteNow.version }, quoteNow)).toBe('changed')
    expect(heldKey({ held: 'OWN_REQUEST' }, false)).toBe('held.OWN_REQUEST')
    expect(heldKey({ held: null }, true)).toBe('held.busy')
    expect(nextAfter([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'b')).toBe('c')
    expect(nextAfter([{ id: 'a' }, { id: 'b' }], 'b')).toBe('a')
    expect(nextAfter([{ id: 'a' }], 'a')).toBeNull()
  })
  it('the link page: the privacy company, the IBAN in groups, the decline note', () => {
    expect(privacyCompany('https://factory.example.com/privacy/0190f0e2-1111-7000-8000-000000000001')).toBe('0190f0e2-1111-7000-8000-000000000001')
    expect(privacyCompany('https://factory.example.com/other')).toBeNull()
    expect(groupedIban('IT60X0542811101000000123456')).toBe('IT60 X054 2811 1010 0000 0123 456')
    expect(declineNote('Il prezzo', '  troppo alto ')).toBe('Il prezzo — troppo alto')
  })
})

describe('the navigation: Sales › Quotes and Home › Approvals', () => {
  it('a sales person opens Approvals first, then Quotes', () => {
    // B-W2b-307: Home › Approvals is every request's inbox, reached with home.view (every office template holds it).
    const nav = officeNavFor(permissionCheck(['home.view', 'quotes.view', 'quotes.manage']))
    const pages = navPages(nav).map((page) => page.href)
    expect(pages.indexOf('/home/approvals')).toBeGreaterThan(-1)
    expect(pages.indexOf('/home/approvals')).toBeLessThan(pages.indexOf('/sales/quotes'))
    expect(pages.slice(pages.indexOf('/sales/quotes'))).toEqual(['/sales/quotes', '/sales/settings'])
    expect(firstOfficePage(nav, { areaId: 'sales' })).toBe('/sales/quotes')
    // Home's first page is Today (home.view); Approvals follows it.
    expect(firstOfficePage(nav)).toBe('/home/today')
  })
})

// ---- B-TH-257: the record's tabs 7 → 5 on RecordFrame; every old address keeps working (R-8) ----------------------------------
describe('the quote record’s tabs (B-TH-257): Lines · Price & margin · Terms & delivery · Revisions · Approval & sending', () => {
  it('five tabs, no Activity and no Documents', () => {
    expect(QUOTE_TABS).toEqual(['lines', 'price', 'terms', 'versions', 'approval'])
    expect(QUOTE_TABS).not.toContain('activity' as never)
    expect(QUOTE_TABS).not.toContain('documents' as never)
  })
  it('every old ?tab= lands on its tab or the tab it merged into; Activity on Lines (the frame opens the thread)', () => {
    expect(MERGED_TABS).toEqual({ documents: 'approval', activity: 'lines' })
    for (const [old, now] of [['documents', 'approval'], ['activity', 'lines'], ['lines', 'lines'], ['price', 'price'], ['terms', 'terms'], ['versions', 'versions'], ['approval', 'approval'], ['', 'lines'], ['unknown', 'lines']] as const) expect(tabOf(old), old).toBe(now)
    expect(tabOf(undefined)).toBe('lines')
  })
  it('the tab words: "Revisions" for the quote’s copies, "Approval & sending" for the merged tab, in it and en', () => {
    expect(CATALOGUE.en.sales?.['tab.versions']).toBe('Revisions')
    expect(CATALOGUE.it.sales?.['tab.versions']).toBe('Revisioni')
    expect(CATALOGUE.en.sales?.['tab.approval']).toBe('Approval & sending')
    expect(CATALOGUE.it.sales?.['tab.approval']).toBe('Approvazione e invio')
    for (const locale of LOCALES) for (const gone of ['tab.documents', 'tab.activity', 'record.dock', 'record.dockHint', 'record.noPanels']) expect(CATALOGUE[locale].sales?.[gone], `${locale} ${gone}`).toBeUndefined()
  })
})

// ---- every key in both languages ---------------------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../../..', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
}
/** `skip`: files of the folder whose words are another catalogue's (B-W2b-307: the inbox in depth is `approvals-depth`). */
function literalKeys(dirs: readonly string[], prefixes: readonly string[], skip?: RegExp): string[] {
  const pattern = new RegExp(`['"\`]((?:${prefixes.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
  const keys = new Set<string>()
  for (const dir of dirs) for (const file of sources(join(SRC, dir)).filter((path) => !skip?.test(path))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
  return [...keys].sort()
}
const has = (namespace: string, key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale][namespace] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

const SALES_PREFIXES = ['status', 'approvalStatus', 'reason', 'ruleName', 'severity', 'issue', 'check', 'taxMode', 'vies', 'partyStatus', 'priceBasis', 'depositKind', 'depositKindBody', 'languageName', 'link', 'common', 'problem', 'held', 'decide', 'readOnly', 'action', 'tab', 'record', 'save', 'composer', 'style', 'grid', 'lines', 'summary', 'price', 'terms', 'versions', 'approval', 'docs', 'dialog', 'notice', 'send', 'list', 'newQuote']
const salesBuilt = [
  ...VERSION_STATUSES.map((status) => `status.${status}`),
  ...APPROVAL_STATUSES.map((status) => `approvalStatus.${status}`),
  ...APPROVAL_REASONS.flatMap((reason) => [`reason.${reason}`, `ruleName.${reason}`]),
  ...['BLOCKS', 'BLOCKS_SEND', 'WARNING', 'INFO'].map((severity) => `severity.${severity}`),
  ...QUOTE_ISSUE_CODES.map((code) => `issue.${code}`),
  ...[...QUOTE_ISSUE_CODES, ...SEND_CHECK_CODES].map((code) => `check.${code}`),
  ...PASSING_CHECKS.map((entry) => `check.pass.${entry.id}`),
  ...PARTY_TAX_MODES.map((mode) => `taxMode.${mode}`),
  ...VIES_STATES.map((state) => `vies.${state}`),
  ...PARTY_STATUSES.map((status) => `partyStatus.${status}`),
  ...['NET', 'GROSS'].map((basis) => `priceBasis.${basis}`),
  ...['ACCONTO', 'CAPARRA'].flatMap((kind) => [`depositKind.${kind}`, `depositKindBody.${kind}`]),
  ...['it', 'en'].map((language) => `languageName.${language}`),
  ...['LIVE', 'REVOKED', 'USED_UP', 'EXPIRED'].map((state) => `link.state.${state}`),
  ...QUOTE_TILES.map((tile) => `list.tile.${tile}`),
  ...QUOTE_TABS.map((tab) => `tab.${tab}`),
  ...QUOTE_ORDER_WAITS.map((reason) => `record.orderWaits.${reason}`), // B-TH-257
  ...QUOTE_ORDER_WAITS.map((reason) => `list.where.orderWaits.${reason}`), // F-CQ-102: the chip's short words
  ...['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract', 'internal'].map((kind) => `problem.read.${kind}`),
  ...['signed_out', 'forbidden', 'not_found', 'invalid', 'rate_limited', 'unavailable', 'internal', 'moved', 'state', 'stepUp'].map((kind) => `problem.write.${kind}`),
  ...['not_found', 'forbidden', 'error'].flatMap((state) => [`record.state.${state}.title`, `record.state.${state}.body`]),
  ...['TD02', 'NONE'].map((code) => `docs.deposit.fiscalDoc.${code}`),
  ...['OPEN', 'PAID', 'WAIVED', 'CANCELLED'].map((state) => `docs.deposit.state.${state}`),
  ...['LINK', 'OFFICE'].map((channel) => `docs.evidence.channelOf.${channel}`),
  ...['MATCHED', 'NOT_KNOWN', 'NOT_ASKED'].map((check) => `docs.evidence.emailCheck.${check}`),
]
const approvalsBuilt = [
  ...APPROVAL_VIEWS.flatMap((view) => [`tile.${view}`, `tableLabel.${view}`, `empty.${view}.title`, `empty.${view}.body`]),
  ...DECIDE_HELD.flatMap((held) => [`held.${held}`, `heldShort.${held}`]),
  ...APPROVAL_REASONS.map((reason) => `rule.${reason}`),
  'review.not_found',
  'review.forbidden',
]
const sendBuilt = [...['blocks', 'warning', 'passes'].map((state) => `checks.state.${state}`), ...['sent', 'failed', 'retry', 'settled'].map((state) => `result.state.${state}`), 'languageName.it', 'languageName.en']
const linkBuilt = [...DECLINE_REASONS.map((reason) => `decline.reasons.${reason}`), ...['ACCONTO', 'CAPARRA'].map((kind) => `depositKind.${kind}`), ...['OPEN', 'EXPIRED', 'REVISING', 'SUPERSEDED', 'DECLINED', 'CANCELLED'].map((state) => `state.${state}.title`), ...['EXPIRED', 'REVISING', 'SUPERSEDED', 'DECLINED', 'CANCELLED'].map((state) => `state.${state}.body`)]

describe('every key the quote screens name exists in it and en', () => {
  it('sales', () => {
    // B-W2b-316: the W2b parts speak `sales-quotes-depth` (tested in record/lines-depth/depth.vitest).
    // B-W2b-343: price-depth speaks `sales-prices-depth` (tested in record/price-depth/price-depth.vitest).
    // B-W2b-340: the configurator speaks `sales-configurator` (tested in record/configurator/configurator.vitest).
    const depth = /quotes[\\/](record[\\/](lines-depth|terms-depth|versions-depth|goalseek|price-depth|configurator)|new-from|paste)[\\/]/
    const keys = [...literalKeys(['areas/sales/quotes'], SALES_PREFIXES, depth), ...salesBuilt].filter((key) => !/^(quotes|money|sales)\./.test(key))
    expect(keys.length).toBeGreaterThan(300)
    expect(keys.filter((key) => !has('sales', key))).toEqual([])
  })
  it('approvals', () => {
    // B-W2b-307: the inbox in depth (its container, its views and its rules) speaks `approvals-depth` (tested in inbox.vitest).
    // fix-pr-6: F-PR-08's customer requests (`requests/`) speak `approvals` by `customerRequest.*` and `approvals-depth` by `notice.*` and
    // `review.noun`, both tested in requests/requests.vitest.
    // F-SA-245 (Sales S4, #1668): a work-order change's review (`work-order-changes/`) speaks `approvals` by `workOrderChange.*` and
    // `approvals-depth` by `notice.*` and `review.noun`, as `requests/` does: its notice and review keys are checked there, below.
    const depth = /home[\\/]approvals[\\/](Approvals\.tsx|api\.ts|inbox\.ts|view[\\/](InboxView|TaskReview|BulkApprove)\.tsx|requests[\\/].*|work-order-changes[\\/].*)$/
    const keys = [...literalKeys(['areas/home/approvals'], ['tile', 'tableLabel', 'empty', 'col', 'sentence', 'held', 'heldShort', 'review', 'rule', 'rejectDialog', 'notice'], depth), ...approvalsBuilt]
    expect(keys.length).toBeGreaterThan(50)
    expect(keys.filter((key) => !has('approvals', key))).toEqual([])
    const changes = literalKeys(['areas/home/approvals/work-order-changes'], ['review', 'notice'], /vitest/)
    expect(changes).toEqual(['notice.changeApplied', 'notice.changeDeclined', 'review.noun'])
    expect(changes.filter((key) => !has('approvals-depth', key))).toEqual([])
  })
  it('send', () => {
    const keys = [...literalKeys(['areas/_shared/document-send'], ['to', 'cc', 'how', 'message', 'checks', 'held', 'preview', 'result', 'languageName']), ...sendBuilt]
    expect(keys.filter((key) => !has('send', key))).toEqual([])
  })
  it('quote-link', () => {
    const keys = [...literalKeys(['links/quote-accept'], ['offer', 'lines', 'pdf', 'terms', 'state', 'newLink', 'sign', 'done', 'deposit', 'decline', 'problem', 'depositKind']), ...linkBuilt]
    expect(keys.length).toBeGreaterThan(60)
    expect(keys.filter((key) => !has('quote-link', key))).toEqual([])
  })
})

// ---- every design case, both languages -------------------------------------------------------------------------------

const LEFT_KEY = /\b(?:status|approvalStatus|reason|issue|check|taxMode|vies|partyStatus|priceBasis|depositKind|readOnly|action|record|save|composer|grid|lines|summary|price|terms|versions|approval|docs|dialog|notice|list|newQuote|tile|tableLabel|empty|col|sentence|held|heldShort|review|rule|rejectDialog|to|cc|how|checks|preview|result|offer|pdf|state|newLink|sign|done|deposit|decline|problem)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, approvalsScreen, sendScreen, acceptScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '')
          // The send dialog is a DS Modal, which opens in a browser only: the Playwright pass draws it.
          if (screen.screen !== 'SCR-037') expect(html.length, item.id).toBeGreaterThan(100)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('no cost and no margin amount reach a sales person (S2), and none reaches the customer', () => {
    const salesCase = recordScreen.cases.find((item) => item.id === 'sales-lines')!
    const html = render(recordScreen as DesignScreen<unknown>, salesCase.model, 'en')
    expect(html).not.toContain('Unit cost')
    expect(html).not.toContain('Margin €')
    expect(html).toContain('Margin %')
    const link = render(acceptScreen as DesignScreen<unknown>, acceptScreen.cases[0]!.model, 'en')
    expect(link.toLowerCase()).not.toContain('margin')
    expect(link.toLowerCase()).not.toContain('cost')
  })
})

describe('F-SA-225: a row opens its quote; Export N goes through the export job (no CSV is made in the browser)', () => {
  it('the rest of a row opens the quote (⌘ / Ctrl: a new tab); the selection\'s Export N is the frame\'s, the job with the picked ids', () => {
    const view = readFileSync(new URL('./list/view/QuotesListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('onRowClick={(row, event) =>')
    expect(view).toContain('exportSelected: true')
    expect(view).not.toContain('onExport')
    const page = readFileSync(new URL('./list/QuotesPage.tsx', import.meta.url), 'utf8')
    expect(page).not.toContain('text/csv')
    expect(page).not.toContain('quotesCsv')
  })
})

// ---- F-SA-212 (sales page plan N8, picks P13, P18): the quote list's Picture is the ONE picture part ----------------------------
describe('Sales › Quotes mounts the ONE picture part (F-SA-212)', () => {
  const view = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'list/view/QuotesListView.tsx'), 'utf8')
  it('the cell and the picture large come from lib/record-picture; the quote list keeps no copy and no word set of its own', () => {
    expect(view).toContain("from '../../../../../lib/record-picture/view/RecordPicture'")
    expect(view).toContain('source="quote"')
    expect(view).toContain('size="cell"')
    expect(readdirSync(join(fileURLToPath(new URL('.', import.meta.url)), 'list/view'))).not.toContain('QuotePicture.tsx')
    for (const locale of LOCALES) expect(Object.keys(CATALOGUE[locale].sales ?? {}).filter((key) => key.startsWith('list.picture.')), locale).toEqual([])
  })
})
// ---- end F-SA-212

// ---- F-SA-277 (sales page plan R5, P18; 11-customer-page §3.6): the ONE Quotes list (use-quotes-list.ts), lifted for the customer's
// Quotes & incoming — a locked host's every read carries the customer, Sales › Quotes reads and writes as before, a list in memory
// writes no address and its frame's tools take its own terms (the file is the screen). Pure helpers and sources: no DOM.
describe('F-SA-277: the Quotes list lifted — the locked container, the page unchanged, a list in memory with its own tools', () => {
  const LOCK = '0190f0e2-0000-7000-8000-00000000a1a1'
  const OTHER = '0190f0e2-0000-7000-8000-00000000b2b2'
  const locked = { locked: { party: LOCK } }
  const narrowed: ListFilters = { status: 'SENT', mine: true, expiring: true, q: 'Q-7', party: OTHER }
  const hook = readFileSync(new URL('./list/use-quotes-list.ts', import.meta.url), 'utf8')

  it('every read of a locked host carries the customer — the rows, each tile, the tools\' query — whatever the filters hold; Clear all keeps it', () => {
    for (const filters of [NO_FILTERS, narrowed, { ...NO_FILTERS, party: OTHER }]) {
      expect(quotesReadOf(locked, filters).partyId).toBe(LOCK)
      for (const tile of QUOTE_TILES) expect(quotesTileReadOf(locked, filters, tile).partyId, tile).toBe(LOCK)
      expect(new URLSearchParams(quotesToolsQuery(locked, filters)).get('party')).toBe(LOCK)
    }
    // The view's Clear all (NO_FILTERS) reads the customer's quotes still.
    expect(quotesReadOf(locked, quotesFiltersFor(locked, NO_FILTERS))).toEqual({ status: undefined, mine: false, q: '', partyId: LOCK })
    // The view never holds the lock (no switcher chip, no "Clear all" for it, not counted as a filter); a saved view's other customer is dropped.
    expect(quotesFiltersFor(locked, narrowed).party).toBeNull()
    expect(quotesFromQuery(locked, `status=SENT&party=${OTHER}`)).toEqual({ ...NO_FILTERS, status: 'SENT', party: null })
    expect(hook).toContain('switcher: lock ? null :')
    expect(hook).toContain('if (lock) return // F-SA-277: a locked customer has no switcher')
  })

  it('Sales › Quotes reads and writes as before: the chosen customer, its own terms on its own path, Quote speed under the list', () => {
    expect(quotesReadOf({}, narrowed)).toEqual({ status: 'SENT', mine: true, q: 'Q-7', partyId: OTHER })
    expect(quotesReadOf({}, NO_FILTERS)).toEqual({ status: undefined, mine: false, q: '' })
    expect(quotesTileReadOf({}, NO_FILTERS, 'myDrafts')).toEqual({ status: 'DRAFT', mine: true })
    expect(quotesTileReadOf({}, { party: OTHER }, 'accepted')).toEqual({ status: 'ACCEPTED', mine: undefined, partyId: OTHER })
    expect(quotesAddress('/w/DEMO/sales/quotes', narrowed)).toBe(`/w/DEMO/sales/quotes?status=SENT&mine=1&expiring=1&q=Q-7&party=${OTHER}`)
    expect(quotesAddress('/w/DEMO/sales/quotes', NO_FILTERS)).toBe('/w/DEMO/sales/quotes')
    expect(filtersOf(new URLSearchParams(searchOf(narrowed).slice(1)))).toEqual(narrowed)
    const source = readFileSync(new URL('./list/QuotesPage.tsx', import.meta.url), 'utf8')
    expect(source).toContain('useQuotesList({ basePath: QUOTES_PATH })')
    expect(source).toContain('<QuoteSpeed />')
    expect(source.split('\n').length).toBeLessThan(40)
  })

  it('the moved body keeps its reads (New messages, the pictures, `?party=`); the prefix is the session\'s; a row\'s click is the host\'s', () => {
    expect(hook).toContain("const readsThreads = session.permissions.includes('threads.read')")
    expect(hook).toContain("recordType: 'Quote'")
    expect(hook).toContain('useUnread(readsThreads ? readUnreadWith(api) : null')
    expect(hook).toContain('unread: readsThreads ? unread : null')
    expect(hook).toContain('const readPictures = useMemo(() => pictureReader(api), [api])')
    expect(hook).toContain("search.set('party', filters.party)")
    expect(hook).toContain("companyPrefix(session.company?.code ?? '')")
    expect(hook).not.toContain('usePathname')
    expect(hook).toContain('if (host.onRowClick && row) return host.onRowClick(row, newTab)')
    // Enter (and the number's link) open the quote on every host.
    expect(hook).toContain('onOpen: (id) => router.push(`${prefix}/sales/quotes/${id}`)')
  })

  it('a list in memory writes no address (the page\'s own terms stay); its frame\'s tools take its own terms and its lock', () => {
    expect(hook).toContain('memory ? setKept(quotesFiltersFor(lockHost, next)) : router.replace(quotesAddress(base, next))')
    expect(hook).toContain("const [newQuote, setNewQuote] = useState<NewQuoteModel | null>(!memory && params?.get('new') === '1'")
    const parent = { pageKey: null, query: 'q=incoming-words&tab=quotes', linked: { view: 'view-1', export: 'job-1' }, goTo: () => undefined } as unknown as ListToolsTransport
    const written: string[] = []
    const scoped = scopedTransport(parent, { listKey: QUOTES_LIST_KEY, page: '/w/DEMO/sales/quotes', query: quotesToolsQuery(locked, { ...NO_FILTERS, q: 'Q-7' }), goTo: (query) => written.push(query) })
    expect(scoped.pageKey).toBe('sales.quotes')
    expect(scoped.query).toBe(`party=${LOCK}&q=Q-7`)
    expect(scoped.linked).toEqual({ view: null, export: null })
    scoped.goTo('status=SENT')
    expect(written).toEqual(['status=SENT'])
  })

  // The words live in parties.json (customers.quotesTab, merged from the step's words file): the same words as the catalogue's titles.
  it('the tab\'s words exist in it and en, no key left, and its titles are the catalogue\'s own (never a new synonym)', () => {
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      const incoming = createTranslator(locale, messagesFor(locale, ['sales-inquiries'])['sales-inquiries']!)
      expect(words('customers.quotesTab.quotes'), locale).toBe(words('deals.titleQuotes'))
      // F-CQ-305: the dead keys are out (incoming, noQuotes, noRequests: no screen read them); the tab's own words are before-order's.
      for (const key of ['customers.quotesTab.incoming', 'customers.quotesTab.noQuotes', 'customers.quotesTab.noRequests']) expect(words(key), `${locale} ${key}`).toBe(key)
      const band = createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)
      for (const key of ['empty.quotesNoLive', 'empty.incomingNoLive']) {
        const line = band(key, { customer: 'Brand Alpha' })
        expect(line, `${locale} ${key}`).not.toBe(key)
        expect(line, `${locale} ${key}`).toContain('Brand Alpha')
      }
      expect(incoming('page.title'), locale).not.toBe('page.title')
    }
  })
})
// ---- end F-SA-277

// ---- F-CP-146 (customer page lane, money wall D1-c, review A8): a person without the price grain writes no price ----------------
// As Sales worker (no money.price after B-CP-011) and as Production manager: a quote line write names no price key — not the unit
// price, not the list price, not the discount % (a percent of a price is a price), not a size's own price, not even an empty one
// (the API's grain wall refuses a body that names one); the line takes the customer's price list. The Owner's bodies are unchanged.
// Send of the quote's priced PDF waits for someone who sees prices, said in words on the band and in the send checks.
describe('F-CP-146: no price key from a person without the price grain', () => {
  const NO_PRICE = { price: false } as const
  const OWNER = { price: true } as const
  const typed = { styleId: 's1', colourwayId: 'c1', sizes: [{ size: 'M', quantity: 4, unitPrice: '12.5' }, { size: 'L', quantity: 2 }], unitPrice: null, listUnitPrice: '20', discountPct: '5', description: 'Giacca' }
  const priceKeys = (body: unknown): string[] => JSON.stringify(body).match(/"(unitPrice|listUnitPrice|discountPct)"/g) ?? []

  it('as Sales worker / as Production manager: the line body carries no price key (sizes included); the Owner\'s is sent as typed', () => {
    const body = quoteLineBody(typed, NO_PRICE)
    expect(priceKeys(body)).toEqual([])
    expect(body).toEqual({ styleId: 's1', colourwayId: 'c1', sizes: [{ size: 'M', quantity: 4 }, { size: 'L', quantity: 2 }], description: 'Giacca' })
    expect(quoteLineBody(typed, OWNER)).toBe(typed)
    expect(QUOTE_LINE_PRICE_KEYS).toContain('discountPct')
  })

  it('the calls themselves: Add line and Edit line post no price key without the grain (the version and the sizes still go)', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const api = {
      post: async (_path: string, options: { body: Record<string, unknown> }) => (bodies.push(options.body), { quote: quote() }),
      request: async (_method: string, _path: string, options: { body: Record<string, unknown> }) => (bodies.push(options.body), { quote: quote() }),
    } as unknown as ApiClient
    const current = { id: 'q1', version: 7 }
    await addLine(api, current, { styleId: 's1', colourwayId: 'c1', sizes: [{ size: 'M', quantity: 4 }], unitPrice: null }, NO_PRICE)
    await editLine(api, current, 'l1', { sizes: [{ size: 'M', quantity: 5 }], unitPrice: '9' }, NO_PRICE)
    await addLine(api, current, { styleId: 's1', colourwayId: 'c1', sizes: [{ size: 'M', quantity: 4 }], unitPrice: '30' }, OWNER)
    expect(priceKeys(bodies[0])).toEqual([])
    expect(priceKeys(bodies[1])).toEqual([])
    expect(bodies[0]).toMatchObject({ version: 7, kind: 'SIZE_GRID', styleId: 's1', sizes: [{ size: 'M', quantity: 4 }] })
    expect(bodies[1]).toEqual({ version: 7, sizes: [{ size: 'M', quantity: 5 }] })
    expect(bodies[2]).toMatchObject({ unitPrice: '30' })
  })

  it('the record passes the person\'s grains to every line write and to the send checks (no write without them)', () => {
    const record = readFileSync(new URL('./record/QuoteRecord.tsx', import.meta.url), 'utf8')
    const calls = record.match(/\b(?:addLine|editLine)\(api,[^\n]*/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(4)
    for (const call of calls) expect(call, call).toContain('grains')
    expect(record).toMatch(/sendItems\([^\n]*grains/)
    expect(readFileSync(new URL('./record/view/QuoteRecordView.tsx', import.meta.url), 'utf8')).toContain('nextStep(quote, model.me, model.can, model.grains')
  })

  it('Send of the priced PDF waits for someone who sees prices: on the band and as the first blocking check; the Owner\'s Send is free', () => {
    expect(pricedSendHeld(NO_PRICE)).toEqual({ key: 'pricedPdf.held' })
    expect(pricedSendHeld(OWNER)).toBeNull()
    expect(nextStep(quote(), PEOPLE.sales, CAN.sales, NO_PRICE)).toEqual({ step: 'send', held: { key: 'pricedPdf.held' } })
    expect(nextStep(quote(), PEOPLE.owner, CAN.owner, OWNER)).toEqual({ step: 'send', held: null })
    // No send right stays the first reason; the approval round is not touched.
    expect(nextStep(quote(), PEOPLE.finance, CAN.finance, NO_PRICE).held).toEqual({ key: 'held.noSend' })
    const items = sendItems({ checks: [] }, echo, (tab) => `/q?tab=${tab}`, undefined, NO_PRICE)
    expect(items[0]).toEqual({ id: 'priced-pdf', state: 'blocks', label: 'pricedPdf.held', fix: null })
    const words = { loading: 'loading', busy: 'busy', noRight: 'noRight', noEmail: 'noEmail', cc: (list: string) => `cc ${list}`, sent: 'sent' }
    expect(sendHeld({ checks: { status: 'ready', items }, sending: false, canSend: true, recipient: { name: 'A', email: 'buyer@example.com' }, result: null, outside: null }, [], words)).toBe('pricedPdf.held')
    expect(sendItems({ checks: [] }, echo, (tab) => `/q?tab=${tab}`, undefined, OWNER).some((item) => item.id === 'priced-pdf')).toBe(false)
  })

  it('the words in both languages (the quote\'s own catalogue)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['sales']).sales!)
      expect(t('pricedPdf.held'), locale).not.toBe('pricedPdf.held')
    }
    expect(createTranslator('it', messagesFor('it', ['sales']).sales!)('pricedPdf.held')).toBe('Mostra dei prezzi: lo invia chi vede i prezzi.')
  })
})
// ---- end F-CP-146

// ---- B-CP-012 (end check, browser golden flow 05-quote): the quote as the API answers a person without the price grain ----------
// The grain filter drops every money-marked field — on a line the list and unit price, the discount % (a percent of a price is a
// price), the amounts, the cost and the margin; a size's own price; the version's sums. The screens read that answer as a quote: a
// Sales worker's size grid is saved ("All changes saved"), never "Not saved: something went wrong on the server".
describe('B-CP-012: the quote a Sales worker reads, without any money key, is a quote', () => {
  const LINE_MONEY = ['listUnitPrice', 'unitPrice', 'discountPct', 'netAmount', 'vatAmount', 'unitCost', 'costAmount', 'costSnapshot', 'marginAmount', 'marginPct', 'belowFloor']
  const CURRENT_MONEY = ['belowMinimum', 'depositAmount', 'netAmount', 'vatAmount', 'grossAmount', 'vat', 'costAmount', 'marginAmount', 'marginPct', 'marginFloorPct', 'marginFloorBreached']
  const without = (row: object, keys: readonly string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)))

  it('as Sales worker: lines with no price, no discount % and no amounts parse; the Owner\'s answer keeps its discount', () => {
    const full = quote()
    const { marginFloorPct: _floor, ...approval } = full.approval
    const asSales = {
      ...full,
      current: without(full.current, CURRENT_MONEY),
      lines: full.lines.map((line) => ({ ...without(line, LINE_MONEY), sizes: line.sizes.map((size) => without(size, ['unitPrice'])) })),
      approval,
    }
    const read = quoteSchema.safeParse(asSales)
    expect(read.success, JSON.stringify(read.error?.issues)).toBe(true)
    expect(read.data!.lines.some((line) => 'discountPct' in line || 'unitPrice' in line || 'netAmount' in line)).toBe(false)
    expect(quoteSchema.parse(full).lines[0]!.discountPct).toBeNull()
  })

  it('the "Needs approval" words: the broken rules the person reads, or the words alone — never a colon with nothing after it', () => {
    expect(needsApprovalKey('margin under the floor', 'summary')).toBe('summary.needsApproval')
    expect(needsApprovalKey('margin under the floor', 'held')).toBe('held.needsApproval')
    // As Sales worker: the margin floor rule is the margin grain's, left out by the API — no readable reason.
    expect(needsApprovalKey('', 'summary')).toBe('moneyWall.needsApproval')
    expect(needsApprovalKey('', 'held')).toBe('moneyWall.needsApprovalFirst')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['sales']).sales!)
      for (const key of ['moneyWall.needsApproval', 'moneyWall.needsApprovalFirst']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
    const en = createTranslator('en', messagesFor('en', ['sales']).sales!)
    expect([en(needsApprovalKey('', 'summary')), en(needsApprovalKey('', 'held'))]).toEqual(['Needs approval', 'Needs approval first'])
  })
})
// ---- end B-CP-012

// ---- F-CQ-102 (customer page › Quotes & incoming, 10-design §3.3, §4.2–4.4; settles C4, C5, C32, C33, C34): the ONE Quotes list's
// group and order terms (sent only when set: the read keeps its shape), a host's defaults (Clear all keeps them), the chips cell and
// the date cell per state (no amount, no approver role, calendar days), "r1" never, Preview PDF only with prices and in the quote's
// language, nothing held for a missing right on the row ⋯, and a customer's tab counting only its own live changes.
import { daysSince, quoteDateOf, quoteWhereOf, serverSortOf, sortedQuotes, URGENT_TOO_MANY } from './model'
import { quoteLiveCounts } from './list/use-quotes-list'
import { stateFilters, stateValue } from './list/view/QuotesListView'
import { ROWS as LIST_ROWS } from './list/fixtures'
import type { QuoteListRow } from './api'

describe('F-CQ-102: the Quotes list — group and order terms, the chips cell, the date cell', () => {
  const LOCK = '0190f0e2-0000-7000-8000-00000000a1a1'
  const locked = { locked: { party: LOCK } }
  const tab = { locked: { party: LOCK }, defaultGroup: 'LIVE' as const, defaultSort: 'urgent' as const }
  const TODAY = '2026-11-23'
  const base = LIST_ROWS[0]!
  const at = (patch: Partial<QuoteListRow>): QuoteListRow => ({ ...base, ...patch })
  const echoCell = (row: QuoteListRow) => quoteWhereOf(row, TODAY, 'Seed Customer One').chips.map((chip) => echo(chip.key, chip.params as Record<string, string | number> | undefined))
  const view = readFileSync(new URL('./list/view/QuotesListView.tsx', import.meta.url), 'utf8')
  const hook = readFileSync(new URL('./list/use-quotes-list.ts', import.meta.url), 'utf8')

  it('the group and the order go in the read only when set; Valid until sorts the loaded rows (no server term)', () => {
    expect(quotesReadOf(locked, { ...NO_FILTERS, group: 'APPROVAL', sort: 'urgent' })).toEqual({ status: undefined, mine: false, q: '', partyId: LOCK, group: 'APPROVAL', sort: 'urgent' })
    expect(quotesReadOf(locked, { ...NO_FILTERS, group: 'LIVE', sort: 'valid' })).toEqual({ status: undefined, mine: false, q: '', partyId: LOCK, group: 'LIVE' })
    expect(quotesReadOf(locked, { ...NO_FILTERS, sort: 'newest', group: null })).toEqual({ status: undefined, mine: false, q: '', partyId: LOCK })
    expect([serverSortOf('urgent'), serverSortOf('newest'), serverSortOf('valid'), serverSortOf(null)]).toEqual(['urgent', undefined, undefined, undefined])
    const rows = [at({ id: 'b', validUntil: '2026-12-10' }), at({ id: 'a', validUntil: null }), at({ id: 'c', validUntil: '2026-11-25' })]
    expect(sortedQuotes(rows, 'valid').map((row) => row.id)).toEqual(['c', 'b', 'a'])
    expect(sortedQuotes(rows, 'urgent').map((row) => row.id)).toEqual(['b', 'a', 'c'])
  })

  it('a host opens on its door (LIVE = "Not closed") and Most urgent first; Clear all keeps them; "Every state" is null on purpose', () => {
    expect(quotesFiltersFor(tab, NO_FILTERS)).toEqual({ ...NO_FILTERS, party: null, group: 'LIVE', sort: 'urgent' })
    expect(quotesReadOf(tab, quotesFiltersFor(tab, NO_FILTERS))).toEqual({ status: undefined, mine: false, q: '', partyId: LOCK, group: 'LIVE', sort: 'urgent' })
    expect(quotesFiltersFor(tab, { ...NO_FILTERS, group: null, sort: 'newest' })).toMatchObject({ group: null, sort: 'newest' })
    expect(quotesFiltersFor({ ...tab, defaultGroup: 'APPROVAL' }, NO_FILTERS).group).toBe('APPROVAL')
    // The file follows the screen's group and a server order (Valid until is the loaded rows' order: never in the file's terms).
    expect(new URLSearchParams(quotesToolsQuery(tab, quotesFiltersFor(tab, NO_FILTERS))).get('group')).toBe('LIVE')
    expect(new URLSearchParams(quotesToolsQuery(tab, quotesFiltersFor(tab, NO_FILTERS))).get('sort')).toBe('urgent')
    expect(new URLSearchParams(quotesToolsQuery(tab, { ...NO_FILTERS, sort: 'valid' })).get('sort')).toBeNull()
    // Sales › Quotes keeps the choice in its address.
    expect(filtersOf(new URLSearchParams('group=LIVE&sort=urgent'))).toEqual({ ...NO_FILTERS, group: 'LIVE', sort: 'urgent' })
    expect(filtersOf(new URLSearchParams('group=TO_ANSWER&sort=sideways'))).toEqual(NO_FILTERS)
    expect(searchOf({ ...NO_FILTERS, group: 'LIVE', sort: 'urgent' })).toBe('?group=LIVE&sort=urgent')
    // State ▾: "Not closed", a door's group, every state, one state.
    expect(stateValue({ status: null, group: 'LIVE' })).toBe('group:LIVE')
    expect(stateValue({ status: 'SENT', group: null })).toBe('SENT')
    expect(stateFilters({ ...NO_FILTERS, status: 'SENT' }, 'group:LIVE')).toMatchObject({ status: null, group: 'LIVE' })
    expect(stateFilters({ ...NO_FILTERS, group: 'LIVE' }, '')).toMatchObject({ status: null, group: null })
    expect(stateFilters({ ...NO_FILTERS, group: 'LIVE' }, 'DRAFT')).toMatchObject({ status: 'DRAFT', group: null })
    expect(stateFilters(NO_FILTERS, 'group:NOPE')).toMatchObject({ status: null, group: null })
    // A new door starts the list again on its group (once, never on arrival); the 2,000 refusal has its own words.
    expect(hook).toContain('if (lastGroup.current === hostGroup) return')
    expect(URGENT_TOO_MANY).toBe('list.sort.tooMany')
    expect(view).toContain("{os('sort.newest')}")
  })

  it('the chips per state: the state and who it waits on, the one fact, what the customer sees — never a role, never an amount', () => {
    expect(echoCell(at({ status: 'DRAFT', approval: 'REJECTED' }))).toEqual(['list.where.draftUs', 'list.where.approvalRejected'])
    expect(echoCell(at({ status: 'DRAFT', approval: null, customerHolds: { revision: 1 } }))).toEqual(['list.where.draftUs', 'list.where.holdsSent'])
    expect(echoCell(at({ status: 'PENDING_APPROVAL', approval: 'PENDING' }))).toEqual(['list.where.approval'])
    expect(echoCell(at({ status: 'APPROVED' }))).toEqual(['list.where.approvedReady'])
    // C33: calendar days from the send, "waiting for <customer>"; ending within 7 days is the one fact.
    expect(echoCell(at({ status: 'SENT', sentAt: '2026-11-18T09:00:00.000Z', validUntil: '2026-11-26' }))).toEqual(['list.where.sentAgo:{"count":5,"customer":"Seed Customer One"}', 'list.where.endsIn:{"count":3}'])
    expect(echoCell(at({ status: 'SENT', sentAt: '2026-11-23T08:00:00.000Z', validUntil: '2026-11-23' }))).toEqual(['list.where.sentToday:{"customer":"Seed Customer One"}', 'list.where.endsToday'])
    expect(echoCell(at({ status: 'SENT', sentAt: null, validUntil: '2027-01-30', reminderSentAt: '2026-11-20T08:00:00.000Z' }))).toEqual(['list.where.sent:{"customer":"Seed Customer One"}', 'list.where.remindedOn'])
    expect(echoCell(at({ status: 'SENT', validUntil: '2026-11-20' }))[1]).toBe('record.validEnded')
    // An accepted quote: its order (a door), or why the order waits.
    const made = quoteWhereOf(at({ status: 'ACCEPTED', order: { state: 'MADE', id: 'o-1', number: 'SEED-SO-0150', status: 'CONFIRMED', reason: null, words: null } }), TODAY, 'Seed Customer One')
    expect(made.chips[0]).toMatchObject({ key: 'list.where.acceptedOrder', params: { order: 'SEED-SO-0150' }, tone: 'success', order: { id: 'o-1', number: 'SEED-SO-0150' } })
    for (const reason of QUOTE_ORDER_WAITS) expect(echoCell(at({ status: 'ACCEPTED', order: { state: 'WAITS', id: null, number: null, status: null, reason, words: null } }))).toEqual(['list.where.acceptedWaits', `list.where.orderWaits.${reason}`])
    expect(echoCell(at({ status: 'DECLINED' }))).toEqual(['list.where.declined:{"customer":"Seed Customer One"}'])
    expect(echoCell(at({ status: 'EXPIRED' }))).toEqual(['status.EXPIRED'])
    // Made from a request: what the customer reads in its portal (the quote page's own rule), dashed.
    const sourced = quoteWhereOf(at({ status: 'SENT', validUntil: '2027-01-30', madeFrom: { inquiryId: 'i-1', number: 'SEED-INQ-0007', status: 'QUOTED' } }), TODAY, 'Seed Customer One')
    expect(sourced.chips.at(-1)).toMatchObject({ key: 'record.customerSees', look: 'dashed' })
    // At most 3 chips; the quiet line counts styles and pieces; no chip names a role or holds an amount.
    for (const row of LIST_ROWS) {
      const cell = quoteWhereOf(row, TODAY, 'Seed Customer One')
      expect(cell.chips.length).toBeLessThanOrEqual(3)
      expect(JSON.stringify(cell)).not.toMatch(/Amount|netAmount|grossAmount|Finance|marginPct/)
    }
    expect(daysSince('2026-11-18T23:30:00.000Z', TODAY)).toBe(4) // Rome's own day
  })

  it('the date cell: a sent quote stands N more days (amber within 7), an expired one "Offer ended", a draft "—"', () => {
    expect(quoteDateOf(at({ status: 'SENT', validUntil: '2026-11-26' }), TODAY)).toEqual({ day: '2026-11-26', note: { key: 'record.validLeft', params: { count: 3 } }, tone: 'warning' })
    expect(quoteDateOf(at({ status: 'SENT', validUntil: '2027-01-30' }), TODAY).tone).toBe('neutral')
    expect(quoteDateOf(at({ status: 'EXPIRED', validUntil: '2026-11-01' }), TODAY).note).toEqual({ key: 'record.validEnded' })
    expect(quoteDateOf(at({ status: 'DECLINED', validUntil: '2026-11-01' }), TODAY)).toEqual({ day: '2026-11-01', note: null, tone: 'neutral' })
    expect(quoteDateOf(at({ status: 'DRAFT', validUntil: '2026-12-01' }), TODAY).day).toBeNull()
  })

  it('"r1" never; Preview PDF only with prices and in the quote\'s language; Duplicate not drawn without the right', () => {
    expect(view).toContain('{data.revision >= 2 && <span className="fw-ql-row-sub">{t(\'record.versionChip\', { revision: data.revision })}</span>}')
    expect(view).toContain("...(latest.current.model.grains.price ? [{ id: 'pdf'")
    expect(view).toContain("previewHref(data.id, data.language ?? 'it')")
    expect(view).not.toContain("previewHref(data.id, 'it')")
    expect(view).not.toContain("description: live.current.manage ? undefined : t('held.noManage')")
    // The money note says the truth (Q1-B8): without prices the money columns, not "margin".
    // cq fx2 W-14: on the page the note stays under the list; on a host it is in the list's own foot.
    expect(view).toContain("{!host && (!model.grains.price ? <p className=\"fw-q-hint\">{os('export.noteNoPrice')}</p>")
    expect(view).toContain("{!model.grains.price ? <span>{os('export.noteNoPrice')}</span>")
  })

  it('a customer\'s tab counts only its own live changes: a quote on the screen or a new quote (a quote\'s message names no customer)', () => {
    const screen = new Set(['q-1'])
    expect(quoteLiveCounts({ type: 'quote.sent', fields: { quoteId: 'q-1' } }, LOCK, screen)).toBe(true)
    expect(quoteLiveCounts({ type: 'quote.sent', fields: { quoteId: 'q-other' } }, LOCK, screen)).toBe(false)
    expect(quoteLiveCounts({ type: 'quote.created', fields: { quoteId: 'q-new' } }, LOCK, screen)).toBe(true)
    expect(quoteLiveCounts({ type: 'quote.sent', fields: { quoteId: 'q-1', partyId: 'another' } }, LOCK, screen)).toBe(false)
    expect(quoteLiveCounts({ type: 'thread.message_posted', fields: {} }, LOCK, screen)).toBe(false)
    // Sales › Quotes: every quote change, as before.
    expect(quoteLiveCounts({ type: 'quote.sent', fields: { quoteId: 'q-other' } }, null, screen)).toBe(true)
  })

  it('the new words in both languages, every plural and placeholder said (Italian "tocca a noi", C29; no role, C32)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['sales']).sales!)
      for (const key of ['draftUs', 'approval', 'approvedReady', 'acceptedWaits', 'approvalRejected', 'holdsSent', 'endsToday', 'orderCancelled', 'foldValid']) expect(t(`list.where.${key}`, { date: '1' }), `${locale} ${key}`).not.toBe(`list.where.${key}`)
      for (const key of ['sentAgo', 'endsIn', 'styles', 'pieces']) for (const count of [1, 3]) expect(t(`list.where.${key}`, { count, customer: 'Seed Racing' }), `${locale} ${key} ${count}`).not.toContain('{')
      for (const key of ['list.col.where', 'list.sort.urgent', 'list.sort.valid', 'list.sort.ruleUrgent', 'list.sort.tooMany', 'list.sort.tooManyTitle', 'list.state.notClosed']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('list.where.approval'), locale).not.toMatch(/Finance|Amministrazione/)
    }
    expect(createTranslator('it', messagesFor('it', ['sales']).sales!)('list.where.draftUs')).toBe('Bozza · tocca a noi')
    expect(createTranslator('en', messagesFor('en', ['sales']).sales!)('list.where.sentAgo', { count: 5, customer: 'Seed Racing' })).toBe('Sent 5 days ago · waiting for Seed Racing')
  })
})
// ---- end F-CQ-102

// ---- F-CQ-201 / 202 / 204 (customer page › Quotes & incoming, 10-design §6.1, §7, §8; settles C1, C19, C28): the Quotes list's bar and
// row ⋯ on both hosts, the quote's OWN windows opened in place (one place for their acts: record/acts.ts), Make revision N also from
// Expired / Declined, New link hidden without prices, Add task to N on the shape agreed with the Customers list lane.
import { QUOTE_ACTS } from './record/acts'
import { QUOTE_DIALOG_KINDS } from './record/record-model'

describe('F-CQ-201 / 202 / 204: the Quotes list acts — the bar, the row ⋯, the quote\'s own windows in place', () => {
  const view = readFileSync(new URL('./list/view/QuotesListView.tsx', import.meta.url), 'utf8')
  const hook = readFileSync(new URL('./list/use-quotes-list.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./record/QuoteRecord.tsx', import.meta.url), 'utf8')
  const dialog = readFileSync(new URL('./record/use-quote-dialog.ts', import.meta.url), 'utf8')

  it('the quote page and the list run ONE set of acts (record/acts.ts): no act\'s API call is left in QuoteRecord.tsx', () => {
    for (const call of ['askApproval(api', 'approveQuote(api', 'rejectQuote(api', 'cancelQuote(api', 'reviseQuote(api', 'sendNewLink(api', 'reopen(api']) expect(page, call).not.toContain(call)
    for (const kind of QUOTE_DIALOG_KINDS) expect(QUOTE_ACTS[kind], kind).toBeTruthy()
    expect(page).toContain('QUOTE_ACTS.approve.run(api, current, note)')
    expect(QUOTE_ACTS.revise.done({ currentRevision: 2 })).toEqual({ key: 'notice.revised', tone: 'success', params: { next: 3 } })
    expect(QUOTE_ACTS.cancel.done({ currentRevision: 1 })).toEqual({ key: 'notice.cancelled', tone: 'success' })
  })

  it('a row opens the quote\'s own window in place — the quote read once on open (never for every row), the list read again after', () => {
    expect(dialog).toContain('getQuote(told.current.api, quoteId)')
    expect(dialog).toContain('QUOTE_ACTS[kind].run(told.current.api, before, text')
    expect(view).toContain('{model.quoteDialog && <QuoteDialogs quote={model.quoteDialog.quote} model={model.quoteDialog.model} actions={actions?.quoteDialog} />}')
    expect(hook).toContain('quoteDialog.openOn(row.id, act)')
    // The row ⋯: each next step only with its right (the asker never decides: said inside the window), by its state.
    expect(view).toContain("...(manage && data.status === 'DRAFT' ? [{ id: 'ask'")
    expect(view).toContain("...(can.approve && data.status === 'PENDING_APPROVAL'")
    expect(view).toContain("...(manage && ['SENT', 'EXPIRED', 'DECLINED'].includes(data.status) ? [{ id: 'revise'")
    expect(view).toContain("...(can.send && latest.current.model.grains.price && data.status === 'APPROVED'")
    expect(view).not.toContain('CancelManyDialog')
  })

  it('Make revision N from Expired and Declined too (Q1-B3, C28) — for who manages; nothing for who does not', () => {
    const expired = { ...quote(), current: { ...quote().current, status: 'EXPIRED' as const } }
    const declined = { ...quote(), current: { ...quote().current, status: 'DECLINED' as const } }
    expect(nextStep(expired, PEOPLE.sales, CAN.sales)).toEqual({ step: 'revise', held: null })
    expect(nextStep(declined, PEOPLE.sales, CAN.sales)).toEqual({ step: 'revise', held: null })
    expect(nextStep(expired, PEOPLE.finance, CAN.finance)).toEqual({ step: 'none', held: null })
  })

  it('New link only for who may send AND sees prices (the quote page\'s ⋯ and its documents, Q1-B2); the bar\'s too', () => {
    const recordView = readFileSync(new URL('./record/view/QuoteRecordView.tsx', import.meta.url), 'utf8')
    expect(recordView).toContain("status === 'SENT' && model.can.send && model.grains.price ? [{ id: 'newLink'")
    const documents = readFileSync(new URL('./record/view/DocumentsTab.tsx', import.meta.url), 'utf8')
    expect(documents).toContain("quote.current.status === 'SENT' && model.can.send && model.grains.price && (")
    expect(documents).not.toContain("heldReason={model.can.send ? null : t('held.noSend')} onClick={() => actions?.onDialog?.('newLink')}")
  })

  it('Add task to N: the ONE batch window on the agreed shape (C19) — the quotes\' nouns, each name a door, Assign to starts on "Me"', () => {
    expect(view).toContain("words: { ns: 'before-order', prefix: 'tasks.quote' }")
    expect(view).toContain('namesOther: null')
    expect(view).toContain("defaultAssignee: 'me'")
    expect(hook).toContain("tasks.open(picked.map((row) => ({ type: 'Quote', id: row.id, label: row.number, supervisor: null })))")
  })

  it('the row\'s words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['sales']).sales!)
      for (const key of ['list.row.sendOnPage', 'list.row.addTask']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-CQ-201 / 202 / 204
