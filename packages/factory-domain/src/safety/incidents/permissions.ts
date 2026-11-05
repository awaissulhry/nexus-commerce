import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: incidents, near misses and hazards, the INAIL filing deadline and the people involved as protected data
 * (apps/factory-api modules/safety/incidents; B-W2b-125; QHS-265, QHS-268, QHS-270; design plant.incidents SCR-210,
 * floor.incident SCR-230; D.Lgs. 81/2008 art. 18 c.1 r; GDPR art. 9), in the safety area. Checked with can() against the
 * incident's company and site. A tablet reports with floor.work (anyone at the station, as a help call): no floor role
 * holds any of these.
 *
 *   safety.incidents.view     the incident list and record ANONYMISED: what, when, where, severity, the INAIL deadlines
 *                             (state and countdown, never the person, the type or the certificate), actions, photos; "One
 *                             person involved" as a count only
 *   safety.incidents.report   report an incident, a near miss or a hazard from the office (with the people involved: written,
 *                             never read back)
 *   safety.incidents.manage   the safety roles: correct the report, set the severity, mark it seen, actions (made into a
 *                             maintenance job, a measure of the improvement plan or a training session in one step), close,
 *                             reopen, cancel, photos
 *   safety.incidents.people   protected (GDPR art. 9): open the people involved and their injuries and the INAIL filings,
 *                             each opening recorded (who, whose, when); correct the people; keep the INAIL filings (absence,
 *                             certificate, filed with INAIL's protocol number and receipt). A write risk on purpose: the
 *                             read-only role never holds it.
 */
export const SAFETY_INCIDENTS_DEFINITIONS = definePermissions('safety', {
  'incidents.view': {
    risk: 'read',
    description:
      'See the incidents, near misses and hazards anonymised: what happened, when and where, the severity, the open INAIL deadlines with their countdown (never the person or the injury), the actions and the photos; the people involved as a count only.',
  },
  'incidents.report': {
    risk: 'write',
    description: 'Report an incident, a near miss or a hazard from the office, with the people involved (they are written, never shown back).',
  },
  'incidents.manage': {
    risk: 'write',
    description:
      'Keep the incidents: correct the report, set the severity, mark it seen by safety, add actions and make one into a maintenance job, a measure of the improvement plan or a training session in one step, close, reopen or cancel an incident, add photos.',
  },
  'incidents.people': {
    risk: 'write',
    description:
      'Protected data (GDPR art. 9): see the people involved in an incident and their injuries and the INAIL filings, each view recorded with who looked and when; correct the people; record the absence, the medical certificate (it starts the 48-hour clock), the filing on the INAIL portal with its protocol number and receipt, or that no filing is needed.',
  },
})

export const SAFETY_INCIDENTS_VIEW = 'safety.incidents.view' satisfies Permission
export const SAFETY_INCIDENTS_REPORT = 'safety.incidents.report' satisfies Permission
export const SAFETY_INCIDENTS_MANAGE = 'safety.incidents.manage' satisfies Permission
export const SAFETY_INCIDENTS_PEOPLE = 'safety.incidents.people' satisfies Permission

export const SAFETY_INCIDENTS_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_INCIDENTS_VIEW, SAFETY_INCIDENTS_REPORT, SAFETY_INCIDENTS_MANAGE, SAFETY_INCIDENTS_PEOPLE])
