import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { INCOTERMS } from '@nexus/factory-domain/sales/quote-terms/rules'
import { LINE_RULE_CODES } from '@nexus/factory-domain/sales/quote-warnings/codes'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen as templatesScreen } from '../../../settings/templates/fixtures'
import { designScreen as curvesScreen } from '../../../settings/curves/fixtures'
import { curveProblems, sharesBody, shareUnits, totalOf } from '../../../settings/curves/model'
import { draftOf, emptyDraft, headerPatch, linesBody, templateProblems } from '../../../settings/templates/model'
import { designScreen as newFromScreen } from '../../new-from/fixtures'
import { leftOutWords as startLeftOut, startLines, templateHeld, EMPTY_TEMPLATE_PICK } from '../../new-from/model'
import { designScreen as pasteScreen } from '../../paste/fixtures'
import { leftOutWords as pasteLeftOut, pasteColumns } from '../../paste/model'
import { quote } from '../fixtures'
import { deliveryPatch, deliveryProblems, payModeHeld, validityWords } from '../terms-depth/model'
import { designScreen as compareScreen } from '../versions-depth/fixtures'
import { fullChangeNote, latestPair, pairOf, sectionDiffers, sectionsOf } from '../versions-depth/model'
import { COMPARED, TERMS, VERSIONS, WARNINGS, designScreen as depthScreen } from './fixtures'
import { DEPTH_NS, deliveriesBody, deliveryRowsOf, remainderOf, sizesText, SALES_CHECK_CODES, scheduleChanged, scheduleProblems, tableRows, warningTarget, warningWords } from './model'

/**
 * B-W2b-316 — the quote's W2b parts on screen: the rules (warnings in words, table rows, the delivery schedule, paste and
 * start left-outs, terms, compare, templates, curves), every word in both languages, and every design case drawn with no
 * key left on screen.
 */

const L1 = '0190f0e2-8888-7000-8000-000000000001'
const L2 = '0190f0e2-8888-7000-8000-000000000002'
const QUOTE = quote()

describe('Warnings: W1\'s send-check words, the depth catalogue\'s, where Fix / Open goes', () => {
  it('says every line rule in the send dialog\'s words and the overdue account in its own', () => {
    for (const code of LINE_RULE_CODES) expect(warningWords({ code, details: {} })).toEqual({ ns: 'sales', key: `check.${code}`, params: { size: '' } })
    expect(warningWords({ code: 'CERTIFICATE', details: { size: '56' } }).params).toEqual({ size: '56' })
    expect(warningWords({ code: 'ACCOUNT_OVERDUE', details: {} })).toEqual({ key: 'warn.code.ACCOUNT_OVERDUE' })
    expect(warningWords({ code: 'A_NEW_RULE', details: {} })).toEqual({ key: 'warn.code.other' })
    for (const code of SALES_CHECK_CODES) for (const locale of LOCALES) expect(CATALOGUE[locale].sales?.[`check.${code}`], `${locale} ${code}`).toBeTruthy()
  })

  it('opens the record that settles it (its own page), else the line in the drawer', () => {
    const style = WARNINGS.warnings[0]!
    expect(warningTarget(style, '/w/DEMO', (id) => `#${id}`)).toEqual({ href: expect.stringMatching(/^\/w\/DEMO\/products\/styles\/.+\?tab=release$/), kind: 'open' })
    expect(warningTarget(WARNINGS.warnings[2]!, '/w/DEMO', (id) => `/line/${id}`)).toEqual({ href: `/line/${L1}`, kind: 'fix' })
    expect(warningTarget({ open: null, lineIds: [] }, '/w/DEMO', (id) => id)).toBeNull()
  })
})

