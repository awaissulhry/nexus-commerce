import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BOM_BLOCKERS, BOM_WARNINGS } from '@nexus/factory-domain/product/bom/rules'
import { bomDepthView } from '@nexus/factory-domain/product/bom-lines/contracts'
import { ALTERNATE_HELD, ALTERNATE_USES } from '@nexus/factory-domain/product/bom-lines/rules'
import { bomStructureView, usedInView } from '@nexus/factory-domain/product/bom-structure/contracts'
import { BOM_SECTIONS, MATERIAL_APPROVALS } from '@nexus/factory-domain/product/bom-structure/rules'
import { styleOptionsView } from '@nexus/factory-domain/product/options/contracts'
import { REVISION_STATUSES } from '@nexus/factory-domain/product/styles/revisions'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { demoPieces } from '../../record/pieces/fixtures'
import { designScreen as bomScreen } from '../fixtures'
import { demoDepth, demoOptions, demoStructure, demoUsedIn, depthBom, LINE_IDS, OPTION_IDS } from './demo/fixtures'
import {
  addAlternateHeld,
  alternateQty,
  bomFindings,
  bomMarkCount,
  customerHeld,
  depthHeld,
  groupChoices,
  leatherPieces,
  lineRows,
  movedOrder,
  showMeOf,
  STRUCTURE_CODES,
  structureWords,
  subAssemblyHeld,
  subRevisions,
  supplyBlocked,
} from './model'

/**
 * B-W2b-241 — the BOM in depth: the made-up answers are the API's own shapes, the Lines view's rows (grouped order, options
 * named), who may change what and why not, THE check (this tab's findings, the tab's mark, where Show me lands), alternates,
 * the leather grade mix of the pattern pieces, every key in both languages and every W2b case drawn with no key left.
 */

describe('the made-up answers are the API\'s own shapes', () => {
  it('parse with factory-domain\'s contracts', () => {
    for (const check of ['w1', 'w2b'] as const) expect(() => bomStructureView.parse(demoStructure({ check }))).not.toThrow()
    expect(() => bomStructureView.parse(demoStructure({ released: true }))).not.toThrow()
    expect(() => bomDepthView.parse(demoDepth())).not.toThrow()
    expect(() => bomDepthView.parse(demoDepth({ released: true }))).not.toThrow()
    expect(() => styleOptionsView.parse(demoOptions())).not.toThrow()
    expect(() => usedInView.parse(demoUsedIn())).not.toThrow()
  })
})

describe('the Lines view\'s rows', () => {
  const bom = depthBom()
  it('follow the structure\'s grouped order: a group row, then its lines one step in', () => {
    const rows = lineRows(bom, demoStructure(), demoDepth(), demoOptions(), 'en')
    expect(rows.map((row) => row.seq)).toEqual([10, 20, 30, 60, 70, 80, 90, 40, 50, 100])
    expect(rows.find((row) => row.id === LINE_IDS.shoulder)?.level).toBe(1)
    expect(rows.find((row) => row.id === LINE_IDS.kit)?.level).toBe(0)
  })
  it('name the option a line is only for in the page\'s language', () => {
    expect(lineRows(bom, demoStructure(), demoDepth(), demoOptions(), 'it').find((row) => row.id === LINE_IDS.liner)?.option).toEqual({ label: 'Fodera termica: Sì', valueId: OPTION_IDS.yes })
    expect(lineRows(bom, demoStructure(), demoDepth(), demoOptions(), 'en').find((row) => row.id === LINE_IDS.liner)?.option?.label).toBe('Thermal liner: Yes')
    // Before the options are read: the API's own label.
    expect(lineRows(bom, demoStructure(), null, null, 'en').find((row) => row.id === LINE_IDS.liner)?.option?.label).toBe('—')
  })
  it('keep W1\'s order until the structure is read, every line once', () => {
    const rows = lineRows(bom, null, null, null, 'en')
    expect(rows.map((row) => row.seq)).toEqual(bom.lines.map((line) => line.seq))
    expect(rows.every((row) => row.structure === null && row.depth === null && row.level === 0)).toBe(true)
  })
})

