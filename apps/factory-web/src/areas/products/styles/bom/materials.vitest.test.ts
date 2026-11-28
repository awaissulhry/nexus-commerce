import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { demoBom, demoCost, GRAINS } from '../demo/fixtures'
import type { BomLine } from '../api'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { writeProblem } from '../problems'
import { BOM_REFUSALS, bomRefusalOf, ceRecheckOf, costsOf, customerSent, isCeLine, lineFactsOf, longestWaits, mainOf, needOf, orderNeedOf, piecesOf, stepOf, topLineOf, typedSizesOf } from './materials-model'

/**
 * owb-pd5 steps 5.1 + 5.2 (design § 5zc "Materials"; prototype mat.js needQ, openNeed, lineCost) — the Materials tab's rules (written,
 * not run: Owner rule, checks at the end).
 */

const bom = demoBom()
const lineOf = (code: string): BomLine => bom.lines.find((line) => line.item.code === code)!
/** A line with pd3's facts (wait, main) as the API will send them. */
const withPd3 = (line: BomLine, extra: { leadTimeDays?: number | null; isMain?: boolean }): BomLine => ({ ...line, ...extra }) as BomLine

describe('step 5.1 — what an order needs: quantity for one piece × (1 + waste) × pieces', () => {
  it('a line of one quantity: 2.5 × 1.10 × 4 = 11', () => {
    const line = { qty: '2.5', wastagePct: '10', sizeDependent: false, bySize: [] }
    expect(needOf(line, null, 4)).toBe('11')
    expect(needOf(line, null, 0)).toBe('0')
  })
  it('a size-dependent line takes the size\'s own quantity; a size without one is unknown, never 0', () => {
    const line = { qty: '1', wastagePct: '20', sizeDependent: true, bySize: [{ size: '50', qty: '1.5', gross: null, base: null }, { size: '52', qty: null, gross: null, base: null }] }
    expect(needOf(line, '50', 10)).toBe('18')
    expect(needOf(line, '52', 10)).toBeNull()
  })
  it('every material of an order, the customer\'s lines said as theirs; pieces typed are a whole number from 1 to 100 000', () => {
    const facts = lineFactsOf(bom, null, null)
    const rows = orderNeedOf(bom, facts, bom.style.baseSize, 3)
    expect(rows).toHaveLength(bom.lines.length)
    expect(rows.find((row) => row.code === 'PROT-SPAL-L2')?.need).toBe('6')
    expect(piecesOf('12')).toBe(12)
    expect(piecesOf('0')).toBeNull()
    expect(piecesOf('2.5')).toBeNull()
    expect(piecesOf('100001')).toBeNull()
  })
})

describe('step 5.1 — no cost without the cost grain', () => {
  it('without the cost grain no amount is read at all; with it, one piece and each line at the sheet\'s default cell', () => {
    const sheet = demoCost()
    expect(costsOf(sheet, GRAINS.production)).toBeNull()
    expect(costsOf(sheet, GRAINS.sales)).toBeNull()
    expect(costsOf(null, GRAINS.owner)).toBeNull()
    const owner = costsOf(sheet, GRAINS.owner)
    expect(owner?.currency).toBe(sheet.currency)
    expect(Object.keys(owner?.byLine ?? {}).length).toBeGreaterThan(0)
    const facts = lineFactsOf(bom, null, null)
    expect(topLineOf(facts, null).cost).toBeNull()
    expect(JSON.stringify(topLineOf(facts, null))).not.toMatch(/€/)
  })
})

