import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { PPE_CATEGORIES, PPE_ISSUE_REASONS, PPE_RECEIPT_METHODS, PPE_REFUSALS, RECEIPT_STATES } from '@nexus/factory-domain/safety/ppe/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { APRON, COUNTS, GAP_MARIO, GAP_SARA, GAPS_EVERYONE, GLOVES, ISSUES, itemsAnswer, KITS, SHOES } from './_demo/fixtures'
import { designScreen as cardScreen } from './card/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressText,
  archiveHeld,
  centsOf,
  EMPTY_ADDRESS,
  EMPTY_ISSUE,
  EMPTY_ITEM,
  gapRowsFor,
  issueBodyOf,
  issuedByText,
  issueHeld,
  issueLineProblems,
  itemBodyOf,
  itemChanged,
  itemDraftOf,
  itemDraftProblems,
  itemHeld,
  kitMatrix,
  liveReach,
  newLine,
  ppeCan,
  prefillLines,
  problemOf,
  receiptsOfLines,
  roleBannerOf,
  signedAtHeld,
  TABLET_RECEIPT_READY,
  tileActive,
  tilesOf,
  unitsOf,
  voidHeld,
  withAddress,
} from './model'
import { designScreen as receiptScreen } from './receipt/fixtures'

const params = (text: string) => new URLSearchParams(text)
const can = (key: string) => ppeCan(templateOf(key)!.permissions)
const NOW = new Date('2026-11-05T09:12:00.000Z')