describe('who may change what, and why not', () => {
  const structure = demoStructure()
  it('the whole tab: the right, a draft, online, one write at a time', () => {
    expect(depthHeld(structure, false, false, false)).toBe('hold.noManage')
    expect(depthHeld(null, true, false, false)).toBe('hold.loading')
    expect(depthHeld(demoStructure({ released: true }), true, false, false)).toBe('hold.frozen')
    expect(depthHeld(structure, true, true, false)).toBe('hold.offline')
    expect(depthHeld(structure, true, false, true)).toBe('hold.busy')
    expect(depthHeld(structure, true, false, false)).toBeNull()
  })
  it('a group row never goes under a line grouped under it', () => {
    const choices = groupChoices(structure.lines, [LINE_IDS.kit]).map((line) => line.id)
    expect(choices).not.toContain(LINE_IDS.kit)
    expect(choices).not.toContain(LINE_IDS.shoulder)
    expect(choices).toContain(LINE_IDS.leather)
  })
  it('a sub-assembly only on the component we make, in pieces, not sent by the customer', () => {
    const line = (id: string) => structure.lines.find((entry) => entry.id === id)!
    expect(subAssemblyHeld(line(LINE_IDS.kit))).toBeNull()
    expect(subAssemblyHeld(line(LINE_IDS.leather))).toBe('line.sub.held.notComponent')
    expect(subAssemblyHeld({ ...line(LINE_IDS.kit), uom: 'M' })).toBe('line.sub.held.unit')
    expect(subAssemblyHeld({ ...line(LINE_IDS.kit), customerSuppliedByPartyId: 'x' })).toBe('line.sub.held.customer')
  })
  it('a customer never sends a sub-assembly or a line bought from a named supplier', () => {
    const deep = demoDepth().lines
    const liner = deep.find((line) => line.id === LINE_IDS.liner)!
    expect(customerHeld(liner)).toBe('line.customer.held.sub')
    expect(customerHeld({ ...deep[0]!, supplier: { id: 'x', code: 'SUP', name: 'Supplier' } })).toBe('line.customer.held.supplier')
    expect(customerHeld(deep[0]!)).toBeNull()
    const rows = lineRows(depthBom(), demoStructure(), demoDepth(), null, 'en').filter((row) => [LINE_IDS.liner, LINE_IDS.shoulder].includes(row.id))
    expect(supplyBlocked(rows)).toEqual(['100 · LNR-TERM'])
  })
  it('a sub-assembly\'s revisions: released first, then drafts, never an obsolete one', () => {
    const revisions = subRevisions({
      id: 's',
      code: 'S',
      name: 'S',
      status: 'ACTIVE',
      revisions: [
        { id: 'a', revision: 1, status: 'OBSOLETE' },
        { id: 'b', revision: 3, status: 'DRAFT' },
        { id: 'c', revision: 2, status: 'RELEASED' },
      ] as never,
    })
    expect(revisions.map((revision) => revision.id)).toEqual(['c', 'b'])
  })
})

