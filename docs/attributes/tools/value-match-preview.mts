/**
 * P5 — READ-ONLY dry run of `POST /api/pim/value-maps/auto-match` on the private copy.
 * Usage (cwd apps/api): node --import tsx ../../docs/attributes/tools/value-match-preview.mts EBAY IT 177104
 */
const API = new URL('../../../apps/api/src/', import.meta.url).pathname
const url = process.env.DATABASE_URL ?? ''
if (url && !/@127\.0\.0\.1:55439\/nexus_attributes_test$/.test(url)) throw new Error('refusing: not the private copy')
const { default: prisma } = await import(`${API}/db.ts`)
const [{ name }] = await prisma.$queryRawUnsafe<{ name: string }[]>('select current_database()::text as name')
if (name !== 'nexus_attributes_test') throw new Error(`refusing: connected to ${name}`)
const { withWorkspace } = await import(`${API}/lib/workspace-context.ts`)
const { withCachedSchemas } = await import(`${API}/services/pim/cached-schema-context.ts`)
const { autoMatchValueMaps } = await import(`${API}/services/pim/value-map-auto.service.ts`)
const [channel, marketplace, productType] = process.argv.slice(2)
const result = await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] },
  () => withCachedSchemas(() => autoMatchValueMaps({ channel, marketplace, productType, dryRun: true })))
console.log(JSON.stringify({ db: name, channel, marketplace, productType, applied: result.applied, fields: result.fields.map(f => ({
  field: f.fieldKey, attribute: f.attribute, concept: f.concept, valid: f.alreadyValid, mapped: f.alreadyMapped,
  matched: f.matched.length, sample: f.matched.slice(0, 4).map(m => `${m.from}→${m.to} (${m.how})`), unmatched: f.unmatched.length, unmatchedSample: f.unmatched.slice(0, 6),
})) }, null, 1))
await prisma.$disconnect()
process.exit(0)
