/**
 * VT.F item A11 — delete `VX-TEST-3AX` (parent + 4 children + every dependent row) on the LOCAL database,
 * with a read-back proving 0 rows remain.
 *
 * LOCAL ONLY: `current_database()` is queried and anything but `nexus_development` is refused before a single
 * DELETE. `reference_clean_up_by_value_not_by_row` — the family is addressed by its SKU prefix and its parent
 * id, and the read-back counts by BOTH, so a row missed by one is caught by the other.
 */
import { open } from './_vtf-db.mjs'
const c = await open()
const q = async (s, p) => (await c.query(s, p)).rows
const db = (await q('SELECT current_database() AS n'))[0].n
if (db !== 'nexus_development') { console.error(`🔴 REFUSING: connected to "${db}", not nexus_development`); process.exit(1) }
console.log(`current_database: ${db} · Product rows (positive control): ${(await q('SELECT count(*)::int n FROM "Product"'))[0].n}`)
console.log(`GALE-JACKET version (must be untouched): ${(await q(`SELECT version FROM "Product" WHERE sku='GALE-JACKET'`))[0]?.version}`)

const ids = (await q(`SELECT id, sku FROM "Product" WHERE sku LIKE 'VX-TEST-3AX%' ORDER BY sku`))
console.log(`\nBEFORE — ${ids.length} Product rows: ${ids.map((r) => `${r.sku}(${r.id})`).join(' ')}`)
if (ids.length === 0) { console.log('nothing to delete'); await c.end(); process.exit(0) }
const pids = ids.map((r) => r.id)

/** Every table that references these products, derived from the CATALOGUE rather than from memory. */
const refs = await q(`
  SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
   WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='Product' AND ccu.column_name='id'
   ORDER BY tc.table_name`)
console.log(`\nFOREIGN KEYS pointing at Product.id (${refs.length}):`)
for (const r of refs) console.log(`   ${r.table_name}.${r.column_name}`)

const counts = {}
for (const r of refs) {
  const n = (await q(`SELECT count(*)::int n FROM "${r.table_name}" WHERE "${r.column_name}" = ANY($1::text[])`, [pids]))[0].n
  if (n > 0) counts[`${r.table_name}.${r.column_name}`] = n
}
console.log(`\nDEPENDENT ROWS before: ${JSON.stringify(counts)}`)

if (process.argv[2] !== '--delete') { console.log('\n(dry run — pass --delete to execute)'); await c.end(); process.exit(0) }

await q('BEGIN')
let removed = 0
for (const r of refs) {
  const res = await c.query(`DELETE FROM "${r.table_name}" WHERE "${r.column_name}" = ANY($1::text[])`, [pids])
  if (res.rowCount) { console.log(`   deleted ${res.rowCount} from ${r.table_name}.${r.column_name}`); removed += res.rowCount }
}
/* Children first, then the parent — `parentId` is one of the FKs above, so the children may already be gone. */
const kids = await c.query(`DELETE FROM "Product" WHERE "parentId" = ANY($1::text[])`, [pids])
const parent = await c.query(`DELETE FROM "Product" WHERE sku LIKE 'VX-TEST-3AX%'`)
console.log(`   deleted ${kids.rowCount} child Product + ${parent.rowCount} Product row(s)`)
await q('COMMIT')

console.log('\nREAD-BACK — both addresses, so a row missed by one is caught by the other:')
console.log(`   Product WHERE sku LIKE 'VX-TEST-3AX%'  → ${(await q(`SELECT count(*)::int n FROM "Product" WHERE sku LIKE 'VX-TEST-3AX%'`))[0].n} rows`)
console.log(`   Product WHERE id = ANY(<the 5 ids>)     → ${(await q(`SELECT count(*)::int n FROM "Product" WHERE id = ANY($1::text[])`, [pids]))[0].n} rows`)
let left = 0
for (const r of refs) {
  const n = (await q(`SELECT count(*)::int n FROM "${r.table_name}" WHERE "${r.column_name}" = ANY($1::text[])`, [pids]))[0].n
  if (n > 0) { console.log(`   🔴 ${r.table_name}.${r.column_name} → ${n} rows SURVIVED`); left += n }
}
console.log(`   dependent rows left across ${refs.length} foreign keys → ${left}`)
console.log(`\nPOSITIVE CONTROL — the catalogue is otherwise intact: Product rows ${(await q('SELECT count(*)::int n FROM "Product"'))[0].n}, GALE-JACKET version ${(await q(`SELECT version FROM "Product" WHERE sku='GALE-JACKET'`))[0]?.version}`)
await c.end()
