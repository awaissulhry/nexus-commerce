// Self-test for scripts/check-stock-writer-lock.mjs — every bypass the stock model review found
// (2026-09-26, B3) must go red, by name, and a tree without one must stay green.
//   node --test scripts/check-stock-writer-lock.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('./check-stock-writer-lock.mjs', import.meta.url))
const EMPTY_LIST = JSON.stringify({ files: {}, sqlFunctions: {}, reservationFiles: {}, reservationSqlFunctions: {}, orderMovementFiles: {} })

/** Run the gate on a scratch tree holding `files` (path → text) and an empty approved list. */
function gate(files) {
  const root = mkdtempSync(join(tmpdir(), 'stock-writer-gate-'))
  try {
    const all = { 'apps/api/src/services/harmless.ts': 'export const nothing = 1\n', ...files }
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    writeFileSync(join(root, 'list.json'), EMPTY_LIST)
    const run = spawnSync(process.execPath, [GATE, '--check', '--root', root, '--list', join(root, 'list.json')], { encoding: 'utf8' })
    return { status: run.status, out: `${run.stdout}\n${run.stderr}` }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('CONTROL: a tree with no stock write passes', () => {
  const { status, out } = gate({})
  assert.equal(status, 0, out)
})

const TS = 'apps/api/src/services/probe.ts'
const cases = {
  'updateManyAndReturn on the reservation delegate': [TS, 'export const f = (tx: any) => tx.stockReservation.updateManyAndReturn({ where: {}, data: {} })\n', 'StockReservation'],
  'createManyAndReturn on the level delegate': [TS, 'export const f = (tx: any) => tx.stockLevel.createManyAndReturn({ data: [] })\n', 'writes StockLevel'],
  'a schema-qualified raw write': [TS, 'export const f = (tx: any) => tx.$executeRaw`UPDATE public."StockReservation" SET "releasedAt" = now()`\n', 'StockReservation'],
  'a destructured, renamed delegate': [TS, 'export async function f(tx: any) { const { stockReservation: holds } = tx; await holds.update({ where: { id: "x" }, data: {} }) }\n', 'StockReservation'],
  'an element-access delegate': [TS, "export const f = (tx: any) => tx['stockReservation'].update({ where: { id: 'x' }, data: {} })\n", 'StockReservation'],
  'a delegate kept in a variable': [TS, 'export async function f(db: any) { const levels = db.stockLevel; await levels.update({ where: { id: "x" }, data: {} }) }\n', 'writes StockLevel'],
  'an order movement outside the stock service': [TS, "import { applyStockMovement } from './stock-movement.service.js'\nexport const f = () => applyStockMovement({ productId: 'p', change: -1, reason: 'ORDER_PLACED', orderId: 'o' })\n", 'order stock movement'],
  'an order movement written directly': [TS, "export const f = (tx: any) => tx.stockMovement.create({ data: { productId: 'p', change: 2, reason: 'ORDER_CANCELLED' as const } })\n", 'order stock movement'],
  'CREATE FUNCTION without OR REPLACE in a policy file': ['packages/database/workspaces/probe.sql', 'CREATE FUNCTION probe_write() RETURNS void LANGUAGE sql AS $$ UPDATE "StockLevel" SET quantity = 0 $$;\n', 'probe_write'],
  // Re-review (2026-09-26): the cheap remaining bypasses.
  'a raw order movement insert': [TS, "export const f = (tx: any, id: string) => tx.$executeRaw`INSERT INTO \"StockMovement\" (id, reason, change) VALUES (${id}, 'ORDER_PLACED', -1)`\n", 'order stock movement'],
  'a raw StockLevel update through $executeRawUnsafe': [TS, "export const f = (tx: any) => tx.$executeRawUnsafe('UPDATE \"StockLevel\" SET quantity = 0')\n", 'writes StockLevel'],
  'order movements written with createMany': [TS, "export const f = (tx: any) => tx.stockMovement.createMany({ data: [{ productId: 'p', change: -1, reason: 'ORDER_PLACED' }] })\n", 'order stock movement'],
  'a level written through a product relation': [TS, "export const f = (tx: any) => tx.product.update({ where: { id: 'p' }, data: { stockLevels: { updateMany: { where: {}, data: { quantity: 0 } } } } })\n", 'writes StockLevel'],
  'a hold written through a level relation': [TS, "export const f = (tx: any) => tx.product.update({ where: { id: 'p' }, data: { stockLevels: { update: { where: { id: 'l' }, data: { reservations: { create: { quantity: 1 } } } } } } })\n", 'StockReservation'],
  'an order movement written through a product relation': [TS, "export const f = (tx: any) => tx.product.update({ where: { id: 'p' }, data: { stockMovements: { create: { change: -1, reason: 'ORDER_CANCELLED' } } } })\n", 'order stock movement'],
  'a delegate behind a cast': [TS, "export const f = (tx: any) => (tx.stockReservation as any).update({ where: { id: 'x' }, data: {} })\n", 'StockReservation'],
  'a function defined only in a migration': ['packages/database/prisma/migrations/20990101a_probe/migration.sql', 'CREATE OR REPLACE FUNCTION public.probe_migration() RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "StockReservation" (id) VALUES (\'x\'); END $$;\n', 'probe_migration'],
}
for (const [name, [path, text, expected]] of Object.entries(cases)) {
  test(`fails on ${name}`, () => {
    const { status, out } = gate({ [path]: text })
    assert.equal(status, 1, `the gate passed ${name}:\n${out}`)
    assert.match(out, new RegExp(expected))
    assert.match(out, new RegExp(path.split('/').pop().replace('.', '\\.')))
  })
}
