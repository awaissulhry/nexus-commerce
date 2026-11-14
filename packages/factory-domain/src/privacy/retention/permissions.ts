import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Data protection in depth (apps/factory-api platform/privacy/{requests,erasure,retention}; B-W2b-405; PLT-202, PLT-203,
 * PLT-204; GDPR arts. 5(1)(e), 12, 15, 16, 17, 20; design admin.privacy "Data requests", "Retention rules", the confirm
 * "Anonymise …?"). In the privacy area; each is checked with can() against the company of the request or the rule:
 *
 *   requests.view    the data requests of the company: the person, the kind, the 30-day clock, the state, what an erasure
 *                    did and kept. Risk `write` on purpose (as fields.personal.view): the read-only template takes every
 *                    read, and a request names a person
 *   requests.manage  record a request, check the person's identity, extend the clock once with the reason, collect and open
 *                    a person's package (their data and files), refuse or close a request
 *   erase            erase or anonymise a person on their erasure request: always a person's decision with a reason and a
 *                    fresh code (step-up; a fixed LEGAL action, never switched off); legal holds always win
 *   retention.manage the retention rules per record type and their sweeps: add and change a rule, switch it off, sweep it
 *                    now. Shortening a period and switching a rule on (GATE-PRIVACY: the sweep then deletes, anonymises or
 *                    archives instead of only reporting) also ask for a fresh code
 */
export const PRIVACY_DEPTH_DEFINITIONS = definePermissions('privacy', {
  // Risk `write` (as fields.personal.view): the read-only template takes every read, and a data request names a person.
  'requests.view': {
    risk: 'write',
    description: "See the company's data requests: who asked to see, erase or correct their data, when it is due (30 days), its state, and what an erasure erased and kept with why.",
  },
  'requests.manage': {
    risk: 'write',
    description: "Record a person's data request, check their identity, extend its clock once with the reason, collect and open their data package (records and files), refuse or close the request.",
  },
  erase: {
    risk: 'stepUp',
    description: "Erase or anonymise a person on their erasure request (a fresh code and a reason each time): what the law keeps stays, with why, and the decision is logged.",
  },
  'retention.manage': {
    risk: 'write',
    description: 'Keep the retention rules per record type (how long, then delete, anonymise or archive, the legal reason), switch one off and sweep it now; shortening a period or switching a rule on asks for a fresh code.',
  },
})

export const PRIVACY_REQUESTS_VIEW = 'privacy.requests.view' satisfies Permission
export const PRIVACY_REQUESTS_MANAGE = 'privacy.requests.manage' satisfies Permission
export const PRIVACY_ERASE = 'privacy.erase' satisfies Permission
export const PRIVACY_RETENTION_MANAGE = 'privacy.retention.manage' satisfies Permission

export const PRIVACY_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([PRIVACY_REQUESTS_VIEW, PRIVACY_REQUESTS_MANAGE, PRIVACY_ERASE, PRIVACY_RETENTION_MANAGE])

/** The role templates that get them (owner: every()). The administrator keeps the privacy duties (Admin › Privacy & notices). */
export const PRIVACY_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [PRIVACY_REQUESTS_VIEW, PRIVACY_REQUESTS_MANAGE, PRIVACY_ERASE, PRIVACY_RETENTION_MANAGE],
})
