import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Chains (owb- order workflow, S5 fl4 step 3; design § 0 "chains", P/lines.js chainHead, chainMatrix, chainSteps): a line with
 * its work orders, WIP per size × step and the slowest step. The read serves the office (workorders.view, the base's page row)
 * and the floor (production.scan at its site): one route, both rights, so the handler asks them (`SIGNED_IN`, as the
 * departments' read). "+12" is a scan: production.scan on the floor, through today's REPORT command.
 */
export const manifest = defineManifest({
  'GET /production/chains': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'record' },
  'GET /production/chains/:lineId': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'record' },
  'POST /production/chains/report': { audiences: ['floor'], permission: 'production.scan', scope: 'site' },
})