describe('Table view rows', () => {
  it('carries the schedule, the warnings per line and money only where the API sent it', () => {
    const rows = tableRows(QUOTE, TERMS, WARNINGS.warnings)
    expect(rows.map((row) => [row.seq, row.sizes, row.delivery, row.warnings])).toEqual([
      [10, '50 2 · 52 4 · 54 2', { first: '2026-12-02', count: 1 }, 2],
      [20, '50 1 · 52 3 · 54 2', null, 2],
    ])
    const { unitPrice: _price, netAmount: _net, unitCost: _cost, marginPct: _margin, ...noMoney } = QUOTE.lines[0]!
    const bare = tableRows({ lines: [noMoney as typeof QUOTE.lines[number]] }, null, null)[0]!
    expect('unitPrice' in bare || 'netAmount' in bare || 'unitCost' in bare || 'marginPct' in bare).toBe(false)
  })

  it('writes sizes in the style\'s order', () => {
    expect(sizesText({ '54': 2, '50': 1, '52': 0 }, ['50', '52', '54'])).toBe('50 1 · 54 2')
  })
})

describe('the line drawer\'s delivery schedule', () => {
  const line = QUOTE.lines[0]!
  it('reads the saved schedule, says the rest at the promise date and sends whole pieces', () => {
    const rows = deliveryRowsOf(TERMS.lines[0]!)
    expect(remainderOf(rows, line)).toEqual({ '52': 2, '54': 2 })
    expect(deliveriesBody(rows, line)).toEqual([{ deliveryDate: '2026-12-02', sizes: { '50': 2, '52': 2 }, note: 'Prima consegna per la fiera' }])
    expect(scheduleChanged(rows, TERMS.lines[0]!, line)).toBe(false)
    expect(scheduleChanged([...rows, { key: 'n', date: '2026-12-20', sizes: { '54': '2' }, note: '' }], TERMS.lines[0]!, line)).toBe(true)
  })

  it('holds the save in words: no date, past, twice, more than the line, a size it has not, whole pieces', () => {
    const keys = (rows: Parameters<typeof scheduleProblems>[0]) => scheduleProblems(rows, line, '2026-11-13').map((problem) => problem.key)
    expect(keys([{ key: 'a', date: '', sizes: { '50': '1' }, note: '' }])).toEqual(['drawer.problem.noDate'])
    expect(keys([{ key: 'a', date: '2026-11-01', sizes: { '50': '1' }, note: '' }])).toEqual(['drawer.problem.past'])
    expect(keys([{ key: 'a', date: '2026-12-01', sizes: { '50': '1' }, note: '' }, { key: 'b', date: '2026-12-01', sizes: { '52': '1' }, note: '' }])).toEqual(['drawer.problem.twice'])
    expect(keys([{ key: 'a', date: '2026-12-01', sizes: { '50': '3' }, note: '' }])).toEqual(['drawer.problem.over'])
    expect(keys([{ key: 'a', date: '2026-12-01', sizes: { '58': '1' }, note: '' }])).toEqual(['drawer.problem.size'])
    expect(keys([{ key: 'a', date: '2026-12-01', sizes: { '50': '1,5' }, note: '' }])).toEqual(['drawer.problem.pieces'])
    expect(keys([{ key: 'a', date: '2026-12-01', sizes: {}, note: '' }])).toEqual(['drawer.problem.empty'])
    expect(keys([{ key: 'a', date: '2026-12-01', sizes: { '50': '2', '52': '4', '54': '2' }, note: '' }])).toEqual([])
  })
})

describe('Paste lines: the columns before anything is asked, what could not land in words', () => {
  it('reads the first row with factory-domain\'s own parser', () => {
    expect(pasteColumns('')).toBeNull()
    expect(pasteColumns('Style\tColourway\tPrice\t50\t52\nX\tBLK\t\t1\t2')).toEqual({ sizes: ['50', '52'], price: true, options: false, rows: 1, problem: null })
    // B-W2b-374: an Options column is read, never a size.
    expect(pasteColumns('Style\tColourway\tOpzioni\t50\nX\tBLK\tLINER:YES\t1')).toEqual({ sizes: ['50'], price: false, options: true, rows: 1, problem: null })
    expect(pasteColumns('Codice\t50\nX\t1')?.problem).toEqual({ key: 'paste.problem.colourway' })
    expect(pasteColumns('Style\tColourway\t50')?.problem).toEqual({ key: 'paste.problem.rows' })
  })

  it('matches each of B-W2b-302\'s left-out kinds', () => {
    const say = (message: string, size: string | null = null) => pasteLeftOut({ size, message }, 3).key
    expect(say('Row 3, size 52: "x" is not whole pieces.', '52')).toBe('paste.left.cell')
    expect(say('Row 3: 58 is not a size of X (50, 52).', '58')).toBe('paste.left.notSize')
    expect(say('Row 3: size 56 is not offered in BLK.', '56')).toBe('paste.left.notOffered')
    expect(say('Row 3: X is not a style this company sells.')).toBe('paste.left.style')
    expect(say('Row 3: X is archived: it is not quoted.')).toBe('paste.left.archived')
    expect(say('Row 3: GRN is not an active colourway of X.')).toBe('paste.left.colourway')
    expect(say('Row 3: X BLK is pasted already in row 2.')).toBe('paste.left.twice')
    expect(say('Row 3: the price is not written on a line already on the quote: change it with Target price or Price & margin.')).toBe('paste.left.priceKept')
    expect(say('Row 3: no cell can land.')).toBe('paste.left.nothing')
    expect(say('Row 3: something new.')).toBe('paste.left.other')
  })
})

