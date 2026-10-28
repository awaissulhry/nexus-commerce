import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// scripts/factory/check-money-grains.mjs, proven on plants: each test writes files into a temporary root with the
// repository's layout and runs the guard on it.

const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url))
const GUARD = join(REPO, 'scripts/factory/check-money-grains.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'factory-money-grains-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const guard = (root?: string) => {
  const run = spawnSync(process.execPath, [GUARD, ...(root ? [root] : [])], { encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

const CONTRACT = 'apps/factory-api/src/modules/quotes/contract.ts'
const DOMAIN = 'packages/factory-domain/src/costing/contracts.ts'
const COMMAND = 'apps/factory-api/src/modules/quotes/quotes.ts'
const SCHEMA = 'packages/factory-db/prisma/schema/sales.prisma'

describe('check-money-grains', () => {
  it('passes on the repository and on marked plants', () => {
    expect(guard()).toMatchObject({ status: 0, output: expect.stringMatching(/check-money-grains: ok/) })
    const marked = tree({
      [CONTRACT]: `export const line = output({
  unitPrice: money.price(unitPrice()),
  unitCost: money.cost(unitPrice()).nullable(),
  'marginPct': money.margin(z.string()),
  pieceRate: money.wages(unitPrice()),
  totalLines: notMoney(z.number().int()),
  sku: z.string(),
})
export const more = line.extend({ totalMinor: money.price(amountMinor()) })`,
      [COMMAND]: `audit({ recordType: 'Quote', recordId: id, before: { unitCost: markMoney('cost', a) }, after: { lines: { totalMinor: markMoney('price', 3) }, sessionsEnded: 2 } })`,
      [SCHEMA]: `model QuoteLine {
  id        String  @id @db.Uuid
  /// The unit price.
  /// @grain price
  unitPrice Decimal @db.Decimal(18, 6)
  /// @not-money a count of lines
  totalLines Int
}`,
      'apps/factory-api/src/modules/quotes/quotes.vitest.test.ts': 'output({ unitCost: z.string() })',
      'apps/factory-api/src/modules/quotes/testing/probe.ts': 'output({ unitCost: z.string() })',
    })
    expect(guard(marked)).toMatchObject({ status: 0, output: expect.stringMatching(/ok \(3 file\(s\)/) })
  })

  it.each<[string, Record<string, string>, RegExp]>([
    ['an unmarked output field', { [CONTRACT]: 'output({ unitCost: unitPrice() })' }, /contract\.ts:1 {2}rule 1: contract field "unitCost"/],
    ['an unmarked domain zod object field', { [DOMAIN]: 'const x = z.object({\n  totalAmount: amountMinor(),\n})' }, /contracts\.ts:2 {2}rule 1: contract field "totalAmount"/],
    ['an unmarked input field', { [CONTRACT]: "input({ 'priceList': z.string() })" }, /rule 1: contract field "priceList"/],
    ['an unmarked extension', { [CONTRACT]: 'base.extend({ marginPct: z.string() })' }, /rule 1: contract field "marginPct"/],
    ['a strict object with a wage', { [CONTRACT]: 'z.strictObject({ hourlyWage: z.string() })' }, /rule 1: contract field "hourlyWage"/],
    ['a grain that does not exist', { [CONTRACT]: 'output({ unitCost: money.salary(unitPrice()) })' }, /rule 1: contract field "unitCost"/],
    ['a marker used later in the chain', { [CONTRACT]: 'output({ unitCost: unitPrice().pipe(money.cost(z.string())) })' }, /rule 1: contract field "unitCost"/],
    ['a shorthand money field', { [CONTRACT]: 'output({ totalAmount })' }, /rule 1: contract field "totalAmount"/],
    ['an unmarked audit value', { [COMMAND]: "audit({ recordType: 'Quote', recordId: id, after: { unitCost: '1.000000' } })" }, /rule 2: audit field "unitCost"/],
    ['a nested unmarked audit value', { [COMMAND]: "audit({ recordType: 'Quote', recordId: id, before: { line: { totalAmount: 3 } } })" }, /rule 2: audit field "totalAmount"/],
    ['an unmarked column', { [SCHEMA]: 'model QuoteLine {\n  id String @id\n  unitCost Decimal @db.Decimal(18, 6)\n}' }, /sales\.prisma:3 {2}rule 3: column "unitCost"/],
    ['a column whose doc names no grain', { [SCHEMA]: 'model QuoteLine {\n  /// the cost\n  amountMinor Int\n}' }, /rule 3: column "amountMinor"/],
  ])('fails on %s', (_label, plants, expected) => {
    const result = guard(tree(plants))
    expect(result.status).toBe(1)
    expect(result.output).toMatch(expected)
  })
})
