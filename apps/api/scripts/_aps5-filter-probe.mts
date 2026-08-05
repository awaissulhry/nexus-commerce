/** APS.5a — READ-ONLY: do the filters we are about to build actually partition
 *  the advertisable set, or would they only ever return zero? */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

const IT = { deletedAt: null, rollupChannelKeys: { hasSome: ['AMAZON_IT'] } } as any
const roots = { ...IT, parentId: null }

L('══ SCOPE SIZES (what the picker paginates over) ══════════════════')
for (const [label, w] of [['top-level on IT', roots], ['incl. children on IT', IT]] as const) {
  L(`  ${String(label).padEnd(24)} ${await p.productReadCache.count({ where: w })}`)
}

L('\n══ FULFILLMENT — is fulfillmentMethod populated? ═════════════════')
const fm = await p.$queryRawUnsafe(
  `SELECT COALESCE("fulfillmentMethod",'(null)') AS fm, COUNT(*)::int AS n
     FROM "ProductReadCache"
    WHERE "deletedAt" IS NULL AND "rollupChannelKeys" && ARRAY['AMAZON_IT']
    GROUP BY 1 ORDER BY 2 DESC`,
)
for (const r of fm as any[]) L(`  ${String(r.fm).padEnd(10)} ${r.n}`)
const fmRoots = await p.$queryRawUnsafe(
  `SELECT COALESCE("fulfillmentMethod",'(null)') AS fm, COUNT(*)::int AS n
     FROM "ProductReadCache"
    WHERE "deletedAt" IS NULL AND "parentId" IS NULL AND "rollupChannelKeys" && ARRAY['AMAZON_IT']
    GROUP BY 1 ORDER BY 2 DESC`,
)
L('  — top-level only:')
for (const r of fmRoots as any[]) L(`    ${String(r.fm).padEnd(10)} ${r.n}`)

L('\n══ STOCK — would in/low/out actually split the set? ══════════════')
for (const [label, w] of [
  ['in stock  (>0)', { ...roots, totalStock: { gt: 0 } }],
  ['low       (1-5)', { ...roots, totalStock: { gt: 0, lte: 5 } }],
  ['out       (=0)', { ...roots, totalStock: 0 }],
] as const) {
  L(`  ${String(label).padEnd(18)} ${await p.productReadCache.count({ where: w as any })}`)
}
L('  — incl. children:')
for (const [label, w] of [
  ['in stock', { ...IT, totalStock: { gt: 0 } }],
  ['low', { ...IT, totalStock: { gt: 0, lte: 5 } }],
  ['out', { ...IT, totalStock: 0 }],
] as const) {
  L(`    ${String(label).padEnd(16)} ${await p.productReadCache.count({ where: w as any })}`)
}

L('\n══ OTHER AXES worth a control ════════════════════════════════════')
const brands = await p.$queryRawUnsafe(
  `SELECT COALESCE(brand,'(none)') AS b, COUNT(*)::int AS n FROM "ProductReadCache"
    WHERE "deletedAt" IS NULL AND "parentId" IS NULL AND "rollupChannelKeys" && ARRAY['AMAZON_IT']
    GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
)
L('  brand (top-level):')
for (const r of brands as any[]) L(`    ${String(r.b).padEnd(18)} ${r.n}`)
const types = await p.$queryRawUnsafe(
  `SELECT COALESCE("productType",'(none)') AS t, COUNT(*)::int AS n FROM "ProductReadCache"
    WHERE "deletedAt" IS NULL AND "parentId" IS NULL AND "rollupChannelKeys" && ARRAY['AMAZON_IT']
    GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
)
L('  productType (top-level):')
for (const r of types as any[]) L(`    ${String(r.t).padEnd(18)} ${r.n}`)
const st = await p.$queryRawUnsafe(
  `SELECT status, COUNT(*)::int AS n FROM "ProductReadCache"
    WHERE "deletedAt" IS NULL AND "parentId" IS NULL AND "rollupChannelKeys" && ARRAY['AMAZON_IT']
    GROUP BY 1 ORDER BY 2 DESC`,
)
L('  status (top-level):')
for (const r of st as any[]) L(`    ${String(r.status).padEnd(18)} ${r.n}`)

L('\n══ SORT — do the sort keys have usable spread? ═══════════════════')
const spread = await p.$queryRawUnsafe(
  `SELECT MIN("totalStock")::int AS min_stock, MAX("totalStock")::int AS max_stock,
          COUNT(DISTINCT brand)::int AS brands, COUNT(DISTINCT "productType")::int AS types
     FROM "ProductReadCache"
    WHERE "deletedAt" IS NULL AND "parentId" IS NULL AND "rollupChannelKeys" && ARRAY['AMAZON_IT']`,
)
L(`  ${JSON.stringify((spread as any[])[0])}`)

await prisma.$disconnect()