describe('THE check on this tab', () => {
  it('shows the BOM\'s and the structure\'s findings, not the routing\'s; the mark counts what stops the release', () => {
    const structure = demoStructure({ check: 'w2b' })
    const withRouting = { ...structure.check, blockers: [...structure.check.blockers, { code: 'NO_STEPS' as const, severity: 'BLOCKER' as const, message: 'x', cell: { lineId: null, column: 'routing' as const, size: null, colourwayId: null, alternateId: null, stepId: null } }] }
    const own = bomFindings(withRouting)
    expect(own.blockers.map((item) => item.code)).not.toContain('NO_STEPS')
    expect(own.blockers).toHaveLength(5)
    expect(own.warnings).toHaveLength(2)
    expect(bomMarkCount(structure)).toBe(5)
    expect(bomMarkCount(demoStructure({ released: true }))).toBeNull()
    expect(bomMarkCount(null)).toBeNull()
  })
  it('names the line, the sub-assembly and the alternate in a structure finding', () => {
    const structure = demoStructure({ check: 'w2b' })
    const circle = structure.check.blockers.find((item) => item.code === 'SUB_ASSEMBLY_CIRCLE')!
    expect(structureWords(circle, structure, demoDepth())).toEqual({ key: 'findings.SUB_ASSEMBLY_CIRCLE', params: { line: '100 · LNR-TERM', material: 'LNR-TERM', sub: 'DEMO-LNR-01 r2', alternate: '—', size: '—' } })
    const archived = structure.check.warnings.find((item) => item.code === 'ALTERNATE_ARCHIVED')!
    expect(structureWords(archived, structure, demoDepth()).params.alternate).toBe('FOD-MESH-B')
  })
  it('lands Show me on the cell to fix', () => {
    const cell = (at: Record<string, unknown>) => ({ lineId: 'L', column: null, size: null, colourwayId: null, alternateId: null, stepId: null, ...at }) as never
    expect(showMeOf({ code: 'SIZE_QUANTITY_MISSING', cell: cell({ column: 'sizes', size: '58' }) })).toEqual({ to: 'sizes', lineId: 'L', size: '58' })
    expect(showMeOf({ code: 'COLOUR_MISSING', cell: cell({ column: 'colours', colourwayId: 'C' }) })).toEqual({ to: 'colours', lineId: 'L', colourwayId: 'C' })
    expect(showMeOf({ code: 'ALTERNATE_BLOCKED', cell: cell({ column: 'alternates', alternateId: 'A' }) })).toEqual({ to: 'line', lineId: 'L', part: 'alternates' })
    expect(showMeOf({ code: 'SUB_ASSEMBLY_CIRCLE', cell: cell({ column: 'subAssembly' }) })).toEqual({ to: 'line', lineId: 'L', part: 'structure' })
    expect(showMeOf({ code: 'GROUP_CIRCLE', cell: cell({ column: 'parentLineId' }) })).toEqual({ to: 'line', lineId: 'L', part: 'structure' })
    expect(showMeOf({ code: 'WASTAGE_OUT_OF_RANGE', cell: cell({ column: 'wastagePct' }) })).toEqual({ to: 'edit', lineId: 'L' })
    expect(showMeOf({ code: 'MATERIAL_BLOCKED', cell: cell({ column: 'itemId' }) })).toEqual({ to: 'row', lineId: 'L' })
    expect(showMeOf({ code: 'NO_PLANNED_HIDE_YIELD', cell: cell({ lineId: null, column: 'plannedHideYieldPct' }) })).toEqual({ to: 'yield' })
    expect(showMeOf({ code: 'NO_LINES', cell: cell({ lineId: null }) })).toEqual({ to: 'add' })
    expect(showMeOf({ code: 'NO_ACTIVE_COLOURWAY', cell: cell({ lineId: null, column: 'style' }) })).toBeNull()
  })
})

