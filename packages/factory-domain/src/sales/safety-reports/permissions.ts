import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Product-safety reports and the accident log (B-W2b-351; SAL-414, SAL-415, SAL-423; GPSR, Reg. (EU) 2023/988 art. 20), in the
 * sales area beside the service cases each report opens. Office only (the public DoC page and the portal send a report through
 * their own doors, OFF until the privacy notice is published: GATE-PRIVACY). Each is checked with can() against the report's
 * company and, when it names one, its customer.
 *
 *   view     the reports list and its tiles, a report (where it came from, the garment, what happened, the SAFETY case it
 *            opened, its PPE register entry, its photos, each opening recorded) and the accident log; never whether someone
 *            was hurt, nor in what words, and the reporter's personal data only with manage
 *   manage   record a report from a call, a visit or a mail (its SAFETY case too: sales.service.manage); mark it seen, assess
 *            and close it; change its facts and its owner; file it in the PPE register (opening an entry: compliance.register.
 *            manage); add photos; erase the reporter's personal data on request
 *   injury   protected data (GDPR art. 9; the product-safety role): whether someone was hurt and in what words, each opening
 *            recorded; record it when the report did not say; erase the words on request. A write risk on purpose: the read-only
 *            role never holds it, and no list, export, mail, search entry or thread carries it
 *   log      keep the accident log: record the accident a report tells of, correct or complete it with a new revision (the
 *            log is append-only), and record when the market surveillance authority was told, by whom, its reference
 */
export const SALES_SAFETY_DEFINITIONS = definePermissions('sales', {
  'safety.view': {
    risk: 'read',
    description:
      'See product-safety reports (where each came from, the garment, what happened, the SAFETY case it opened, its PPE register entry and its photos, each opening recorded) and the accident log; never whether someone was hurt or in what words.',
  },
  'safety.manage': {
    risk: 'write',
    description:
      "Record a product-safety report from a call, a visit or a mail, mark a report seen, assess and close it, change its facts and its owner, file it in the PPE register, add photos and erase the reporter's personal data on request.",
  },
  'safety.injury': {
    risk: 'write',
    description:
      'Protected data (GDPR art. 9): read whether someone was hurt in a product-safety report and in what words (each opening recorded), record it when the report did not say, and erase the words on request; never in a list, an export, a mail or a search.',
  },
  'safety.log': {
    risk: 'write',
    description:
      'Keep the accident log (GPSR art. 20): record the accident a product-safety report tells of, correct or complete it with a new revision, and record when the market surveillance authority was told and its reference.',
  },
})

export const SALES_SAFETY_VIEW = 'sales.safety.view' satisfies Permission
export const SALES_SAFETY_MANAGE = 'sales.safety.manage' satisfies Permission
export const SALES_SAFETY_INJURY = 'sales.safety.injury' satisfies Permission
export const SALES_SAFETY_LOG = 'sales.safety.log' satisfies Permission

export const SALES_SAFETY_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_SAFETY_VIEW, SALES_SAFETY_MANAGE, SALES_SAFETY_INJURY, SALES_SAFETY_LOG])

/**
 * Who holds them (auth/roles/templates; the owner from every(), the read-only role only `view`): quality is the product-safety
 * role (design links.claim "safety reports routed at once" to quality): it reads the injury, keeps the accident log and
 * follows the reports up; sales records a report that reached it by phone or mail and reads them; the production manager
 * reads them (a recall or a change may follow).
 */
export const SALES_SAFETY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [SALES_SAFETY_VIEW, SALES_SAFETY_MANAGE, SALES_SAFETY_INJURY, SALES_SAFETY_LOG],
  sales: [SALES_SAFETY_VIEW, SALES_SAFETY_MANAGE],
  production_manager: [SALES_SAFETY_VIEW],
})
