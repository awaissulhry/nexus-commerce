import { defineManifest } from '../../../core/manifest'

/**
 * The PPE text approvals (B-W2b-288, FU2:01; GATE-PPE-TEXTS; design Compliance › Rules & markets › Templates). Office only.
 * Reading needs the certificate register's view permission in any grant (the handlers keep a person to the approvals of the
 * companies they reach). Recording and withdrawing need compliance.ppeTexts.manage over the approval's company (an approval of
 * every company: over every company; the handlers check it, 403 in words); recording also asks a fresh step-up (403 `stepUp`).
 * The consultant's file only through these routes (platform/files/owned.ts).
 */
const view = { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' } as const
const manage = { audiences: ['office'], permission: 'compliance.ppeTexts.manage', scope: 'tenant' } as const

export const manifest = defineManifest({
  'GET /compliance/ppe-texts': view,
  'POST /compliance/ppe-texts/evidence': manage,
  'POST /compliance/ppe-texts': manage,
  'POST /compliance/ppe-texts/:approvalId/withdraw': manage,
})
