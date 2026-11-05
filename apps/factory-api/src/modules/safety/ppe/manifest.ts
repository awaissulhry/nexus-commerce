import { defineManifest } from '../../../core/manifest'

/**
 * PPE for workers (B-W2b-134; QHS-259, QHS-260, QHS-261; design plant.ppe, floor.training "Receive PPE"). Office: safety.view
 * reads, safety.ppe.manage keeps the catalogue, safety.ppe.issue records paper receipts, voids and keeps a receipt's PDF;
 * handlers check each record with can() against its company (an item) or the person's company and site (`record`). Floor:
 * floor.work at the tablet's own site (the person receiving signs with their own badge and PIN). The leaver step's link is the
 * HR record's (people.view / people.leavers.manage).
 */
const view = { audiences: ['office'], permission: 'safety.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'safety.ppe.manage', scope: 'record' } as const
const issue = { audiences: ['office'], permission: 'safety.ppe.issue', scope: 'record' } as const
const floor = { audiences: ['floor'], permission: 'floor.work', scope: 'site' } as const

export const manifest = defineManifest({
  'GET /safety/ppe/counts': view,
  'GET /safety/ppe/gaps': view,
  'GET /safety/ppe/kits': view,
  'GET /safety/ppe/items': view,
  'GET /safety/ppe/items/:ppeItemId': view,
  'POST /safety/ppe/items': manage,
  'POST /safety/ppe/items/common': manage,
  'PATCH /safety/ppe/items/:ppeItemId': manage,
  'POST /safety/ppe/items/:ppeItemId/archive': manage,
  'POST /safety/ppe/items/:ppeItemId/restore': manage,
  'GET /safety/ppe/issues': view,
  'POST /safety/ppe/issues': issue,
  'POST /safety/ppe/issues/:issueId/void': issue,
  'GET /safety/ppe/receipts/:receiptId': view,
  'GET /safety/ppe/receipts/:receiptId/pdf': view,
  'POST /safety/ppe/receipts/:receiptId/pdf': issue,
  'GET /safety/ppe/people/:employeeId': view,
  'GET /safety/floor/ppe/items': floor,
  'POST /safety/floor/ppe/person': floor,
  'POST /safety/floor/ppe/receive': floor,
  'GET /people/leavers/:caseId/ppe': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'POST /people/leavers/:caseId/steps/:stepId/ppe-returned': { audiences: ['office'], permission: 'people.leavers.manage', scope: 'record' },
})
