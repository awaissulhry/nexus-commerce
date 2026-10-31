import { defineManifest } from '../../../core/manifest'

/**
 * People › Shifts (B-W2b-32; MES-218, MES-222; design people.shifts): the roster and planned overtime, office routes
 * checked per record with can() against the person's or the request's company and site (`record`). The roster's writes
 * are listed with people.shifts.view to reach them; the handler asks people.shifts.manage, or people.shifts.team for the
 * people of a team the caller leads. The worker's own shifts and overtime asks on the tablet: floor.work at the device's
 * site (`site`), the answer signed with the PIN.
 */
export const manifest = defineManifest({
  'GET /people/shifts/roster': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'POST /people/shifts/roster/cells': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'POST /people/shifts/roster/assign/preview': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'POST /people/shifts/roster/assign': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'POST /people/shifts/roster/copy-week/preview': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'POST /people/shifts/roster/copy-week': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'POST /people/shifts/roster/publish': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'GET /people/overtime-requests': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'GET /people/overtime-requests/:requestId': { audiences: ['office'], permission: 'people.shifts.view', scope: 'record' },
  'POST /people/overtime-requests/check': { audiences: ['office'], permission: 'people.overtime.manage', scope: 'record' },
  'POST /people/overtime-requests': { audiences: ['office'], permission: 'people.overtime.manage', scope: 'record' },
  'PATCH /people/overtime-requests/:requestId': { audiences: ['office'], permission: 'people.overtime.manage', scope: 'record' },
  'POST /people/overtime-requests/:requestId/people': { audiences: ['office'], permission: 'people.overtime.manage', scope: 'record' },
  'POST /people/overtime-requests/:requestId/ask': { audiences: ['office'], permission: 'people.overtime.manage', scope: 'record' },
  'POST /people/overtime-requests/:requestId/answers/:agreementId': { audiences: ['office'], permission: 'people.overtime.manage', scope: 'record' },
  'POST /people/overtime-requests/:requestId/approve': { audiences: ['office'], permission: 'people.overtime.approve', scope: 'record' },
  'POST /people/overtime-requests/:requestId/cancel': { audiences: ['office'], permission: 'people.overtime.manage', scope: 'record' },
  'GET /people/floor/my-shifts': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /people/floor/overtime-asks/:agreementId/answer': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