describe('New quote › Start from a template or an inquiry', () => {
  it('says each of the starts\' left-out reasons in its own words', () => {
    const say = (reason: string, size: string | null = null) => startLeftOut({ seq: 20, size, reason }).key
    expect(say('Left out when the quote was made.')).toBe('from.left.skipped')
    expect(say('A fee without a price on the template is not added: add the fee on the quote with its price.')).toBe('from.left.feeNoPrice')
    expect(say('Its colourway is chosen when the quote is made: pick one, or add the line on the quote.')).toBe('from.left.noColourway')
    expect(say('Its pieces per size are typed when the quote is made: type them, or add the line on the quote.')).toBe('from.left.noSizes')
    expect(say('Size 56 is not offered in this colourway.', '56')).toBe('from.left.size')
    expect(say("The template's fee is net; this customer buys with VAT included: add the fee on the quote with its price.")).toBe('from.left.feeNet')
    expect(say('None of its sizes is offered in this colourway: the line is not added.')).toBe('from.left.noneOffered')
    expect(say('something else entirely')).toBe('from.left.other')
  })

  it('sends a pick for every open line, a line not filled in left out by the API', () => {
    const template = { lines: [{ id: 'a', seq: 10, kind: 'SIZE_GRID' as const, colourwayId: 'c', sizes: { '50': 1 } }, { id: 'b', seq: 20, kind: 'SIZE_GRID' as const, colourwayId: null, sizes: null }, { id: 'c', seq: 30, kind: 'FEE' as const, colourwayId: null, sizes: null }] } as unknown as Parameters<typeof startLines>[0]
    expect(startLines(template, {})).toEqual([{ templateLineId: 'b', skip: true }])
    expect(startLines(template, { b: { colourwayId: 'red', sizes: { '50': '2', '52': '', '54': '0' }, skip: false } })).toEqual([{ templateLineId: 'b', colourwayId: 'red', sizes: { '50': 2 } }])
    expect(templateHeld(null)?.key).toBe('from.held.template')
    expect(templateHeld({ ...EMPTY_TEMPLATE_PICK, chosenId: 'x', template: { status: 'loading' } })?.key).toBe('from.held.reading')
  })
})

describe('Terms & delivery in depth', () => {
  it('holds the Incoterm without its place and the reverse; clearing the Incoterm clears its place', () => {
    expect(deliveryProblems({ incoterm: 'DAP', place: '', shipComplete: false }).map((problem) => problem.key)).toEqual(['terms.problem.place'])
    expect(deliveryProblems({ incoterm: '', place: 'Milano', shipComplete: false }).map((problem) => problem.key)).toEqual(['terms.problem.placeAlone'])
    expect(deliveryProblems({ incoterm: 'DAP', place: 'Milano', shipComplete: true })).toEqual([])
    expect(deliveryPatch({ incoterm: 'DAP', place: 'Milano', shipComplete: true }, { incoterm: '', place: '', shipComplete: true })).toEqual({ incoterm: null, incotermPlace: null })
    expect(deliveryPatch({ incoterm: '', place: '', shipComplete: false }, { incoterm: 'FCA', place: 'Verona', shipComplete: true })).toEqual({ incoterm: 'FCA', incotermPlace: 'Verona', shipComplete: true })
  })

  it('holds sign and pay without a deposit; says the validity with its days', () => {
    expect(payModeHeld(null)).toEqual({ key: 'terms.acceptance.needsDeposit' })
    expect(payModeHeld('30')).toBeNull()
    expect(validityWords({ ...TERMS.validity, state: 'OPEN', daysLeft: 12 })).toEqual({ key: 'terms.validity.OPEN', params: { count: 12 } })
    expect(validityWords({ ...TERMS.validity, state: 'EXPIRED' })).toEqual({ key: 'terms.validity.EXPIRED' })
  })

  it('names every Incoterm in both languages', () => {
    for (const locale of LOCALES) for (const code of INCOTERMS) expect(CATALOGUE[locale][DEPTH_NS]?.[`incoterm.${code}`], `${locale} ${code}`).toMatch(new RegExp(`^${code} · `))
  })
})

