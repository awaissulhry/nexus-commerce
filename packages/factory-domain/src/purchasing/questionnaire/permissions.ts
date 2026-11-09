import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The supplier questionnaire (B-W2b-172; SCM-023; design links.onboard, purchasing.suppliers "Links › Supplier
 * questionnaire — Onboarding"; the Forced Labour Regulation (EU) 2024/3015 due diligence). Office only (area
 * `purchasing`); the supplier answers through its SUPPLIER_ONBOARD link (links.open, links.submit: the purpose's grants).
 *
 *   questionnaire.view     see the company's questionnaire versions, the links sent to a supplier and its answers, with
 *                          their documents and the buyer's review. Administrator, buyer, quality inspector.
 *   questionnaire.send     send a supplier the questionnaire by link (mailed, or the address given once). Administrator,
 *                          buyer.
 *   questionnaire.review   accept a supplier's answer (its documents then count, with their expiry) or send questions
 *                          back on the supplier's thread. Administrator, buyer.
 *   questionnaire.manage   make, change and publish the company's questionnaire versions (questions as data; the
 *                          starter set). Administrator, buyer.
 */
export const QUESTIONNAIRE_DEFINITIONS = definePermissions('purchasing', {
  'questionnaire.view': {
    risk: 'read',
    description: "See the company's supplier questionnaire, the links sent to a supplier and its answers, with their documents and the review.",
  },
  'questionnaire.send': {
    risk: 'write',
    description: 'Send a supplier the due-diligence questionnaire by link (by e-mail, or the link given to pass on).',
  },
  'questionnaire.review': {
    risk: 'write',
    description: "Accept a supplier's questionnaire answer (its documents then count, with their expiry), or send questions back on the supplier's thread.",
  },
  'questionnaire.manage': {
    risk: 'write',
    description: "Make, change and publish the company's supplier questionnaire versions (the questions, the code of conduct).",
  },
})

export const QUESTIONNAIRE_VIEW = 'purchasing.questionnaire.view' satisfies Permission
export const QUESTIONNAIRE_SEND = 'purchasing.questionnaire.send' satisfies Permission
export const QUESTIONNAIRE_REVIEW = 'purchasing.questionnaire.review' satisfies Permission
export const QUESTIONNAIRE_MANAGE = 'purchasing.questionnaire.manage' satisfies Permission

export const QUESTIONNAIRE_PERMISSIONS: readonly Permission[] = Object.freeze([QUESTIONNAIRE_VIEW, QUESTIONNAIRE_SEND, QUESTIONNAIRE_REVIEW, QUESTIONNAIRE_MANAGE])


/** Who holds them (auth/roles/templates): the administrator and the buyer all four; the quality inspector reads. */
export const QUESTIONNAIRE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [QUESTIONNAIRE_VIEW, QUESTIONNAIRE_SEND, QUESTIONNAIRE_REVIEW, QUESTIONNAIRE_MANAGE],
  buyer: [QUESTIONNAIRE_VIEW, QUESTIONNAIRE_SEND, QUESTIONNAIRE_REVIEW, QUESTIONNAIRE_MANAGE],
  quality_inspector: [QUESTIONNAIRE_VIEW],
})
