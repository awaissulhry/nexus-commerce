/**
 * P3b S0 (docs/attributes/PLAN.md §10.9) — the attribute-scope baseline, READ ONLY.
 *
 * Per business: the dictionary (attributes, types, concept links, attributes in no family), the families (attributes,
 * products), the keys stored in the shared bag (`Product.categoryAttributes`, products per key, and whether the key is a
 * dictionary attribute), readiness rows by channel and state (and the "No active account" ones), the connected accounts
 * and the switched-on markets. Counts and codes only — no product value, name or account id is printed.
 *
 * One transaction, `SET TRANSACTION READ ONLY`, rolled back at the end: the script cannot write, whatever it is pointed at.
 * It needs a login that sees every business (the owner login); a restricted runtime login sees what RLS lets it see.
 *
 *   DATABASE_URL=postgresql://… node --import tsx apps/api/scripts/attribute-scope-measure.mts [--business <id>]
 */
import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) throw new Error('Set DATABASE_URL.')
const only = process.argv.includes('--business') ? process.argv[process.argv.indexOf('--business') + 1] : null
const target = new URL(url)
const client = new pg.Client({ connectionString: url })
await client.connect()
const q = async <T>(text: string, values: unknown[] = []) => (await client.query(text, values)).rows as T[]

// Control keys the shared bag also holds (`family-sheet-schema.ts` INTERNAL_KEYS) — not attributes.
const CONTROL_KEYS = ['variations', 'ebayClusterParent', 'ebayFileExcluded', 'amazonFileExcluded']

try {
  await client.query('BEGIN')
  await client.query('SET TRANSACTION READ ONLY')
  const [{ transaction_read_only: readOnly }] = await q<{ transaction_read_only: string }>('show transaction_read_only')
  if (readOnly !== 'on') throw new Error('refusing: the transaction is not read-only')
  const [{ db }] = await q<{ db: string }>('select current_database() as db')
  const businesses = await q<{ id: string; name: string }>(`select id, name from "Workspace" ${only ? 'where id = $1' : ''} order by name`, only ? [only] : [])
  const out: Record<string, unknown> = { measuredAt: new Date().toISOString(), host: target.hostname, database: db, readOnly: true, businesses: {} }
  for (const b of businesses) {
    const w = [b.id]
    const attributes = await q<{ code: string; type: string; linked: boolean; families: number }>(
      `select a.code, a.type, a."semanticKey" is not null as linked,
              (select count(*)::int from "FamilyAttribute" fa where fa."attributeId" = a.id) as families
       from "CustomAttribute" a where a."workspaceId" = $1 order by a.code`, w)
    const codes = new Set(attributes.map(a => a.code))
    const families = await q<{ label: string; attributes: number; products: number }>(
      `select f.label,
              (select count(*)::int from "FamilyAttribute" fa where fa."familyId" = f.id) as attributes,
              (select count(*)::int from "Product" p where p."familyId" = f.id and p."deletedAt" is null) as products
       from "ProductFamily" f where f."workspaceId" = $1 order by f.label`, w)
    const storedKeys = await q<{ key: string; products: number }>(
      `select k.key, count(*)::int as products
       from "Product" p, jsonb_each(case when jsonb_typeof(p."categoryAttributes") = 'object' then p."categoryAttributes" else '{}'::jsonb end) k
       where p."workspaceId" = $1 and p."deletedAt" is null and k.value not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb)
       group by k.key order by 2 desc, 1`, w)
    const readiness = await q<{ channel: string | null; state: string; rows: number; noAccount: number }>(
      `select r.channel, r.state, count(*)::int as rows, count(*) filter (where r.note like 'No active account%')::int as "noAccount"
       from "ReadinessIndex" r where r."workspaceId" = $1 group by 1, 2 order by 1 nulls first, 2`, w)
    const accounts = await q<{ channelType: string; managedBy: string; active: number; inactive: number }>(
      `select "channelType", "managedBy", count(*) filter (where "isActive")::int as active, count(*) filter (where not "isActive")::int as inactive
       from "ChannelConnection" where "workspaceId" = $1 group by 1, 2 order by 1, 2`, w)
    const [markets] = await q<{ on: number; total: number }>(
      `select count(*) filter (where "isActive")::int as on, count(*)::int as total from "Marketplace" where "workspaceId" = $1`, w)
    ;(out.businesses as Record<string, unknown>)[b.name] = {
      id: b.id,
      dictionary: {
        attributes: attributes.length,
        byType: attributes.reduce<Record<string, number>>((m, a) => ({ ...m, [a.type]: (m[a.type] ?? 0) + 1 }), {}),
        linkedToConcept: attributes.filter(a => a.linked).length,
        inNoFamily: attributes.filter(a => a.families === 0).map(a => a.code),
      },
      families,
      sharedBag: {
        keys: storedKeys.filter(k => !CONTROL_KEYS.includes(k.key)).map(k => ({ ...k, dictionary: codes.has(k.key) })),
        controlKeys: storedKeys.filter(k => CONTROL_KEYS.includes(k.key)),
      },
      readiness,
      accounts,
      markets,
    }
  }
  console.log(JSON.stringify(out, null, 1))
} finally {
  await client.query('ROLLBACK').catch(() => undefined)
  await client.end()
}
