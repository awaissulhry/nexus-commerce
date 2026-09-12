/** Refreshes provider requirements for the reviewed mapping scopes; never publishes listings.
 * Run: node --import tsx docs/audits/2026-09-07-attribute-mapping/refresh-live-schemas.mts
 * Optional args: mapping plan, output receipt. Credentials use the normal API environment.
 */
import { readFile, writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.ts'
import { AmazonService } from '../../../apps/api/src/services/marketplaces/amazon.service.ts'
import { CategorySchemaService } from '../../../apps/api/src/services/categories/schema-sync.service.ts'
const [planPath = new URL('./schema-alignment-plan.json', import.meta.url), output = '/tmp/nexus-live-schema-refresh.json'] = process.argv.slice(2)
const report: any = { checkedAt: new Date().toISOString(), listingWrites: 0, scopes: [] }
try {
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  const service = new CategorySchemaService(prisma, new AmazonService())
  for (const scope of plan.scopes) {
    const query = { channel: scope.channel, marketplace: scope.market, productType: scope.category }
    const previous = await prisma.categorySchema.findFirst({ where: { ...query, isActive: true }, orderBy: { fetchedAt: 'desc' }, select: { schemaVersion: true } })
    const result: any = { ...query, previousVersion: previous?.schemaVersion ?? null }
    try {
      const row = await service.refreshSchema(query)
      const definition = row.schemaDefinition as any
      Object.assign(result, { ok: true, schemaVersion: row.schemaVersion, fetchedAt: row.fetchedAt, expiresAt: row.expiresAt,
        checksumVerified: query.channel === 'AMAZON', fields: Object.keys(definition.properties ?? {}).length || definition.aspects?.length || 0 })
    } catch (error: any) {
      Object.assign(result, { ok: false, error: error?.code ?? error?.name ?? 'request_failed', message: String(error?.message ?? 'Request failed').slice(0, 300) })
    }
    report.scopes.push(result)
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(result))
    await new Promise(resolve => setTimeout(resolve, 600))
  }
  if (report.scopes.some((s: any) => !s.ok)) process.exitCode = 1
} catch (error: any) {
  console.error(error?.code ?? error?.name ?? 'refresh_failed'); process.exitCode = 1
} finally { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) }
