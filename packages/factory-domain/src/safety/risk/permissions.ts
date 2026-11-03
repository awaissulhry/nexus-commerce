import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: the risk assessment, the DVR (apps/factory-api modules/safety/risk; B-W2b-122; QHS-230, QHS-234; design
 * plant.risk, SCR-209; D.Lgs. 81/2008 artt. 28-29), in the safety area. Reading is safety.view (../organisation/permissions.ts);
 * checked with can() against the assessment's company and site.
 *
 *   safety.risk.manage   keep the risk assessments of a site: add one, set when it is next reviewed, freeze a new version of
 *                        the consultant's PDF (its SHA-256 and the time), withdraw a version still waiting for signatures,
 *                        record a signed paper (with its scan), keep the sealed record of a signed version; the improvement
 *                        plan's measures (add, change, move through their states, cancel). A measure's cost is the cost grain.
 *   safety.risk.sign     sign a version yourself, in the office, for the safety role you hold (the employer, the RSPP, the
 *                        RLS or the occupational doctor), with a fresh code (step-up): a signing act.
 *
 * The measure's owner moves their own measure (started, done, back) with safety.view: the measure is theirs.
 */
export const SAFETY_RISK_DEFINITIONS = definePermissions('safety', {
  'risk.manage': {
    risk: 'write',
    description:
      "Keep the risk assessments (DVR) of a site: add one, set its next review, freeze a new version of the consultant's PDF with its SHA-256 and the time, withdraw a version still waiting for signatures, record a signed paper with its scan, keep the sealed record of a signed version; and the improvement plan: add measures, change their owner, due date, cost (with the cost grain) and status, verify or cancel them.",
  },
  'risk.sign': {
    risk: 'stepUp',
    description:
      'Sign a version of the risk assessment yourself, in the office, for the safety role you hold (employer, RSPP, RLS or occupational doctor), with a fresh code from your authenticator app. Nobody signs a version twice.',
  },
})

export const SAFETY_RISK_MANAGE = 'safety.risk.manage' satisfies Permission
export const SAFETY_RISK_SIGN = 'safety.risk.sign' satisfies Permission

export const SAFETY_RISK_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_RISK_MANAGE, SAFETY_RISK_SIGN])
