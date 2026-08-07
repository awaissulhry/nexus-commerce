/**
 * NAF.WF.2 — seed the three built-in workflow rows (create-if-absent) and
 * print the resulting list. Run against prod via:
 *   cd apps/api && railway run npx tsx scripts/_wf-seed.mts
 * Read-write but idempotent and additive-only.
 */
import { listWorkflows, seedWorkflows } from '../src/services/agent-fleet/workflow-registry.service.js'

const seeded = await seedWorkflows()
console.log(`seeded: ${seeded.created} created`)
for (const w of await listWorkflows()) {
  console.log(
    `${w.key} · ${w.kind} · enabled=${w.enabled} · source=${w.source} · revisions=${w.revisionCount} · seeded=${w.seeded}`,
  )
}
process.exit(0)