describe('Compare two versions', () => {
  it('pairs two selected rows (older first) or the current with the one before', () => {
    expect(pairOf(VERSIONS, VERSIONS.map((version) => version.id))).toEqual({ from: 1, to: 2 })
    expect(pairOf(VERSIONS, [VERSIONS[0]!.id])).toBeNull()
    expect(latestPair(VERSIONS)).toEqual({ from: 1, to: 2 })
    expect(latestPair([VERSIONS[0]!])).toBeNull()
  })

  it('shows terms, lines, then prices when the grain sent them; one change note in the page\'s words', () => {
    expect(sectionsOf(COMPARED).map((section) => section.id)).toEqual(['terms', 'lines', 'prices'])
    expect(sectionsOf({ ...COMPARED, prices: undefined }).map((section) => section.id)).toEqual(['terms', 'lines'])
    expect(sectionsOf(COMPARED).every(sectionDiffers)).toBe(true)
    const labels = {
      kinds: { added: 'Added', removed: 'Removed', changed: 'Changed', unchanged: 'Unchanged' },
      title: () => '', field: '', none: '—', notIn: () => '', sizes: '', sizeChange: () => '', totals: '', summary: () => '', same: '', showUnchanged: () => '', hideUnchanged: '', useAsNote: '', nothingToNote: '',
      noteHead: (a: string, b: string) => `${a} → ${b}`, noteAdded: (line: string) => `+ ${line}`, noteRemoved: (line: string) => `- ${line}`, noteChanged: (line: string, parts: string) => `${line}: ${parts}`, noteField: (field: string, from: string, to: string) => `${field} ${from} → ${to}`, noteSize: (size: string, from: string, to: string) => `${size} ${from} → ${to}`, noteTotal: (total: string, from: string, to: string) => `${total} ${from} → ${to}`, join: '; ',
    }
    const note = fullChangeNote({ label: 'V1' }, { label: 'V2' }, sectionsOf(COMPARED), { field: (id) => id, total: (id) => id, value: (_field, value) => value }, labels)
    expect(note.split('\n')[0]).toBe('V1 → V2')
    expect(note.split('\n').filter((line) => line.startsWith('V1')).length).toBe(1)
    expect(note).toContain('52 3 → 4')
    expect(note.length).toBeLessThanOrEqual(1000)
  })
})

