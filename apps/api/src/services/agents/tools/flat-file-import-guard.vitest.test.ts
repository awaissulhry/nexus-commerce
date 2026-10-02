/**
 * MCP full control T10 (docs/mcp-full-control/sections/03-content.md §4 "Guard"; the Owner's rule of 2026-09-29: never
 * the old flat-file pages) — no file in services/agents/tools imports a flat-file module: Amazon's flat-file services
 * (`services/amazon/*flat-file*`), eBay's (`services/ebay-flat-file*`) or the flat-file routes (`routes/*flat-file*`).
 * Claude's tools write through the product sheet's writer and the content door only.
 *
 * Read from the source, every import form: `import … from`, `export … from`, `import('…')` and `require('…')`. A new
 * tool file is checked on the day it is added; the checker itself is shown to fail on each form.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TOOLS = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(TOOLS, '../../..')
/** A module under services/ or routes/ whose file name says flat-file (the three families the rule names, and their kin). */
const FLAT_FILE = /^(services|routes)\/(?:.+\/)?[^/]*flat-file[^/]*$/
const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** The flat-file modules a source file imports, as paths under src/ without their extension. */
export function flatFileImports(file: string, source: string): string[] {
  const found = new Set<string>()
  for (const pattern of SPECIFIERS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      const target = relative(SRC, resolve(dirname(file), specifier)).replace(/\\/g, '/').replace(/\.(js|ts|mjs|cjs)$/, '')
      if (FLAT_FILE.test(target)) found.add(target)
    }
  }
  return [...found]
}

const toolFiles = () => readdirSync(TOOLS)
  .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
  .map((name) => join(TOOLS, name))

describe('T10 — Claude\'s tools never import a flat-file module', () => {
  it('reads every tool file (a guard over nothing would pass)', () => {
    const names = toolFiles().map((file) => file.slice(TOOLS.length + 1))
    expect(names).toEqual(expect.arrayContaining(['content.tools.ts', 'content-change.tools.ts', 'mutate.tools.ts', 'bulk.tools.ts']))
  })

  it('no file in services/agents/tools imports one', () => {
    const offenders = toolFiles().flatMap((file) => flatFileImports(file, readFileSync(file, 'utf8')).map((target) => `${file.slice(SRC.length + 1)} → ${target}`))
    expect(offenders).toEqual([])
  })

  it('the check fails on each import form and each flat-file family, and passes the rest', () => {
    const file = join(TOOLS, 'example.tools.ts')
    expect(flatFileImports(file, [
      "import { pushFlatFile } from '../../amazon/flat-file.service.js'",
      "export { removeRows } from '../../amazon/amazon-flat-file-remove.service.js'",
      "const create = await import('../../ebay-flat-file-create.service.js')",
      "const routes = require('../../../routes/flat-file-import.routes.js')",
      "import '../../../routes/ebay-flat-file.routes.js'",
    ].join('\n')).sort()).toEqual([
      'routes/ebay-flat-file.routes', 'routes/flat-file-import.routes', 'services/amazon/amazon-flat-file-remove.service',
      'services/amazon/flat-file.service', 'services/ebay-flat-file-create.service',
    ])
    expect(flatFileImports(file, [
      "import { applyProductBulkEdits } from '../../products/bulk-edit.service.js'",
      "import { z } from 'zod'",
      "const sheet = await import('../../pim/information-sheet.js')",
    ].join('\n'))).toEqual([])
  })
})
