/** VT.F — database discriminator + fixture state. Read-only unless a flag says otherwise. */
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
const env = readFileSync(new URL('../apps/api/.env', import.meta.url), 'utf8')
export const LOCAL_URL = env.split('\n').find(l => l.startsWith('DATABASE_URL=')).slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
export async function open() { const c = new Client({ connectionString: LOCAL_URL }); await c.connect(); return c }
if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await open()
  const q = async (s, p) => (await c.query(s, p)).rows
  console.log('current_database:', (await q('SELECT current_database() AS n'))[0].n)
  console.log('Product rows (positive control):', (await q('SELECT count(*)::int AS n FROM "Product"'))[0].n)
  console.log('GALE:', JSON.stringify(await q('SELECT id,sku,version,"productType","variationAxes","variationTheme" FROM "Product" WHERE sku=$1', ['GALE-JACKET'])))
  console.log('VX:', JSON.stringify(await q(`SELECT id,sku,version,"parentId","productType",status FROM "Product" WHERE sku LIKE 'VX-TEST-3AX%' ORDER BY sku`)))
  await c.end()
}
