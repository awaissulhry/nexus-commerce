/**
 * PES.6 wave-4 — prove the cell-formula write path on the XAVIA fixture, then undo everything.
 * Covers §1.6 (A) value goes to the value layer, (B) '=' refused, (G) an error CLEARS the value,
 * self-reference + cycle refusal, and the synchronous dependency cascade.
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
import {
  setCellFormula, pinOverFormula, restoreCellFormula, listCellFormulas, FORMULA_PINNED_ACTION,
} from '../src/services/pim/mapping/cell-formula.service.js'

const ok = (c: boolean, m: string) => console.log(`  ${c ? 'PASS' : '🔴 FAIL'}  ${m}`)

const p = await prisma.product.findFirst({
  where: { sku: 'GALE-JACKET-BLACK-MEN-L' },
  select: { id: true, sku: true, name: true, brand: true, description: true },
})
if (!p) { console.log('fixture not found'); process.exit(1) }
console.log(`fixture: ${p.sku}\n  brand=${JSON.stringify(p.brand)}\n  name=${JSON.stringify(p.name?.slice(0,60))}`)

const ORIGINAL = { name: p.name, description: p.description }
const coord = { productId: p.id, scope: 'master' as const, fieldKey: 'description' }

try {
  console.log('\n--- (B) a stored expr beginning with "=" is refused ---')
  try {
    await setCellFormula({ ...coord, expr: '="x" + $brand' })
    ok(false, 'should have thrown')
  } catch (e: any) { ok(/leading "="/.test(e.message), `refused: ${e.message.slice(0, 60)}…`) }

  console.log('\n--- self-reference is refused with the field named ---')
  try {
    await setCellFormula({ ...coord, expr: '$description + "!"' })
    ok(false, 'should have thrown')
  } catch (e: any) { ok(/cannot depend on itself/.test(e.message), e.message.slice(0, 80)) }

  console.log('\n--- (A) a good formula writes its VALUE to the value layer ---')
  const r1 = await setCellFormula({ ...coord, expr: '"Gale Jacket " + $brand', updatedBy: 'pes6-e2e' })
  const after1 = await prisma.product.findUnique({ where: { id: p.id }, select: { description: true } })
  ok(r1.error === null, `no error; formula stored (v${r1.formula.version})`)
  ok(after1?.description === `Gale Jacket ${p.brand}`, `value layer holds: ${JSON.stringify(after1?.description)}`)
  ok(r1.formula.dependsOn.includes('brand'), `dependsOn = ${JSON.stringify(r1.formula.dependsOn)}`)

  console.log('\n--- (G) an ERRORED formula clears the stored value ---')
  const r2 = await setCellFormula({ ...coord, expr: '1 / 0', updatedBy: 'pes6-e2e' })
  const after2 = await prisma.product.findUnique({ where: { id: p.id }, select: { description: true } })
  ok(r2.error !== null, `error reported: ${String(r2.error).slice(0, 60)}`)
  ok(after2?.description === null, `value CLEARED (is ${JSON.stringify(after2?.description)}) — not left stale`)

  console.log('\n--- the cascade: a second formula that reads the first field re-evaluates ---')
  await setCellFormula({ ...coord, expr: '"Gale Jacket " + $brand', updatedBy: 'pes6-e2e' })
  const r3 = await setCellFormula({
    productId: p.id, scope: 'master', fieldKey: 'name',
    expr: 'upper($description)', updatedBy: 'pes6-e2e',
  })
  ok(r3.error === null, `name formula stored, value=${JSON.stringify(r3.value)}`)
  const r4 = await setCellFormula({ ...coord, expr: '"Changed " + $brand', updatedBy: 'pes6-e2e' })
  const after4 = await prisma.product.findUnique({ where: { id: p.id }, select: { name: true, description: true } })
  ok(r4.cascaded.some((c) => c.fieldKey === 'name'), `cascade touched: ${r4.cascaded.map((c) => c.fieldKey).join(', ') || '(none)'}`)
  ok(after4?.name === `CHANGED ${String(p.brand).toUpperCase()}`, `dependent re-evaluated: ${JSON.stringify(after4?.name)}`)

  console.log('\n--- (F) pin a literal → audit row, formula gone, value stays, restorable ---')
  const pinned = await pinOverFormula({ ...coord, userId: 'pes6-e2e' })
  const audit = await prisma.auditLog.findFirst({
    where: { entityId: p.id, action: FORMULA_PINNED_ACTION }, orderBy: { createdAt: 'desc' },
  })
  const afterPin = await prisma.product.findUnique({ where: { id: p.id }, select: { description: true } })
  ok(pinned.pinned && !!audit, `audit row written (action=${audit?.action})`)
  ok((await listCellFormulas(p.id)).every((f) => f.fieldKey !== 'description'), 'formula row deleted')
  ok(afterPin?.description === `Changed ${p.brand}`, `value KEPT: ${JSON.stringify(afterPin?.description)}`)

  const restored = await restoreCellFormula({ auditLogId: audit!.id, userId: 'pes6-e2e' })
  ok(restored.formula.expr === '"Changed " + $brand', `restored from audit: ${restored.formula.expr}`)
} finally {
  console.log('\n--- cleanup ---')
  // 🔴 ORDER MATTERS. `AuditLog` is immutable by DB trigger (`audit_log_no_delete`: "application
  // code may not DELETE this table; use the retention cron with session_replication_role=replica").
  // The first version of this block deleted the audit rows BEFORE restoring the product, so the
  // throw aborted the restore and left a real prod product carrying "CHANGED XAVIA". Restore the
  // data FIRST, and never let an un-undoable step gate an undoable one.
  await prisma.product.update({ where: { id: p.id }, data: ORIGINAL })
  await prisma.cellFormula.deleteMany({ where: { productId: p.id } })
  // Audit rows are PERMANENT by design — they record writes that really happened. Not an error.
  console.log('  note: formula.pinned audit rows are immutable and remain, by design')
  const back = await prisma.product.findUnique({ where: { id: p.id }, select: { name: true, description: true } })
  ok(back?.name === ORIGINAL.name && back?.description === ORIGINAL.description, 'product restored exactly')
  ok((await prisma.cellFormula.count({ where: { productId: p.id } })) === 0, 'no formula rows left')
  await prisma.$disconnect()
}
process.exit(0)
