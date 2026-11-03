import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Corrective actions: CAPA and 8D (B-W2b-108; QHS-087 escalate to CAPA, QHS-093 the CAPA record, QHS-094 the 8D report,
 * QHS-096 actions with reminders and escalation; design quality.capa SCR-146 and the NCR page's ncr-capa), in the quality
 * area. Each is checked with can() against the CAPA's company and, for one written for a customer, that customer (a role
 * limited to some customers sees their 8Ds and the internal CAPAs of its companies). Office only: the floor reads no CAPA.
 *
 *   view     the CAPA list and its tiles, a CAPA with its sources (the NCRs and complaints it came from, each only when
 *            the reader may see that record), the containment pulled live from its NCRs, its actions with their
 *            reminders and escalation, the 8D report (preview and the versions kept). An action's OWNER records it
 *            done with its evidence with view alone (the action is theirs).
 *   manage   quality's follow-up: open a CAPA or an 8D (also by escalating NCRs and complaints to it), change its team,
 *            problem, owner, due day and stage, add and remove sources, add, change, remind and cancel actions, record
 *            any action done, keep a version of the 8D report, close it (once its actions are done) or cancel it.
 *            Escalating an NCR also needs quality.ncr.manage at the NCR's site (the NCR names the CAPA).
 */
export const QUALITY_CAPA_DEFINITIONS = definePermissions('quality', {
  'capa.view': { risk: 'read', description: 'See corrective actions (CAPA and 8D): what they came from, the team and problem, the containment from their NCRs, the actions with their reminders and escalation, and the 8D report; record an action of your own done.' },
  'capa.manage': { risk: 'write', description: 'Open CAPAs and 8Ds (also by escalating NCRs and complaints), change them, add and follow up their actions, keep the 8D report, close them once the actions are done, or cancel them.' },
})

export const QUALITY_CAPA_VIEW = 'quality.capa.view' satisfies Permission
export const QUALITY_CAPA_MANAGE = 'quality.capa.manage' satisfies Permission

export const QUALITY_CAPA_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_CAPA_VIEW, QUALITY_CAPA_MANAGE])