describe('step 5.1 — more for each size up never overwrites a typed size', () => {
  it('every size with its own quantity except the base is kept by the fill (DS SizeFill `overrides`)', () => {
    const line = { sizes: [{ size: '46', qty: '1' }, { size: '48', qty: '1.1' }, { size: '50', qty: '1.2' }] }
    expect(typedSizesOf(line, '48')).toEqual(['46', '50'])
    expect(typedSizesOf({ sizes: [] }, '48')).toEqual([])
    const dialogs = readFileSync(new URL('./depth/view/DepthDialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain('overrides={typedSizesOf(line, bom.style.baseSize)}')
  })
  it('the step to the next size up of a size-dependent line; none for a line of one quantity', () => {
    const sized = { sizeDependent: true, bySize: [{ size: '50', qty: '1.5', gross: null, base: null }, { size: '52', qty: '1.62', gross: null, base: null }] }
    expect(stepOf(sized, ['50', '52'], '50')).toBe('0.12')
    expect(stepOf({ ...sized, sizeDependent: false }, ['50', '52'], '50')).toBeNull()
    expect(stepOf(sized, ['50', '52'], '52')).toBeNull()
  })
})

describe('step 5.1 — main material, waits and what the customer sends', () => {
  it('the main material (pd3 isMain); the longest waits first, the customer\'s lines left out of them', () => {
    const lines = bom.lines.map((line) => (line.item.code === lineOf('PROT-SPAL-L2').item.code ? withPd3(line, { leadTimeDays: 42 }) : line.item.kind === 'LEATHER' ? withPd3(line, { leadTimeDays: 30, isMain: true }) : withPd3(line, { leadTimeDays: 5 })))
    const facts = lineFactsOf({ lines }, null, null)
    expect(mainOf(facts)?.kind).toBe('LEATHER')
    expect(longestWaits(facts).map((fact) => fact.wait)).toEqual([42, 30, 5])
    expect(topLineOf(facts, null).longestWait).toBe(42)
    expect(customerSent(facts)).toEqual([])
  })
  it('an API before pd3: no wait ("—", never 0 days) and no main material', () => {
    const facts = lineFactsOf(bom, null, null)
    expect(facts.every((fact) => fact.wait === null && !fact.main)).toBe(true)
    expect(longestWaits(facts)).toEqual([])
  })
})

describe('owb-pd8b — the BOM\'s own refusals (pd3 as landed) in the Materials tab\'s words', () => {
  it('reads MAIN_REQUIRED / SAME_MATERIAL from the refused paths; anything else is none', () => {
    expect(bomRefusalOf(['refusal/MAIN_REQUIRED'])).toBe('MAIN_REQUIRED')
    expect(bomRefusalOf(['body/qty', 'refusal/SAME_MATERIAL'])).toBe('SAME_MATERIAL')
    expect(bomRefusalOf(['refusal/OTHER', 'version'])).toBeNull()
    expect(bomRefusalOf(undefined)).toBeNull()
  })

  it('a BOM rule is no moved record: the studio\'s notice points to the tab, nothing is read again', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/MAIN_REQUIRED' }]))).toEqual({ key: 'problem.write.bomRule', reload: false, paths: ['refusal/MAIN_REQUIRED'] })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SAME_MATERIAL' }]))).toMatchObject({ key: 'problem.write.bomRule', reload: false })
  })

  it('the words exist in both languages; the tab draws them, the line action sends a real `isMain`', () => {
    for (const locale of LOCALES) {
      const mat = (CATALOGUE[locale]['products-bom-depth'] ?? {}) as Record<string, unknown>
      const products = (CATALOGUE[locale]['products'] ?? {}) as Record<string, unknown>
      for (const code of BOM_REFUSALS) expect(`mat.refusal.${code}` in mat || JSON.stringify(mat).includes(`"${code}"`), `${locale} ${code}`).toBe(true)
      expect('problem.write.bomRule' in products || JSON.stringify(products).includes('"bomRule"'), locale).toBe(true)
    }
    const tab = readFileSync(new URL('./view/BomTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('const bomRefused = bomRefusalOf(model.refused)')
    expect(tab).toContain('td(`mat.refusal.${bomRefused}`)')
    expect(readFileSync(new URL('./depth/view/LinesGrid.tsx', import.meta.url), 'utf8')).toContain('onEditLine?.(data.id, { isMain: true })')
  })
})

describe('step 5.2 — CE: check the certificate again', () => {
  const protector = lineOf('PROT-SPAL-L2')
  it('a protection line taken out against the released revision shows the note', () => {
    const draft = { lines: bom.lines.filter((line) => line.id !== protector.id) }
    const check = ceRecheckOf(draft, lineFactsOf(draft, null, null), bom)
    expect(check?.takenOut.map((line) => line.code)).toContain('PROT-SPAL-L2')
  })
  it('a protection line now sent by the customer shows the note', () => {
    const facts = lineFactsOf(bom, null, null).map((fact) => (fact.id === protector.id ? { ...fact, sentBy: 'Brand Alpha' } : fact))
    const check = ceRecheckOf(bom, facts, bom)
    expect(check?.customerSends).toEqual([{ code: 'PROT-SPAL-L2', name: protector.item.name, sentBy: 'Brand Alpha' }])
    expect(check?.takenOut).toEqual([])
  })
  it('nothing changed on a CE part: no note; a lining the customer sends is no CE part', () => {
    expect(ceRecheckOf(bom, lineFactsOf(bom, null, null), bom)).toBeNull()
    const lining = bom.lines.find((line) => line.item.kind === 'LINING')
    if (lining) {
      const facts = lineFactsOf(bom, null, null).map((fact) => (fact.id === lining.id ? { ...fact, sentBy: 'Brand Alpha' } : fact))
      expect(ceRecheckOf(bom, facts, bom)).toBeNull()
    }
    expect(isCeLine({ item: { kind: 'LABEL', code: 'ETI-CE', name: 'CE label' } }, null)).toBe(true)
    expect(isCeLine({ item: { kind: 'LABEL', code: 'ETI-CURA', name: 'Care label' } }, null)).toBe(false)
    expect(isCeLine({ item: { kind: 'TEXTILE', code: 'X', name: 'X' } }, 'PROTECTION')).toBe(true)
  })
})
