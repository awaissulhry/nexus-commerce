import { defineManifest } from '../../../core/manifest'

/**
 * Labour records and corrections (B-W2b-45; MES-201 … MES-206). The office (`record`: can() on the line's or the record's
 * company and site, lists filtered with scopeWhere()): production.labour.view reads the queue, its tiles, the line days,
 * one labour record, one dispute and the changes timeline; production.labour.close / reopen close and reopen a line's
 * day; production.labour.answer answers a dispute. One person's daily sheet is opened with production.labour.view AND the
 * People privacy gate (people.figures.view and the site's PERFORMANCE legal gate, checked inside). The floor: the device's
 * own site (`site`): floor.work lets the signed-in worker read their own records and dispute one of them, with the PIN.
 */
export const manifest = defineManifest({
  'GET /production/labour/counts': { audiences: ['office'], permission: 'production.labour.view', scope: 'record' },
  'GET /production/labour/inbox': { audiences: ['office'], permission: 'production.labour.view', scope: 'record' },
  'GET /production/labour/days': { audiences: ['office'], permission: 'production.labour.view', scope: 'record' },
  'GET /production/labour/days/:lineId/:workDate': { audiences: ['office'], permission: 'production.labour.view', scope: 'record' },
  'POST /production/labour/days/:lineId/:workDate/close': { audiences: ['office'], permission: 'production.labour.close', scope: 'record' },
  'POST /production/labour/days/:lineId/:workDate/reopen': { audiences: ['office'], permission: 'production.labour.reopen', scope: 'record' },
  'GET /production/labour/edits': { audiences: ['office'], permission: 'production.labour.view', scope: 'record' },
  'GET /production/labour/records/:scanId': { audiences: ['office'], permission: 'production.labour.view', scope: 'record' },
  'GET /production/labour/disputes/:disputeId': { audiences: ['office'], permission: 'production.labour.view', scope: 'record' },
  'POST /production/labour/disputes/:disputeId/answer': { audiences: ['office'], permission: 'production.labour.answer', scope: 'record' },
  'POST /production/labour/sheets': { audiences: ['office'], permission: 'production.labour.view', scope: 'record' },
  'GET /production/labour/floor/mine': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /production/labour/floor/disputes': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /production/labour/floor/disputes/:disputeId/withdraw': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
