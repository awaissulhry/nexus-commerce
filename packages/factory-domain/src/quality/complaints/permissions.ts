import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Customer complaints (B-W2a-65; SAL-416 the complaint record, QHS-113 intake into quality, QHS-115 severity and the
 * safety escalation; design quality.complaints), in the quality area. Each is checked with can() against the complaint's
 * company and its customer (party), so a role limited to some customers sees and acts on only theirs. Office only: the
 * floor reads no complaint, and the customer's own claims pages and the claim link are W2b.
 *
 *   view         the complaints list and its tiles, the safety banner, a complaint with its triage, its PPE register
 *                entry, its NCRs and repairs (the order's value only with the price grain)
 *   log          log a complaint as the customer made it (sales and customer service: the intake is SAL's): who, what
 *                about (order, shipment, return, style, size, serial or batch), the customer's words, the photos
 *   manage       quality's follow-up: triage (category, severity, owner, answer due), which for a safety complaint alerts
 *                the owner and quality and opens its PPE register entry; edit the facts, start the investigation, mark
 *                it answered, add a complaint to the PPE register, close it with a reason
 *   acknowledge  the owner's acknowledgement of a safety complaint's alert (Reg. (EU) 2016/425 art. 8(4)): the banner stays
 *                until it is given, and a safety complaint closes only after it; the owner's own (no template but the
 *                owner holds it)
 */
export const QUALITY_COMPLAINTS_DEFINITIONS = definePermissions('quality', {
  'complaints.view': { risk: 'read', description: "See customer complaints: the customer's words, what they are about, the triage, the safety alert, the PPE register entry, the NCRs and repairs (the order's value only with the price grain)." },
  'complaints.log': { risk: 'write', description: "Log a customer's complaint as it came in (by phone, e-mail, with a return or in person): the customer, the order, shipment, garment serial or batch, the customer's words and photos." },
  'complaints.manage': { risk: 'write', description: 'Triage complaints (category, severity, owner, answer due; a safety complaint alerts the owner and quality and opens its PPE register entry), change them, start the investigation, mark them answered, add them to the PPE register and close them with a reason.' },
  'complaints.acknowledge': { risk: 'write', description: "Acknowledge a safety complaint's alert as the owner: the safety banner stays until then, and a safety complaint closes only after it (Reg. (EU) 2016/425 art. 8(4))." },
})

export const QUALITY_COMPLAINTS_VIEW = 'quality.complaints.view' satisfies Permission
export const QUALITY_COMPLAINTS_LOG = 'quality.complaints.log' satisfies Permission
export const QUALITY_COMPLAINTS_MANAGE = 'quality.complaints.manage' satisfies Permission
export const QUALITY_COMPLAINTS_ACKNOWLEDGE = 'quality.complaints.acknowledge' satisfies Permission

export const QUALITY_COMPLAINTS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_COMPLAINTS_VIEW, QUALITY_COMPLAINTS_LOG, QUALITY_COMPLAINTS_MANAGE, QUALITY_COMPLAINTS_ACKNOWLEDGE])