describe('alternates', () => {
  it('a quantity above 0 typed either way, or empty (the line\'s own)', () => {
    expect(alternateQty('1,9')).toBe('1.9')
    expect(alternateQty(' 2.50 ')).toBe('2.5')
    expect(alternateQty('')).toBeNull()
    expect(alternateQty('0')).toBeUndefined()
    expect(alternateQty('abc')).toBeUndefined()
  })
  it('none on a sub-assembly line, at most ten, the order moves one place', () => {
    const deep = demoDepth().lines
    expect(addAlternateHeld(deep.find((line) => line.id === LINE_IDS.liner)!, null)).toBe('alt.held.sub')
    expect(addAlternateHeld({ subAssembly: false, alternates: Array.from({ length: 10 }, () => deep[0]!.alternates[0]!) }, null)).toBe('alt.held.max')
    expect(addAlternateHeld(deep[0]!, 'hold.frozen')).toBe('hold.frozen')
    expect(addAlternateHeld(deep[0]!, null)).toBeNull()
    const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(movedOrder(three, 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(movedOrder(three, 'c', 1)).toBeNull()
    expect(movedOrder(three, 'a', -1)).toBeNull()
  })
})

describe('leather: the pattern pieces\' minimum grades', () => {
  it('per minimum grade, best first, the pieces per garment that need it or better and their share', () => {
    const read = leatherPieces(demoPieces(), LINE_IDS.leather, 'en')
    // A: fronts 1 + 1, collar 1 = 3; B: back 1, sleeves 2, elbow patches 2 = 5; C: facings 2; any: under-collar 1 → 11.
    expect(read.total).toBe(11)
    expect(read.mix.map((row) => [row.grade?.code ?? 'any', row.pieces, row.pct])).toEqual([
      ['A', 3, 27],
      ['B', 5, 45],
      ['C', 2, 18],
      ['any', 1, 9],
    ])
    expect(read.pieces[0]).toMatchObject({ name: 'Davanti sinistro', minGrade: { code: 'A', label: 'First choice' } })
    expect(leatherPieces(demoPieces(), LINE_IDS.leather, 'it').pieces[0]?.minGrade?.label).toBe('Prima scelta')
    expect(leatherPieces(demoPieces(), LINE_IDS.shoulder, 'en')).toEqual({ pieces: [], mix: [], total: 0 })
  })
})

// ---- every key in both languages; every W2b case drawn with no key left ----------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'demo' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') ? [path] : []
  })
}
const PREFIXES = ['view', 'depth', 'hold', 'mark', 'done', 'section', 'revisionStatus', 'approval', 'materialStatus', 'col', 'lines', 'alt', 'supply', 'option', 'menu', 'bulk', 'findings', 'keyHint', 'line', 'search', 'sizes', 'fill', 'tree', 'usedIn', 'grades']
const KEY = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
const has = (locale: (typeof LOCALES)[number], key: string) => {
  const dictionary = CATALOGUE[locale]['products-bom-depth'] ?? {}
  return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
}
/** The words of the studio's own catalogue (`tp('…')`) are left out: they are `products`'s. */
const own = (text: string) => text.replace(/\btp\(\s*['`][^'`]*['`]/g, '')

describe('every key the BOM in depth names exists in it and en', () => {
  const literal = sources(HERE).flatMap((file) => [...own(readFileSync(file, 'utf8')).matchAll(KEY)].map((match) => match[1]!))
  const tab = [...readFileSync(join(HERE, '../view/BomTab.tsx'), 'utf8').matchAll(/\btd\(\s*'([\w.]+)'/g)].map((match) => match[1]!)
  const built = [
    ...BOM_SECTIONS.map((section) => `section.${section}`),
    ...ALTERNATE_USES.map((use) => `alt.use.${use}`),
    ...ALTERNATE_HELD.map((held) => `alt.needs.${held}`),
    ...MATERIAL_APPROVALS.map((approval) => `approval.${approval}`),
    ...REVISION_STATUSES.map((status) => `revisionStatus.${status}`),
    ...STRUCTURE_CODES.map((code) => `findings.${code}`),
    ...['keep', 'we', 'customer'].map((who) => `bulk.who.${who}`),
    ...['keep', 'yes', 'no'].map((mark) => `bulk.workshop.${mark}`),
    'common.back',
    'common.yes',
    'common.no',
  ]
  const keys = [...new Set([...literal, ...tab, ...built])]
  for (const locale of LOCALES) {
    it(`products-bom-depth (${locale})`, () => {
      expect(keys.length).toBeGreaterThan(150)
      expect(keys.filter((key) => !has(locale, key))).toEqual([])
    })
  }
  it('W1\'s BOM findings keep W1\'s words (products issue.*)', () => {
    for (const locale of LOCALES) for (const code of [...BOM_BLOCKERS, ...BOM_WARNINGS]) expect(`issue.${code}` in (CATALOGUE[locale]['products'] ?? {}), `${code} (${locale})`).toBe(true)
  })
})

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

describe('every W2b case of SCR-042 draws in both languages with no key left on screen', () => {
  const cases = (bomScreen as DesignScreen<unknown>).cases.filter((item) => item.id.startsWith('w2b-241-'))
  for (const locale of LOCALES) {
    it(`${cases.length} cases in ${locale}`, () => {
      expect(cases.length).toBeGreaterThanOrEqual(25)
      for (const item of cases) {
        const View = bomScreen.view as ComponentType<{ model: unknown }>
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
          .replace(/https?:\/\/[^"\s<]+/g, '')
          .replace(/compliance\.certificates\.[a-z]+/g, '')
        expect(html.length, item.id).toBeGreaterThan(100)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }
})
