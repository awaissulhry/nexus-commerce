#!/usr/bin/env node
/**
 * check-ownership — RULE: every model of the factory's Prisma schema (packages/factory-db/prisma/schema/*.prisma) is
 * classified in packages/factory-db/ownership/<module>.json, the file named after its .prisma file (Commerce hard
 * rule 5, for the factory). An unclassified model gets no grant and no policy, so the runtime roles cannot use it.
 *
 * Each classification is checked too: kind "tenant" (a tenantId column with the standard default, keyColumns.tenant =
 * tenantId) or "platform" (no tenantId; factory_platform listed); only runtime roles, known privileges and existing
 * columns; the floor role scoped by site wherever the table has a site key, the partner role always by party; a role
 * scoped only by keys its scope sets; factory_platform only on platform models. Finally db-kit's policy generator must
 * accept the result. The rules live in packages/factory-db/src/ownership.ts.
 *
 * Run: node scripts/factory/check-ownership.mjs — exit 1 on any problem, one per line.
 */
import { tsImport } from 'tsx/esm/api'

const tools = await tsImport('../../packages/factory-db/src/tools.ts', import.meta.url)
const problems = tools.ownershipProblems()

if (problems.length > 0) {
  console.error(`check-ownership: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
const models = tools.loadSchema()
const files = tools.loadOwnership()
console.log(`check-ownership: ok (${models.length} model(s), each classified once, in ${files.length} ownership file(s))`)