describe('ppe: the address, the tiles, who may do what', () => {
  it('keeps the lens, its filters and every dialog in the address; an unknown word falls back', () => {
    const address = addressOf(params('view=issues&signed=notSigned&person=p1&ppe=i1&from=2026-10-01&to=2026-10-31&q=scarpe&void=l1'))
    expect(address).toMatchObject({ view: 'issues', signed: 'notSigned', person: 'p1', ppe: 'i1', from: '2026-10-01', to: '2026-10-31', q: 'scarpe', void: 'l1' })
    expect(addressOf(params(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(params('view=x&show=y&signed=z&status=w&from=yesterday'))).toEqual(EMPTY_ADDRESS)
    // Another lens starts without the last lens's words; a lens's own filters are written only for it.
    expect(withAddress(address, { view: 'catalogue' }).q).toBe('')
    expect(addressText({ ...EMPTY_ADDRESS, view: 'gaps', signed: 'voided', show: 'replace', role: 'r1' })).toBe('?show=replace&role=r1')
    expect(addressText({ ...EMPTY_ADDRESS, issue: 'new' })).toBe('?issue=new')
  })

  it('draws the built tiles only; a tile opens its lens with its filter', () => {
    expect(tilesOf(COUNTS).map((tile) => [tile.id, tile.value])).toEqual([['peopleMissingKit', 3], ['receiptsNotSigned', 1], ['replacementsDue', 1]])
    expect(tilesOf(null).every((tile) => tile.value === null)).toBe(true)
    const [missing, notSigned, replace] = tilesOf(COUNTS)
    expect(notSigned!.to).toEqual({ view: 'issues', signed: 'notSigned' })
    expect(tileActive(missing!, EMPTY_ADDRESS)).toBe(true)
    expect(tileActive(replace!, { ...EMPTY_ADDRESS, show: 'replace' })).toBe(true)
    expect(tileActive(notSigned!, { ...EMPTY_ADDRESS, view: 'issues', signed: 'notSigned' })).toBe(true)
  })

  it('gives the page to every safety reader, the catalogue to the safety officer, receipts to the safety officer, HR and the floor supervisor', () => {
    expect(can('safety_officer')).toMatchObject({ view: true, manage: true, issue: true, upload: true, cost: false, suppliers: true })
    expect(can('hr')).toMatchObject({ view: true, manage: false, issue: true })
    expect(can('floor_supervisor')).toMatchObject({ view: true, manage: false, issue: true, upload: false })
    expect(can('production_manager')).toMatchObject({ view: true, manage: false, issue: false })
    expect(can('owner')).toMatchObject({ view: true, manage: true, issue: true, cost: false })
    // The cost grain travels as the grant `money.cost` (Role.grains), never in a template's permissions.
    expect(ppeCan([...templateOf('owner')!.permissions, 'money.cost']).cost).toBe(true)
    expect(can('sales').view).toBe(false)
    const rows = (key: string) => officeNavFor(permissionCheck(templateOf(key)!.permissions)).areas.flatMap((area) => (area.sections ?? []).flatMap((entry) => entry.items.map((row) => row.href)))
    expect(rows('safety_officer')).toContain('/plant/ppe')
    expect(rows('sales')).not.toContain('/plant/ppe')
    expect([...OFFICE_PAGES]).toEqual(expect.arrayContaining(['/plant/ppe', '/plant/ppe/receipt', '/plant/ppe/card']))
    expect([...WINDOW_PAGES]).toEqual(expect.arrayContaining(['/plant/ppe/receipt', '/plant/ppe/card']))
    expect(recordAddress({ type: 'PpeIssue', id: 'r-1' }, OFFICE_PAGES)).toBe('/plant/ppe/receipt?receipt=r-1')
    expect(recordAddress({ type: 'PpeItem', id: 'i-1' }, OFFICE_PAGES)).toBe('/plant/ppe?view=catalogue&item=i-1')
    // The floor's Receive PPE screen is B-W2b-145's: until it ships, "at the tablet" is held with its reason.
    expect(TABLET_RECEIPT_READY).toBe(true)
  })
})

describe('ppe: the lenses', () => {
  it('Gaps: the API answers missing or all; Replacements due are the all rows with a unit past its life', () => {
    expect(gapRowsFor(GAPS_EVERYONE, 'replace').map((row) => row.employee.id)).toEqual([GAP_SARA.employee.id])
    expect(gapRowsFor(GAPS_EVERYONE, 'all')).toHaveLength(GAPS_EVERYONE.length)
  })

  it('Issues: the receipts of the chosen lines, each once; the giver hidden behind the gate says "a worker"', () => {
    expect(receiptsOfLines(ISSUES, [ISSUES[1]!.id, ISSUES[2]!.id, ISSUES[3]!.id])).toEqual([ISSUES[1]!.receiptId, ISSUES[3]!.receiptId])
    const words = { worker: 'a worker', none: '—' }
    expect(issuedByText({ kind: 'WORKER', name: 'Someone', hidden: true }, words)).toBe('a worker')
    expect(issuedByText({ kind: 'WORKER', name: 'Someone', hidden: false }, words)).toBe('Someone')
    expect(issuedByText({ kind: 'USER', name: 'Office', hidden: false }, words)).toBe('Office')
    expect(issuedByText({ kind: 'NONE', name: null, hidden: false }, words)).toBe('—')
  })

  it('Kits per role: the items some kit names, a cell per role and item', () => {
    const matrix = kitMatrix(KITS)
    expect(matrix.roles).toHaveLength(3)
    expect(matrix.items.map((item) => item.code)).toEqual(['GLOVES-CUT', 'SHOES-S3', 'EAR-DEF', 'APRON'])
    expect(matrix.cell(KITS.roles[0]!.id, GLOVES.id)).toEqual({ quantity: 2, whenToWear: 'Al tavolo di taglio' })
    expect(matrix.cell(KITS.roles[1]!.id, GLOVES.id)).toBeNull()
  })

  it('live: what each change reads again, and the role banner counted from the gaps read again', () => {
    expect(liveReach('ppe.issued')).toEqual(['counts', 'gaps', 'issues'])
    expect(liveReach('ppe_item.changed')).toEqual(['catalogue', 'kits', 'gaps'])
    expect(liveReach('role_sheet.changed')).toEqual(['counts', 'gaps', 'kits'])
    expect(liveReach('chemical.changed')).toEqual([])
    expect(roleBannerOf(KITS.roles[0]!.id, KITS, GAPS_EVERYONE)).toEqual({ role: 'Tagliatore', people: 1 })
    expect(roleBannerOf('unknown', KITS, GAPS_EVERYONE)).toBeNull()
  })
})

describe('ppe: Issue PPE', () => {
  const items = itemsAnswer().items
  const input = { can: can('safety_officer'), items, companyId: GAP_MARIO.companyId, canIssuePerson: true, tabletReady: false, busy: false, now: NOW }

  it('prefills the missing kit (NEW) and the units past their life (REPLACEMENT); the size waits unless the item has one', () => {
    expect(prefillLines(GAP_MARIO).map((line) => [line.ppeItemId, line.quantity, line.reason, line.size])).toEqual([
      [GLOVES.id, 2, 'NEW', ''],
      [SHOES.id, 1, 'NEW', ''],
    ])
    expect(prefillLines(GAP_SARA).map((line) => [line.ppeItemId, line.quantity, line.reason])).toEqual([[GLOVES.id, 2, 'REPLACEMENT']])
    expect(newLine({ id: 'x', sizes: ['U'] }).size).toBe('U')
  })

  it('holds the button with the reason the API would give, line by line (factory-domain lineProblems)', () => {
    const draft = { ...EMPTY_ISSUE, employeeId: GAP_MARIO.employee.id, lines: prefillLines(GAP_MARIO) }
    expect(issueHeld(EMPTY_ISSUE, input)).toBe('held.person')
    expect(issueHeld({ ...EMPTY_ISSUE, employeeId: 'p' }, input)).toBe('held.lines')
    expect(issueHeld(draft, input)).toBe('held.line.size')
    expect(issueLineProblems(draft, items, GAP_MARIO.companyId).map((problem) => [problem.index, problem.field])).toEqual([
      [0, 'size'],
      [1, 'size'],
    ])
    const sized = { ...draft, lines: draft.lines.map((line) => ({ ...line, size: line.ppeItemId === GLOVES.id ? '9' : '42' })) }
    expect(issueHeld(sized, input)).toBeNull()
    expect(issueHeld({ ...sized, lines: [...sized.lines, { ...sized.lines[0]!, key: 'twice' }] }, input)).toBe('held.lineTwice')
    expect(issueHeld({ ...sized, lines: [{ ...sized.lines[0]!, size: '50' }] }, input)).toBe('held.line.size')
    expect(issueHeld({ ...sized, method: 'tablet' }, input)).toBe('held.tabletNotReady')
    expect(issueHeld({ ...sized, method: 'tablet' }, { ...input, tabletReady: true })).toBeNull()
    expect(issueHeld(sized, { ...input, can: can('production_manager') })).toBe('held.issue')
    expect(issueHeld(sized, { ...input, canIssuePerson: false })).toBe('held.personSite')
    expect(issueHeld({ ...sized, signedAt: '2026-11-06T09:00:00.000Z' }, input)).toBe('refusal.IN_FUTURE')
    expect(issueHeld({ ...sized, signedAt: '2025-01-01T09:00:00.000Z' }, input)).toBe('refusal.TOO_LATE')
    expect(issueHeld({ ...sized, scan: { name: 'scan.docx', type: 'application/msword', size: 3 } }, input)).toBe('held.scanType')
    expect(signedAtHeld('', NOW)).toBeNull()
  })

  it('sends one body: sizes or none, the quantities, the time only when typed', () => {
    const draft = { ...EMPTY_ISSUE, employeeId: 'p1', lines: [{ key: 'a', ppeItemId: APRON.id, size: ' M ', quantity: 2 as const, reason: 'LOST' as const }, { key: 'b', ppeItemId: 'ears', size: '', quantity: 1 as const, reason: 'NEW' as const }] }
    expect(issueBodyOf(draft)).toEqual({ employeeId: 'p1', lines: [{ ppeItemId: APRON.id, size: 'M', quantity: 2, reason: 'LOST' }, { ppeItemId: 'ears', size: null, quantity: 1, reason: 'NEW' }] })
    expect(issueBodyOf({ ...draft, signedAt: '2026-11-05T08:00:00.000Z' }).issuedAt).toBe('2026-11-05T08:00:00.000Z')
    expect(unitsOf(draft)).toBe(3)
  })
})

describe('ppe: the catalogue and the void', () => {
  it('sends the unit cost only with the cost grain, in cents; the code in capitals', () => {
    expect(centsOf('12,50')).toBe(1250)
    expect(centsOf('9')).toBe(900)
    expect(centsOf('')).toBeNull()
    expect(Number.isNaN(centsOf('12,505'))).toBe(true)
    const draft = { ...EMPTY_ITEM, code: 'occhiali-uv', name: ' Occhiali UV ', nameEn: 'UV glasses', category: 'CATEGORY_II' as const, sizes: ['S', 's', 'M'], lifeMonths: '12', unitCost: '9,90' }
    expect(itemBodyOf(draft, true)).toMatchObject({ name: 'Occhiali UV', nameI18n: { en: 'UV glasses' }, sizes: ['S', 'M'], lifeMonths: 12, unitCost: 990 })
    expect('unitCost' in itemBodyOf(draft, false)).toBe(false)
  })

  it('holds Save with the field at fault, "Nothing changed" on an untouched item, and Archive while a kit names it', () => {
    const safety = can('safety_officer')
    expect(itemHeld(EMPTY_ITEM, { item: null, can: safety, companyId: 'c', busy: false })).toBe('held.code')
    expect(itemDraftProblems({ ...EMPTY_ITEM, code: 'BAD CODE', name: 'x', category: 'CATEGORY_I' }, true, false).map((problem) => problem.key)).toEqual(['held.code'])
    expect(itemDraftProblems({ ...EMPTY_ITEM, code: 'OK', name: 'x', category: 'CATEGORY_I', lifeMonths: '200' }, true, false).map((problem) => problem.key)).toEqual(['held.lifeMonths'])
    expect(itemHeld(itemDraftOf(GLOVES), { item: GLOVES, can: safety, companyId: 'c', busy: false })).toBe('held.nothingChanged')
    expect(itemChanged(GLOVES, { ...itemDraftOf(GLOVES), lifeMonths: '4' }, false)).toBe(true)
    expect(itemHeld(itemDraftOf(GLOVES), { item: GLOVES, can: can('production_manager'), companyId: 'c', busy: false })).toBe('held.manage')
    expect(archiveHeld(GLOVES, safety, false)).toBe('refusal.IN_KIT')
    expect(archiveHeld({ ...GLOVES, inKits: 0 }, safety, false)).toBeNull()
  })

  it('voids only with a reason, never twice', () => {
    expect(voidHeld('', false, ISSUES[0]!)).toBe('held.reason')
    expect(voidHeld('Taglia sbagliata', false, ISSUES[0]!)).toBeNull()
    expect(voidHeld('x', false, ISSUES[2]!)).toBe('refusal.VOIDED_ALREADY')
    expect(voidHeld('x', false, null)).toBe('held.lineGone')
  })

  it('says the API’s refusals in our words, at the line they name', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/IN_KIT' }])
    expect(problemOf(refused)).toMatchObject({ key: 'refusal.IN_KIT' })
    const line = new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/lines/2/size' }])
    expect(problemOf(line)).toEqual({ key: 'held.line.size', field: 'lines', line: 2 })
    const code = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/CODE_TAKEN' }, { path: 'body/code' }])
    expect(problemOf(code)).toEqual({ key: 'refusal.CODE_TAKEN', field: 'code', line: null })
    expect(problemOf(new Error('x')).key).toBe('problem.unavailable')
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NAMESPACE = 'plant-ppe'
const TOP = [...new Set(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, '')))].filter((key) => !['law'].includes(key))
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("safety.ppe.issue"); file names are not keys. */
const SAID = /\b(?:(?:safety|files|money)\.[a-zA-Z.]+|[\w .-]+\.(?:pdf|jpg))\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('ppe: the words', () => {
  it('every key in it and en; every word the screens name exists; every code has its words', () => {
    expect(Object.keys(CATALOGUE.it[NAMESPACE] ?? {}).sort()).toEqual(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:held|refusal|problem|saved|notice|bulk|issue|kits|gaps)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][NAMESPACE] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      for (const code of Object.keys(PPE_REFUSALS)) expect(has(`refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of RECEIPT_STATES) expect(has(`receiptState.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of PPE_RECEIPT_METHODS) expect(has(`method.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of PPE_ISSUE_REASONS) expect(has(`reason.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of PPE_CATEGORIES) expect(has(`category.${code}`), `${locale} ${code}`).toBe(true)
      for (const lens of ['gaps', 'issues', 'kits', 'catalogue']) expect(has(`lens.${lens}`), `${locale} lens.${lens}`).toBe(true)
      for (const field of ['code', 'name', 'category', 'standard', 'sizes', 'lifeMonths', 'unitCost', 'note', 'supplierPartyId']) expect(has(`held.${field}`), `${locale} held.${field}`).toBe(true)
      for (const field of ['ppeItemId', 'size', 'quantity', 'line']) expect(has(`issue.lineProblem.${field}`), `${locale} issue.lineProblem.${field}`).toBe(true)
      expect(CATALOGUE[locale].shell?.['nav.plant.ppe'], `${locale} shell nav.plant.ppe`).toBeTruthy()
    }
  })

  for (const screen of [designScreen, receiptScreen, cardScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en with no key or placeholder left`, () => {
      for (const entry of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, entry.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${entry.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('SCR-211 names every state and role case the design asks for', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['normal', 'all-sites', 'loading', 'error', 'gaps-empty', 'issues', 'issues-empty', 'kits', 'catalogue', 'catalogue-empty', 'no-permission', 'read-only', 'issue', 'issue-prefilled', 'item-new', 'item', 'void', 'role-banner', 'keys']),
    )
    expect(receiptScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['pin', 'paper', 'several', 'loading', 'error', 'no-permission']))
    expect(cardScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['one', 'several', 'loading', 'error', 'no-permission']))
  })
})