describe('Sales settings › Quote templates and Size curves', () => {
  it('a template: what stops the save, the PATCH and the lines it sends', () => {
    const draft = { ...emptyDraft('c'), name: 'Stagione', acceptanceMode: 'SIGN_AND_PAY' as const }
    expect(templateProblems(draft, { price: true }).map((problem) => problem.key)).toEqual(['tpl.problem.payNeedsDeposit'])
    expect(templateProblems({ ...draft, depositPct: '30', incoterm: 'DAP' }, { price: true }).map((problem) => problem.key)).toEqual(['tpl.problem.incoterm'])
    expect(headerPatch(emptyDraft('c'), { ...emptyDraft('c'), name: ' Stagione ', validityDays: '30', incoterm: 'DAP', incotermPlace: 'Milano' })).toEqual({ name: 'Stagione', validityDays: 30, incoterm: 'DAP', incotermPlace: 'Milano' })
    const lines = [{ key: 'a', section: 'Giacche', styleId: 's', styleCode: 'S', styleName: 'S', colourwayId: '', colourwayCode: '', sizes: { '50': '2', '52': '' }, unitPrice: '450,50' }]
    expect(linesBody(lines, { price: true })).toEqual([{ seq: 10, section: 'Giacche', kind: 'SIZE_GRID', styleId: 's', colourwayId: null, sizes: { '50': 2 }, unitPrice: '450.50' }])
    expect(linesBody(lines, { price: false })[0]).not.toHaveProperty('unitPrice')
    expect(draftOf).toBeTypeOf('function')
  })

  it('a curve: the total live and exact, Save held until 100 %, the shares as the API takes them', () => {
    expect(shareUnits('12,5')).toBe(125_000)
    expect(shareUnits('x')).toBeNull()
    expect(totalOf({ shares: { '50': '33.3333', '52': '33.3333', '54': '33.3334' } })).toBe(100)
    const draft = { name: 'C', scaleId: 's', companyId: '', shares: { '50': '30', '52': '40', '54': '20' } }
    expect(curveProblems(draft).map((problem) => problem.key)).toEqual(['curve.problem.total'])
    expect(curveProblems({ ...draft, shares: { ...draft.shares, '54': '30' } })).toEqual([])
    expect(curveProblems({ ...draft, shares: { '50': '4x' } }).map((problem) => problem.key)).toEqual(['curve.problem.share'])
    expect(sharesBody({ shares: { '54': '30', '50': '25', '52': '45', '56': '' } }, ['50', '52', '54', '56'])).toEqual({ '50': '25', '52': '45', '54': '30' })
  })
})

// ---- the words ---------------------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOTS = ['.', '../terms-depth', '../versions-depth', '../goalseek', '../../new-from', '../../paste', '../../../settings/templates', '../../../settings/curves'].map((path) => join(HERE, path))
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/fixtures|vitest/.test(name) ? [path] : []
  })
}
const PREFIXES = /^(block|common|compare|composer|curve|drawer|fill|from|goal|keys|notice|page|paste|pay|review|table|terms|tpl|versions|view|warn|incoterm|bulk)\./
const has = (dictionary: Readonly<Record<string, string>> | undefined, key: string) => !!dictionary && (dictionary[key] !== undefined || (dictionary[`${key}_one`] !== undefined && dictionary[`${key}_other`] !== undefined))

describe('every word of the W2b quote parts is in both languages', () => {
  it('each literal key the code says is in the depth catalogue (or W1\'s sales one it reuses)', () => {
    const missing: string[] = []
    for (const file of ROOTS.flatMap(sources)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/'([a-z]+\.[A-Za-z0-9_.]+)'/g)) {
        const key = match[1]!
        if (!PREFIXES.test(key)) continue
        for (const locale of LOCALES) if (!has(CATALOGUE[locale][DEPTH_NS], key) && !has(CATALOGUE[locale].sales, key)) missing.push(`${locale} ${key} (${file.split('/').slice(-2).join('/')})`)
      }
    }
    expect(missing).toEqual([])
  })
})

// ---- the design cases ----------------------------------------------------------------------------------------------------

const LEFT_KEY = /\b(?:block|compare|composer|curve|drawer|fill|from|goal|notice|page|paste|pay|review|table|terms|tpl|view|warn|incoterm|bulk|check|readOnly|held)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [depthScreen, compareScreen, pasteScreen, newFromScreen, templatesScreen, curvesScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b(?:sales|product|products|files|example|email|quotes|money|threads|planning)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('uses the screen ids of the step: SCR-415 and SCR-416 new, the others parts of SCR-034, SCR-035 and SCR-235', () => {
    expect([depthScreen, compareScreen, pasteScreen, newFromScreen, templatesScreen, curvesScreen].map((screen) => screen.screen)).toEqual(['SCR-035-depth', 'SCR-415', 'SCR-416', 'SCR-034-new-from', 'SCR-235-templates', 'SCR-235-curves'])
  })

  it('keeps the two lines of the fixtures', () => {
    expect([L1, L2].every((id) => QUOTE.lines.some((line) => line.id === id))).toBe(true)
  })
})
