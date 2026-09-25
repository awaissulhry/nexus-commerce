/** Round trip through the product-sheet engine itself: the applied import → catalog-transfer export → read back → compare with what the import wrote. */
import { readFileSync, writeFileSync } from 'node:fs'
const API = '/Users/awais/nexus-commerce/apps/api/src'
const OUT = '/private/tmp/claude-501/-Users-awais-nexus-commerce/860563e3-4083-4cae-95e2-45981fb48a2e/scratchpad/runs/out'
const a = JSON.parse(process.argv[2]) as { id: string; importOut: string; market: string; language: string }
if (!/@127\.0\.0\.1:55439\/nexus_cfi_20260924$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing: not the clone')
const { default: prisma } = await import(`${API}/db.ts`)
const [{ name }] = await prisma.$queryRawUnsafe<{ name: string }[]>('select current_database()::text as name')
if (name !== 'nexus_cfi_20260924') throw new Error('refusing: ' + name)
const { withWorkspace } = await import(`${API}/lib/workspace-context.ts`)
const { exportCatalogTransfer } = await import(`${API}/services/pim/catalog-transfer-export.ts`)
const { readTransferFile } = await import(`${API}/services/pim/catalog-transfer-file.ts`)
const imported = JSON.parse(readFileSync(`${OUT}/${a.importOut}.json`, 'utf8'))
const out: Record<string, unknown> = { args: a }
const sortKeys = (x: any): any => Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys(x[k])])) : typeof x === 'number' ? String(x) : x
const norm = (v: unknown) => JSON.stringify(sortKeys(v))
await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  const skus = [...new Set((imported.rawRows as any[]).map(r => r.sku))]
  for (const effective of [false, true]) {
    const file = await exportCatalogTransfer({ market: a.market, skus, marketplaces: [a.market], layout: 'attributes', effective } as never)
    const fname = file.filename
    writeFileSync(`${OUT}/${a.id}-${effective ? 'effective' : 'editing'}-${fname}`, file.data as Buffer)
    const back = await readTransferFile(file.data as Buffer, fname).catch((e: Error) => ({ rows: [], issues: [{ message: e.message }] }))
    const key = (r: any) => JSON.stringify([r.sku, r.entity === 'Products' ? '' : r.channel, r.entity === 'Products' ? '' : r.marketplace, r.locale ?? '', r.field])
    const exported = new Map((back.rows as any[]).map(r => [key(r), r]))
    const diffs: unknown[] = []
    let equal = 0, missing = 0
    for (const r of imported.rawRows as any[]) {
      // A language field comes back under the market's language (the content writer stores it per language).
      const e = exported.get(key(r)) ?? (!r.locale ? exported.get(key({ ...r, locale: a.language })) : undefined)
      if (!e) { missing++; diffs.push({ kind: 'missing', sku: r.sku, field: r.field, imported: r.value }); continue }
      if (norm(e.value) === norm(r.value)) equal++
      else diffs.push({ kind: 'differs', sku: r.sku, field: r.field, imported: r.value, exported: e.value })
    }
    out[effective ? 'effective' : 'editing'] = { file: fname, contentType: file.contentType, exportRows: back.rows.length, readIssues: back.issues?.length, importedRows: imported.rawRows.length, equal, missing, differs: diffs.length - missing, diffs }
  }
})
writeFileSync(`${OUT}/${a.id}.json`, JSON.stringify(out, null, 1))
const s = (x: any) => x && { exportRows: x.exportRows, importedRows: x.importedRows, equal: x.equal, missing: x.missing, differs: x.differs, readIssues: x.readIssues }
console.log(JSON.stringify({ id: a.id, editing: s(out.editing), effective: s(out.effective) }))
await prisma.$disconnect(); process.exit(0)
