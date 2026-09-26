/**
 * P3 — READ-ONLY preview of `POST /api/attributes/concepts/apply` for one business, on the private copy.
 * Usage (cwd apps/api): node --import tsx ../../docs/attributes/tools/concept-plan.mts [workspaceId]
 */
const API = new URL('../../../apps/api/src/', import.meta.url).pathname
const url = process.env.DATABASE_URL ?? ''
if (url && !/@127\.0\.0\.1:55439\/nexus_attributes_test$/.test(url)) throw new Error('refusing: not the private copy')
const { default: prisma } = await import(`${API}/db.ts`)
const [{ name }] = await prisma.$queryRawUnsafe<{ name: string }[]>('select current_database()::text as name')
if (name !== 'nexus_attributes_test') throw new Error(`refusing: connected to ${name}`)
const { withWorkspace } = await import(`${API}/lib/workspace-context.ts`)
const { conceptDictionaryPlan } = await import(`${API}/services/pim/attribute-concepts.service.ts`)
const workspaceId = process.argv[2] ?? 'nexus_legacy_workspace'
const plan = await withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, conceptDictionaryPlan)
console.log(JSON.stringify({ db: name, workspaceId, counts: plan.counts, entries: plan.entries.filter((e: { action: string }) => e.action !== 'master') }, null, 1))
await prisma.$disconnect()
process.exit(0)
