import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { headButtonsOf as officeHeadButtonsOf, HEAD_BUTTONS_MAX as OFFICE_HEAD_BUTTONS_MAX } from '../../areas/sales/orders/record/production/layout'
import { HEAD_BUTTONS_MAX, headButtonsOf } from './model'

/**
 * owb-b5 (w5.1; design plan § 5i "ONE section kit") — the section kit MOVED from areas/sales/orders/record/view/production/Kit.tsx to
 * lib/record-sections, never copied: every reader imports it from here, areas/** holds no second kit, the kit imports no office or
 * portal code (the boundary guard does not check src/lib, so this pin does, as lib/order-cells' does), and its rules moved verbatim
 * from production.css to record-sections.css (same class names: the office pages stay byte-equal; the lead's DOM diff proves it).
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8')
const posix = (path: string): string => path.split(sep).join('/')
const OLD_KIT = 'areas/sales/orders/record/view/production/Kit'
const NEW_KIT = 'lib/record-sections/Kit'
const OFF_LIMITS = ['areas', 'portal', 'app', 'floor', 'links', 'shell/office', 'shell/nav', 'shell/switcher', 'shell/palette', 'shell/portal', 'shell/links']

function filesOf(folder: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(folder)) {
    const path = join(folder, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && !name.startsWith('.next')) out.push(...filesOf(path))
    } else if (/\.(ts|tsx|css)$/.test(name)) out.push(path)
  }
  return out
}
const isTest = (file: string): boolean => /\.vitest\.test\.ts$/.test(file)

/** Every module a file names: `import … from '…'`, `import '…'`, `export … from '…'`, `import('…')`, css `@import '…'`. */
const specifiersOf = (source: string): string[] => [...source.matchAll(/(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|@import\s+)['"]([^'"]+)['"]/g)].map((match) => match[1]!)
const targetOf = (file: string, specifier: string): string => posix(relative(SRC, resolve(dirname(file), specifier)))

