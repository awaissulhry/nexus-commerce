import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * pg-w1 (portal grid plan § 5 pg-1.5; common rules: "a moved file imports no office or portal code") — the boundary guard
 * (scripts/factory/check-view-boundaries.mjs) checks only files inside a view, not `src/lib` (G3-B3). So this pin holds the shared
 * list parts apart: no file of lib/customer-band, lib/order-groups, lib/order-cells, nor the moved bubble, imports an office or
 * portal file (`areas/`, `portal/`, `app/`, `shell/{office,nav,switcher,palette,portal}`) — also not `import type` and not a css
 * file. And the office's sheet imports the shared cells AFTER its own css: the rules moved verbatim load after the sheet's (the
 * cascade keeps its order).
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FOLDERS = ['lib/customer-band', 'lib/order-groups', 'lib/order-cells']
const ALSO = ['lib/last-message-cell/view/NewMessagesBubble.tsx']
const OFF_LIMITS = ['areas', 'portal', 'app', 'shell/office', 'shell/nav', 'shell/switcher', 'shell/palette', 'shell/portal']

function filesOf(folder: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(folder)) {
    const path = join(folder, name)
    if (statSync(path).isDirectory()) out.push(...filesOf(path))
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(path)
  }
  return out
}

/** Every module a file names: `import … from '…'`, `import '…'`, `export … from '…'`, `import('…')`, css `@import '…'`. */
const specifiersOf = (source: string): string[] => [...source.matchAll(/(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|@import\s+)['"]([^'"]+)['"]/g)].map((match) => match[1]!)

describe('pg-w1: the shared list parts import no office or portal code', () => {
  const files = [...FOLDERS.flatMap((folder) => filesOf(join(SRC, folder))), ...ALSO.map((file) => join(SRC, file))]

  it('the folders hold the moved parts (the pin reads real files)', () => {
    const names = files.map((file) => relative(SRC, file).split(sep).join('/'))
    for (const part of ['lib/customer-band/CustomerBand.tsx', 'lib/order-groups/groups.ts', 'lib/order-groups/view/GroupsBand.tsx', 'lib/order-cells/model.ts', 'lib/order-cells/view/DoorCell.tsx', 'lib/order-cells/view/StateChip.tsx', 'lib/order-cells/view/MarkChip.tsx', 'lib/order-cells/view/PromiseCell.tsx', 'lib/order-cells/view/ShippedCell.tsx', 'lib/order-cells/view/OrderCard.tsx', 'lib/order-cells/use-room-width.ts', 'lib/order-cells/tail-whole.ts', 'lib/order-cells/order-cells.css', 'lib/last-message-cell/view/NewMessagesBubble.tsx']) expect(names, part).toContain(part)
  })

  it('no file names an office or portal module (relative paths resolved; type-only and css imports too)', () => {
    const crossings: string[] = []
    for (const file of files) {
      if (/\.vitest\.test\.ts$/.test(file)) continue // tests may read office files by path (the moved pins do)
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue // packages: @nexus/ui, @nexus/factory-domain, react, next, lucide-react
        const target = relative(SRC, resolve(dirname(file), specifier)).split(sep).join('/')
        if (OFF_LIMITS.some((root) => target === root || target.startsWith(`${root}/`))) crossings.push(`${relative(SRC, file)} → ${specifier}`)
      }
    }
    expect(crossings).toEqual([])
  })

  it('a view part fetches nothing (no API client, session, fetch or window size)', () => {
    for (const file of files.filter((each) => each.includes(`${sep}view${sep}`))) expect(readFileSync(file, 'utf8'), relative(SRC, file)).not.toMatch(/lib\/api\/|lib\/session\/|\bfetch\(|matchMedia|innerWidth/)
  })

  it('the office sheet imports the shared cells after its own css (the moved rules load after the sheet\'s: the cascade keeps its order)', () => {
    const parts = readFileSync(join(SRC, 'areas/sales/orders/list/sheet/parts.tsx'), 'utf8')
    const css = parts.indexOf("import './chips.css'")
    expect(css).toBeGreaterThan(parts.indexOf("import './sheet.css'"))
    for (const shared of ["lib/order-cells/view/DoorCell'", "lib/order-cells/view/StateChip'", "lib/order-cells/view/MarkChip'", "lib/last-message-cell/view/NewMessagesBubble'"]) expect(parts.indexOf(shared), shared).toBeGreaterThan(css)
    const view = readFileSync(join(SRC, 'areas/sales/orders/list/view/OrdersListView.tsx'), 'utf8')
    const sheet = view.indexOf("from '../sheet/parts'")
    for (const shared of ["lib/order-cells/view/PromiseCell'", "lib/order-cells/view/ShippedCell'", "lib/order-cells/view/OrderCard'"]) expect(view.indexOf(shared), shared).toBeGreaterThan(sheet)
  })
})
