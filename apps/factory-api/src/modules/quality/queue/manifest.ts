import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * My inspections (B-W2b-106; QHS-068 the inspector queue, QHS-065 scan to start, QHS-062 offline inspections; design
 * floor.mywork "inspector queue", floor.final / floor.incoming "scan", "Works offline"). The office and the site's tablets
 * (their own site only). No permission of its own: the queue unions three kinds of record and shows each kind to whoever
 * may view it (quality.inspections.view, quality.incoming.view, quality.inprocess.view over the record's company and site),
 * so the route asks a signed-in caller and the handlers check every row and record (`record`, as people/attendance's reads).
 * Every write goes through the module that owns the record (B-W2b-97, -98, -99), which checks its own record permission.
 */
export const manifest = defineManifest({
  'GET /quality/queue': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'record' },
  'GET /quality/queue/scan': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'record' },
  'POST /quality/queue/scan': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'record' },
  'POST /quality/queue/record': { audiences: ['floor'], permission: SIGNED_IN, scope: 'record' },
  'GET /quality/queue/offline': { audiences: ['floor'], permission: SIGNED_IN, scope: 'record' },
})
