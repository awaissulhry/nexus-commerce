import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BOM_ISSUE_CODES } from '@nexus/factory-domain/product/bom/rules'
import { COMPLIANCE_CHECKS, BLOCKED_STEPS, CELL_STATUSES } from '@nexus/factory-domain/product/compliance/rules'
import { ROUTING_ISSUE_CODES } from '@nexus/factory-domain/product/routing/rules'
import { PPE_CATEGORIES, PRODUCT_TYPES, STYLE_STATUSES, STYLE_WARNINGS } from '@nexus/factory-domain/product/styles/rules'
import { REVISION_STATUSES } from '@nexus/factory-domain/product/styles/revisions'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress, listAddress } from '../../../lib/records/record-links'
import { firstOfficePage, OFFICE_NAV, OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { demoBom, demoRouting, demoStyle, REV, ROWS, SIZES } from './demo/fixtures'
import { identityPatch } from './record/view/OverviewTab'
import { designScreen as listScreen } from './list/fixtures'
import { designScreen as recordScreen } from './record/fixtures'
import { settlePpe, standardsFor } from './forms'
import {
  abilitiesOf,
  decimalInput,
  editableRevision,
  grainsOf,
  inScaleOrder,
  issueTab,
  issueWords,
  matrixCells,
  moveCell,
  rangeEffect,
  rangeWords,
  releaseHeld,
  revisionChips,
  revisionInView,
  rowToggle,
  startRevisionHeld,
  STYLE_TABS,
  STYLE_TILES,
  STYLE_VIEWS,
  stepRevision,
  stylesCsv,
  tabsFor,
  viewQuery,
} from './model'
import { writeProblem } from './problems'
import { ApiError } from '../../../lib/api/errors'

const OWNER = abilitiesOf([
  'product.styles.view',
  'product.styles.manage',
  'product.bom.view',
  'product.bom.manage',
  'product.bom.release',
  'product.routing.view',
  'product.routing.manage',
  'costing.view',
  'compliance.certificates.view',
  'threads.read',
])

describe('who may do what: permissions and grains', () => {
  it('reads the abilities and the money grains from the session', () => {
    expect(OWNER).toMatchObject({ view: true, manage: true, release: true, routingManage: true, costView: true, complianceView: true, declarations: false })
    expect(abilitiesOf(['compliance.declarations.manage']).declarations).toBe(false)
    expect(abilitiesOf(['compliance.declarations.manage', 'files.upload']).declarations).toBe(true)
    expect(grainsOf(['money.cost'])).toEqual({ cost: true, price: false, margin: false })
    expect(grainsOf(['money.price', 'money.margin'])).toEqual({ cost: false, price: true, margin: true })
  })

  it('draws only the tabs a role reads (sales: no BOM, routing, compliance)', () => {
    const sales = abilitiesOf(['product.styles.view', 'costing.view', 'threads.read'])
    expect(tabsFor(OWNER)).toEqual([...STYLE_TABS])
    expect(tabsFor(sales).filter((tab) => ['bom', 'routing', 'compliance'].includes(tab))).toEqual([])
    expect(tabsFor(abilitiesOf(['product.styles.view']))).not.toContain('activity')
  })
})

describe('the revision in view', () => {
  const style = demoStyle()
  it('the asked one, else the draft, else the released one, else the newest', () => {
    expect(revisionInView(style.revisions, REV.r1)?.revision).toBe(1)
    expect(revisionInView(style.revisions, 'not-a-revision')?.revision).toBe(3)
    expect(revisionInView(style.revisions.filter((entry) => entry.status !== 'DRAFT'), null)?.revision).toBe(2)
    expect(revisionInView(style.revisions.filter((entry) => entry.status === 'OBSOLETE'), null)?.revision).toBe(1)
    expect(revisionInView([], null)).toBeNull()
  })

  it('[ and ] step through the revisions by number, held at the ends', () => {
    expect(stepRevision(style.revisions, REV.r2, 1)?.id).toBe(REV.r3)
    expect(stepRevision(style.revisions, REV.r2, -1)?.id).toBe(REV.r1)
    expect(stepRevision(style.revisions, REV.r3, 1)).toBeNull()
  })

  it('a new revision is held while a draft is open, on an archived style, or without the right', () => {
    expect(startRevisionHeld(style, OWNER)).toBe('held.draftOpen')
    const released = { ...style, revisions: style.revisions.filter((entry) => entry.status !== 'DRAFT') }
    expect(startRevisionHeld(released, OWNER)).toBeNull()
    expect(startRevisionHeld({ ...released, status: 'ARCHIVED' }, OWNER)).toBe('held.archived')
    // A copy of a frozen revision is the BOM's right; the first, empty revision the style's.
    expect(startRevisionHeld(released, abilitiesOf(['product.styles.manage']))).toBe('held.noManage')
    expect(startRevisionHeld({ ...released, revisions: [] }, abilitiesOf(['product.styles.manage']))).toBeNull()
    expect(editableRevision(style, style.revisions[0]!)).toBe(true)
    expect(editableRevision(style, style.revisions[1]!)).toBe(false)
    expect(editableRevision({ status: 'ARCHIVED' }, style.revisions[0]!)).toBe(false)
  })

  it('Release is held with the count of what blocks it, and with every other reason', () => {
    const draft = style.revisions[0]!
    expect(releaseHeld(style, draft, demoBom(), OWNER)).toEqual({ key: 'held.blockers', params: { count: 2 } })
    expect(releaseHeld(style, draft, demoBom({ complete: true }), OWNER)).toBeNull()
    expect(releaseHeld(style, draft, null, OWNER)).toEqual({ key: 'held.checking' })
    expect(releaseHeld(style, style.revisions[1]!, demoBom(), OWNER)).toEqual({ key: 'held.notDraft' })
    expect(releaseHeld(style, draft, demoBom(), { ...OWNER, release: false })).toEqual({ key: 'held.noRelease' })
    expect(releaseHeld({ status: 'ARCHIVED' }, draft, demoBom(), OWNER)).toEqual({ key: 'held.archived' })
    expect(releaseHeld(style, null, null, OWNER)).toEqual({ key: 'held.noRevision' })
  })

  it('says each finding in its words, where it is and which tab fixes it', () => {
    const bom = demoBom()
    expect(issueWords(bom.issues[0]!, bom, null)).toEqual({ key: 'issue.SIZE_QUANTITY_MISSING', params: { line: '10 · PEL-BOV-12', size: '58', colourway: '—', step: '—' } })
    expect(issueWords(bom.issues[1]!, bom, null).params?.colourway).toBe('ANTR')
    expect(issueTab({ code: 'NO_STEPS' })).toBe('routing')
    expect(issueTab({ code: 'NO_ACTIVE_COLOURWAY' })).toBe('variants')
    expect(issueTab({ code: 'COLOUR_MISSING' })).toBe('bom')
    const routing = demoRouting()
    expect(issueWords({ code: 'MINUTES_NOT_POSITIVE', lineId: null, size: null, colourwayId: null, stepId: routing.steps[3]!.id, message: 'x' }, bom, routing).params?.step).toBe('40 · CUC-MAN')
  })
})

describe('the size range and the SKU matrix', () => {
  const style = demoStyle()
  it('says before Apply how many SKUs a new range adds and switches off', () => {
    // 3 active colourways: +60 makes 3 SKUs; −46 switches off the 3 ON in 46.
    expect(rangeEffect(style, [...SIZES.slice(1), '60'])).toEqual({ added: ['60'], removed: ['46'], skusOn: 3, skusOff: 3 })
    // ANTR 58 is off already: taking 58 out switches off only NERO and ROSSO 58.
    expect(rangeEffect(style, SIZES.slice(0, -1)).skusOff).toBe(2)
    expect(rangeEffect({ ...style, matrix: { ...style.matrix, generated: false } }, ['46']).skusOn).toBe(0)
    expect(inScaleOrder(['52', '46', '60', '52'], ['44', '46', '52', '60'])).toEqual(['46', '52', '60'])
  })

  it('cells are on, off, without a SKU or closed (an archived colourway); a row toggle switches the rest', () => {
    const cells = matrixCells(demoStyle({ missing: ['ROSSO:58'] }))
    expect(cells[1]!.map((cell) => cell.state)).toEqual(['on', 'on', 'on', 'on', 'on', 'on', 'off'])
    expect(cells[2]![6]!.state).toBe('none')
    expect(cells[3]!.every((cell) => cell.state === 'closed')).toBe(true)
    // ANTR has one off: Shift+Space switches it on; NERO all on: Shift+Space switches the 7 off.
    expect(rowToggle(cells[1]!)).toEqual([{ skuId: cells[1]![6]!.sku!.id, version: 2, status: 'ACTIVE' }])
    expect(rowToggle(cells[0]!).map((change) => change.status)).toEqual(Array(7).fill('ARCHIVED'))
    expect(rowToggle(cells[3]!)).toEqual([])
    expect(moveCell({ row: 0, col: 0 }, 'ArrowLeft', 3, 7)).toEqual({ row: 0, col: 0 })
    expect(moveCell({ row: 0, col: 6 }, 'ArrowRight', 3, 7)).toEqual({ row: 0, col: 6 })
    expect(moveCell({ row: 0, col: 2 }, 'ArrowDown', 3, 7)).toEqual({ row: 1, col: 2 })
    expect(moveCell({ row: 1, col: 2 }, 'End', 3, 7)).toEqual({ row: 1, col: 6 })
  })
})

describe('the forms say only what the API accepts', () => {
  it('PPE: a part of EN 17092 sets the class; gloves are EN 13594; Category I and not PPE carry no standard', () => {
    expect(standardsFor('JACKET', null).map((entry) => entry.standard)).toEqual(['EN 17092-2:2020', 'EN 17092-3:2020', 'EN 17092-4:2020', 'EN 17092-5:2020', 'EN 17092-6:2020'])
    expect(standardsFor('GLOVES', null)).toEqual([{ standard: 'EN 13594:2015', ppeClass: null }])
    expect(settlePpe({ ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: null }, 'JACKET')).toEqual({ ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' })
    expect(settlePpe({ ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' }, 'GLOVES')).toEqual({ ppeCategory: 'CATEGORY_II', ppeStandard: null, ppeClass: null })
    expect(settlePpe({ ppeCategory: 'NOT_PPE', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' }, 'JACKET')).toEqual({ ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null })
    expect(settlePpe({ ppeCategory: 'CATEGORY_I', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' }, 'JACKET').ppeStandard).toBeNull()
  })

  it('the identity form sends only what changed', () => {
    const style = demoStyle()
    const same = { code: style.code, name: style.name, productType: style.productType, season: style.season ?? '', brandPartyId: null, description: style.description ?? '', mtmAllowed: false, ppe: { ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass } }
    expect(identityPatch(style, same)).toEqual({})
    expect(identityPatch(style, { ...same, name: ' Giacca Nuova ', season: '' })).toEqual({ name: 'Giacca Nuova', season: null })
    expect(identityPatch(style, { ...same, ppe: { ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' } })).toEqual({ ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' })
  })

  it('reads decimals typed either way, refuses what is not a number', () => {
    expect(decimalInput('1,80')).toBe('1.8')
    expect(decimalInput(' 7.40 ')).toBe('7.4')
    expect(decimalInput('007')).toBe('7')
    expect(decimalInput('')).toBeNull()
    expect(decimalInput('1,2,3')).toBeUndefined()
    expect(decimalInput('-1')).toBeUndefined()
    expect(decimalInput('1.12345')).toBeUndefined()
  })
})

describe('the list: saved filters, rows and the CSV', () => {
  it('each saved filter is one API filter; the tiles are saved filters', () => {
    expect(viewQuery('waiting')).toEqual({ status: 'OPEN', draftRevision: true })
    expect(viewQuery('drafts')).toEqual({ status: 'DRAFT' })
    expect(viewQuery('open')).toEqual({ status: 'OPEN' })
    expect(STYLE_TILES.every((tile) => (STYLE_VIEWS as readonly string[]).includes(tile))).toBe(true)
  })

  it('shows the range and the revisions in words', () => {
    expect(rangeWords(['46', '48', '58'])).toBe('46–58')
    expect(rangeWords(['M'])).toBe('M')
    expect(revisionChips(ROWS[0]!)).toEqual([
      { kind: 'released', revision: 2 },
      { kind: 'draft', revision: 3 },
    ])
  })

  it('exports the selected rows: a header and one line each, quoted where needed', () => {
    const csv = stylesCsv([ROWS[0]!, ROWS[2]!], { header: ['Code', 'Name'], status: (s) => s, type: (t) => t, ppe: (p) => p }).split('\n')
    expect(csv).toHaveLength(3)
    expect(csv[1]).toContain('DEMO-JKT-01,Giacca Touring Demo,JACKET,FW27,,ACTIVE,2,3,46 48 50 52 54 56 58,52,3,20,CATEGORY_II,A')
    expect(stylesCsv([{ ...ROWS[0]!, name: 'Giacca, "Evo"' }], { header: [], status: (s) => s, type: (t) => t, ppe: (p) => p })).toContain('"Giacca, ""Evo"""')
  })
})

describe('problems in our words (never the API\'s)', () => {
  it('a stale version reads again; a refused release says the check; a taken code points at the field', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version' }]))).toMatchObject({ key: 'problem.write.moved', reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'lines/abc/sizes/58' }]))).toMatchObject({ key: 'problem.write.blocked', reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'The style code X is taken.', null, []))).toMatchObject({ key: 'problem.write.codeTaken', reload: false })
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'sizes/2' }]))).toMatchObject({ key: 'problem.write.invalid', paths: ['sizes/2'] })
  })
})

describe('where a style opens: its own page (record-links) and the navigation', () => {
  it('Style records and the styles list open the built pages', () => {
    expect(recordAddress({ type: 'Style', id: 's1', label: 'DEMO-JKT-01' }, OFFICE_PAGES)).toBe('/products/styles/s1')
    expect(listAddress('/product/styles', { draftRevision: 'true' }, OFFICE_PAGES)).toBe('/products/styles?draftRevision=true')
  })

  it('Products opens Styles for whoever reads styles', () => {
    const nav = officeNavFor((permission) => ['product.styles.view'].includes(permission), OFFICE_NAV)
    expect(firstOfficePage(nav, { areaId: 'products' })).toBe('/products/styles')
    expect(officeNavFor(() => false, OFFICE_NAV).areas.some((area) => area.id === 'products')).toBe(false)
  })
})

// ---- every key the screens name exists in it and en ----------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../../..', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
}
const PREFIXES = ['common', 'status', 'statusMeans', 'revisionStatus', 'masterStatus', 'productType', 'tracking', 'ppe', 'tab', 'record', 'action', 'save', 'held', 'problem', 'notice', 'identity', 'warning', 'side', 'check', 'coverage', 'revisions', 'range', 'measures', 'colourways', 'colourway', 'matrix', 'sku', 'generate', 'release', 'startRevision', 'abandon', 'archive', 'dialog', 'issue', 'complianceCheck', 'blocks', 'cellStatus', 'list', 'completeness', 'csv', 'newStyle', 'keys', 'bom', 'routing', 'cost', 'compliance', 'missing', 'kind', 'uom', 'department', 'category']
function literalKeys(): string[] {
  const pattern = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
  const keys = new Set<string>()
  for (const file of sources(join(SRC, 'areas/products/styles'))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
  return [...keys].filter((key) => !/^(product|costing|compliance)\.(styles|bom|routing|materials|certificates|declarations|labels)\b/.test(key) && key !== 'costing.view' && !/\.(tsx?|css)$/.test(key)).sort()
}
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale].products ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })
const built = [
  ...STYLE_STATUSES.flatMap((status) => [`status.${status}`, `statusMeans.${status}`]),
  ...REVISION_STATUSES.map((status) => `revisionStatus.${status}`),
  ...PRODUCT_TYPES.map((type) => `productType.${type}`),
  ...PPE_CATEGORIES.flatMap((category) => [`ppe.category.${category}`, `ppe.why.${category}`, `ppe.short.${category}`]),
  ...STYLE_WARNINGS.map((code) => `warning.${code}`),
  ...BOM_ISSUE_CODES.map((code) => `issue.${code}`),
  ...ROUTING_ISSUE_CODES.map((code) => `issue.${code}`),
  ...COMPLIANCE_CHECKS.map((code) => `complianceCheck.${code}.BLOCKED`),
  ...BLOCKED_STEPS.map((step) => `blocks.${step}`),
  ...CELL_STATUSES.map((status) => `cellStatus.${status}`),
  ...STYLE_TABS.map((tab) => `tab.${tab}`),
  ...STYLE_VIEWS.map((view) => `list.view.${view}`),
  ...STYLE_TILES.flatMap((tile) => [`list.tile.${tile}`, `list.tileHint.${tile}`]),
  ...['on', 'off', 'none', 'closed'].flatMap((state) => [`matrix.cell.${state}`, `sku.stateIs.${state}`]),
  ...['colourways', 'sizeRange', 'baseSize', 'skus', 'releasedRevision'].map((key) => `completeness.${key}`),
  ...['LOT', 'NONE'].map((tracking) => `tracking.${tracking}`),
  ...['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract', 'internal'].map((kind) => `problem.read.${kind}`),
  ...['moved', 'state', 'blocked', 'codeTaken', 'invalid', 'stepUp', 'signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'internal'].map((kind) => `problem.write.${kind}`),
  ...['not_found', 'forbidden', 'error'].flatMap((state) => [`record.state.${state}.title`, ...(state === 'error' ? [] : [`record.state.${state}.body`])]),
]

describe('every key the styles screens name exists in it and en', () => {
  it('products', () => {
    const keys = [...literalKeys(), ...built]
    expect(keys.length).toBeGreaterThan(300)
    expect(keys.filter((key) => !has(key))).toEqual([])
  })
})

// ---- every design case, both languages -------------------------------------------------------------------------------------

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.filter((prefix) => !['kind', 'category'].includes(prefix)).join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          // The record panels' made-up history names audit actions by their code (SCR-006's own design data).
          const html = render(screen, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '').replace(/compliance\.certificates\.[a-z]+/g, '')
          expect(html.length, item.id).toBeGreaterThan(100)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
