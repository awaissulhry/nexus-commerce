/**
 * NAF.WF.4a — inert prod proof: run the sweep walk over the STORED
 * definition with every charter OFF. Expected: the walk executes (started =
 * skipped = step count), zero AgentRun rows are created (dark charters
 * no-op inside the executor with no row), zero spend. Run via:
 *   cd apps/api && railway run npx tsx scripts/_wf-probe-walk.mts
 */
import prisma from '../src/db.js'
import { runFleet } from '../src/services/agent-fleet/orchestrator.js'
import { getEffectiveDefinition } from '../src/services/agent-fleet/workflow-registry.service.js'

const before = await prisma.agentRun.count()
const eff = await getEffectiveDefinition('fleet-sweep')
console.log(`effective sweep: source=${eff.source} steps=${eff.definition?.steps.length} revisionId=${eff.revisionId ?? 'null'}`)
const result = await runFleet('sweep')
console.log(`walk: started=${result.started} succeeded=${result.succeeded} failed=${result.failed} skipped=${result.skipped} halted=${result.haltedReason ?? 'no'}`)
const after = await prisma.agentRun.count()
console.log(`AgentRun rows created: ${after - before} (expected 0 — dark charters leave no row)`)
process.exit(0)
