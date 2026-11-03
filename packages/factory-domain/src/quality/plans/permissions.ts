import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Inspection plans (apps/factory-api modules/quality/plans; B-W2b-92; QHS-008, QHS-009, QHS-016; design quality.plans
 * SCR-077 "Plans", the plan record in Builder page mode, "New plan", "Approve version", the printable checklist), in the
 * quality area. A plan is a company's: each is checked with can() against its company.
 *
 *   view     the plans, their versions with the checks and sampling, who wrote and approved each, which records ran on it,
 *            the comparison of two versions, and a version as a printable checklist (the paper fallback of a bench)
 *   manage   new plans (blank, from the leather-apparel starter set, or a copy), a plan's name, owner and where it applies,
 *            draft versions with their checks and sampling, asking for approval, retiring a version
 *   approve  approving another person's draft version: an e-signature with the office's step-up (a fresh code); never a
 *            version one wrote (QHS-016: a second person approves). The approved version is frozen with its checks.
 */
export const QUALITY_PLANS_DEFINITIONS = definePermissions('quality', {
  'plans.view': {
    risk: 'read',
    description: 'See the inspection plans with their versions, checks, sampling and where they apply, who wrote and approved each version, the records that ran on it, and print a version as a checklist.',
  },
  'plans.manage': {
    risk: 'write',
    description: 'Keep the inspection plans of a company: new plans (blank, from the starter set or a copy), their name, owner and where they apply, draft versions with their checks and sampling, asking for approval and retiring a version.',
  },
  'plans.approve': {
    risk: 'write',
    description: "Approve another person's draft version of an inspection plan with an e-signature (a fresh code): it is frozen with its checks and the version before is retired; never a version one wrote.",
  },
})

export const QUALITY_PLANS_VIEW = 'quality.plans.view' satisfies Permission
export const QUALITY_PLANS_MANAGE = 'quality.plans.manage' satisfies Permission
export const QUALITY_PLANS_APPROVE = 'quality.plans.approve' satisfies Permission

export const QUALITY_PLANS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_PLANS_VIEW, QUALITY_PLANS_MANAGE, QUALITY_PLANS_APPROVE])