describe('owb-b5 w5.1: ONE section kit, in lib/record-sections', () => {
  const kit = read('lib/record-sections/Kit.tsx')

  it('the kit and its one rule live here, unchanged: Section, CountsAsOf, InfoTip, PartReading, PartFailed, Quiet, useUnitWords; three head buttons', () => {
    for (const part of ['Section', 'CountsAsOf', 'InfoTip', 'PartReading', 'PartFailed', 'Quiet', 'useUnitWords']) expect(kit, part).toContain(`export function ${part}(`)
    expect(kit).toContain('<section id={id} className="fw-pt-sec fw-so-anchor" aria-labelledby={headId}>')
    expect(kit).toContain("import './record-sections.css'")
    expect(HEAD_BUTTONS_MAX).toBe(3)
    expect(headButtonsOf(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b', 'c'], more: ['d'] })
    // The office's layout re-exports the same function (its readers and its test keep their import).
    expect(officeHeadButtonsOf).toBe(headButtonsOf)
    expect(OFFICE_HEAD_BUTTONS_MAX).toBe(HEAD_BUTTONS_MAX)
  })

  it('areas/** holds no second kit: no Kit.tsx, no second section root, none of its parts defined again', () => {
    const copies: string[] = []
    for (const file of filesOf(join(SRC, 'areas'))) {
      if (isTest(file)) continue
      const path = posix(relative(SRC, file))
      if (/(^|\/)Kit\.tsx$/.test(path)) copies.push(`${path}: a Kit.tsx`)
      if (!/\.tsx?$/.test(path)) continue
      const text = readFileSync(file, 'utf8')
      if (text.includes('className="fw-pt-sec')) copies.push(`${path}: the kit's section root`)
      for (const part of ['CountsAsOf', 'InfoTip', 'PartReading', 'useUnitWords']) if (text.includes(`export function ${part}(`)) copies.push(`${path}: ${part}`)
    }
    expect(copies).toEqual([])
  })

  it('every reader imports the kit from lib/record-sections (no import of the old place is left; a counting pin: 41 readers at the move)', () => {
    const old: string[] = []
    const readers: string[] = []
    for (const file of filesOf(SRC)) {
      if (isTest(file) || !/\.tsx?$/.test(file)) continue
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue
        const target = targetOf(file, specifier)
        if (target === OLD_KIT) old.push(posix(relative(SRC, file)))
        if (target === NEW_KIT) readers.push(posix(relative(SRC, file)))
      }
    }
    expect(old).toEqual([])
    expect(readers.length).toBeGreaterThanOrEqual(41)
    for (const reader of ['areas/sales/orders/record/view/FilesTab.tsx', 'areas/sales/orders/record/changes/view/WaitingSection.tsx', 'areas/sales/orders/record/money/view/TotalsSection.tsx', 'areas/sales/orders/record/shipments/view/ShipmentsSection.tsx', 'areas/sales/orders/record/view/production/NowSection.tsx', 'areas/sales/customers/record/view/terms/HoldSection.tsx']) expect(readers, reader).toContain(reader)
  })

  it('the kit imports no office or portal code (type-only and css imports too; packages are fine)', () => {
    const crossings: string[] = []
    for (const file of filesOf(join(SRC, 'lib/record-sections'))) {
      if (isTest(file)) continue
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue
        const target = targetOf(file, specifier)
        if (OFF_LIMITS.some((root) => target === root || target.startsWith(`${root}/`))) crossings.push(`${posix(relative(SRC, file))} → ${specifier}`)
      }
    }
    expect(crossings).toEqual([])
  })

  it('the rules moved verbatim: record-sections.css holds the kit\'s, production.css keeps only the Production tab\'s own', () => {
    const shared = read('lib/record-sections/record-sections.css')
    const tab = read('areas/sales/orders/record/view/production/production.css')
    const moved = [
      '.fw-pt { container: pt / inline-size; display: flex; flex-direction: column; gap: var(--nds-space-16); min-width: 0; }',
      '.fw-pt-sec { container: sec / inline-size; min-width: 0; scroll-margin-top: var(--nds-space-4); }',
      '.fw-pt-head-r { display: flex; align-items: center; gap: var(--nds-space-6); flex-wrap: wrap; justify-content: flex-end; margin-left: auto; }',
      '.fw-pt-quiet { margin: 0; font-size: var(--nds-font-size-sm); color: var(--nds-text-muted); display: flex; align-items: center; gap: var(--nds-space-6); }',
      '.fw-pt-h3-sp { flex: 1; }',
      '.fw-pt-table { width: 100%; border-collapse: collapse; font-size: var(--nds-font-size-sm); }',
      '.fw-pt .nds-tooltip:not(:hover):not(:focus-within) > .tip { display: none; }',
      '.fw-pt-pairs > .fw-pt-sec > .nds-card { flex: 1 1 auto; }',
    ]
    for (const rule of moved) {
      expect(shared, rule).toContain(rule)
      expect(tab, rule).not.toContain(rule)
    }
    for (const selector of ['.fw-pt-blk {', '.fw-pt-h3 {', '.fw-pt-link {', '.fw-pt-pairs {', '.fw-pt-head {', '.fw-pt-table td {']) expect(tab, selector).not.toContain(`\n${selector}`)
    // The tab's own rules stay in its sheet (Production now, Work orders, the steps, the containers they query).
    for (const own of ['.fw-pt-now {', '.fw-pt-wo {', '.fw-pt-step {', '.fw-pt-cd > .fw-pt-blk { border-top: 0; padding-top: 0; }', '.fw-pt-segs {']) expect(tab, own).toContain(own)
    // The room, never the viewport; tokens only.
    expect(shared).not.toMatch(/@media/)
    expect(shared.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })

  it('the cascade keeps its order: the kit\'s rules load before the Production tab\'s and before the receipt window\'s', () => {
    const productionTab = read('areas/sales/orders/record/view/ProductionTab.tsx')
    expect(productionTab.indexOf("import './production/production.css'")).toBeGreaterThan(productionTab.indexOf("from './production/NowSection'"))
    const receipt = read('areas/sales/orders/record/view/production/ReceiptDialog.tsx')
    expect(receipt.indexOf("import './receipt.css'")).toBeGreaterThan(receipt.indexOf("lib/record-sections/Kit'"))
  })
})
