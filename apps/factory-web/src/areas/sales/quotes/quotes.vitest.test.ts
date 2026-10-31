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
import { APPROVAL_REASONS, APPROVAL_STATUSES, DECIDE_HELD, VERSION_STATUSES } from './api'
import { designScreen as listScreen, ROWS as LIST_ROWS } from './list/fixtures'
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
  quotesCsv,
  QUOTE_TABS,
  QUOTE_TILES,
  styleBlocks,
  termsDraftOf,
  termsPatch,
  tileCount,
  tileOfFilters,
} from './model'
import { designScreen as recordScreen, belowFloor, CAN, pending, PEOPLE, quote, SENT_VERSION, STYLE, version } from './record/fixtures'
import { PASSING_CHECKS, sendItems } from './record/send-model'

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
    const nav = officeNavFor(permissionCheck(['quotes.view', 'quotes.manage']))
    expect(navPages(nav).map((page) => page.href)).toEqual(['/home/approvals', '/sales/quotes', '/sales/settings'])
    expect(firstOfficePage(nav, { areaId: 'sales' })).toBe('/sales/quotes')
    expect(firstOfficePage(nav)).toBe('/home/approvals')
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
function literalKeys(dirs: readonly string[], prefixes: readonly string[]): string[] {
  const pattern = new RegExp(`['"\`]((?:${prefixes.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
  const keys = new Set<string>()
  for (const dir of dirs) for (const file of sources(join(SRC, dir))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
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
    const keys = [...literalKeys(['areas/sales/quotes'], SALES_PREFIXES), ...salesBuilt].filter((key) => !/^(quotes|money|sales)\./.test(key))
    expect(keys.length).toBeGreaterThan(300)
    expect(keys.filter((key) => !has('sales', key))).toEqual([])
  })
  it('approvals', () => {
    const keys = [...literalKeys(['areas/home/approvals'], ['tile', 'tableLabel', 'empty', 'col', 'sentence', 'held', 'heldShort', 'review', 'rule', 'rejectDialog', 'notice']), ...approvalsBuilt]
    expect(keys.length).toBeGreaterThan(50)
    expect(keys.filter((key) => !has('approvals', key))).toEqual([])
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

describe('Export N (CSV): the selected quotes, never more than the screen shows', () => {
  const words = { header: (key: string) => key, status: (status: string) => `status.${status}` }
  const rows = LIST_ROWS.slice(0, 2).map((row, index) => (index === 0 ? { ...row, partyName: 'Rossi, "Moto" S.r.l.' } : row))

  it('one header line and one line per quote; a cell with a comma or a quote is quoted', () => {
    const lines = quotesCsv(rows, grainsOf(['money.price', 'money.margin']), words, 'en').split('\r\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('list.col.net')
    expect(lines[0]).toContain('list.col.margin')
    expect(lines[1]).toContain('"Rossi, ""Moto"" S.r.l."')
    expect(lines[1]).toContain('status.DRAFT')
    expect(lines[3]).toBe('')
  })

  it('no money without the price grain, no margin without the margin grain', () => {
    const csv = quotesCsv(rows, grainsOf([]), words, 'en')
    expect(csv).not.toContain('list.col.net')
    expect(csv).not.toContain('list.col.margin')
    expect(csv).not.toContain('6,240')
    expect(csv).not.toContain('34.5')
    const priceOnly = quotesCsv(rows, grainsOf(['money.price']), words, 'en')
    expect(priceOnly).toContain('list.col.gross')
    expect(priceOnly).not.toContain('list.col.margin')
  })
})
