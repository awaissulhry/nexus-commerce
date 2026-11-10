import { defineManifest } from '../../../core/manifest'

/**
 * Sourcing & claims (B-W2b-264; PRD-380; design compliance.sourcing, SCR-215; Dir. (EU) 2024/825). Office only. Reading the
 * claims register is the compliance read (compliance.certificates.view); keeping it — drafts, replacements, where a claim is
 * used, withdrawals — is compliance.claims.manage; approving a claim is compliance.claims.approve with a fresh code (the
 * handler asks the step-up after every other check). Handlers check each claim with can() against its company (`record`).
 */
const view = { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'compliance.claims.manage', scope: 'record' } as const
const approve = { audiences: ['office'], permission: 'compliance.claims.approve', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /compliance/claims': view,
  'GET /compliance/claims/counts': view,
  'GET /compliance/claims/choices': manage,
  'GET /compliance/claims/:claimId': view,
  'POST /compliance/claims': manage,
  'PATCH /compliance/claims/:claimId': manage,
  'POST /compliance/claims/:claimId/approve': approve,
  'POST /compliance/claims/:claimId/withdraw': manage,
  'POST /compliance/claims/:claimId/uses': manage,
  'POST /compliance/claims/:claimId/uses/:useId/end': manage,
})
