import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: the safety organisation and the safety calendar (apps/factory-api modules/safety/organisation and
 * modules/safety/calendar; B-W2b-120; QHS-224, QHS-226, QHS-227; design plant.calendar, SCR-267), in the safety area.
 * Checked with can() against the record's company (and its site, when it has one: a whole-company appointment or
 * deadline has none).
 *
 *   safety.view                  read the safety calendar and the safety organisation: who holds each safety role, the
 *                                appointment letters, the RLS notices to INAIL. Health visits appear as counts only (no
 *                                name: the health register keeps them behind its own gate), never a health value.
 *   safety.organisation.manage   appoint a person or an outside contact to a safety role, record the appointee's signature,
 *                                end a term; record the RLS notice filed on the INAIL portal (a manual send: no API).
 *
 * The calendar's own typed deadlines are safety.calendar.manage (../calendar/permissions.ts).
 */
export const SAFETY_DEFINITIONS = definePermissions('safety', {
  view: {
    risk: 'read',
    description:
      'See the safety calendar (every legal deadline in one place: deadlines typed here, the risk assessment review, training refreshers, health visits as counts, statutory machine checks, INAIL reports, appointments ending, RLS notices) and the safety organisation (who holds each safety role, the appointment letters, the RLS notice to INAIL).',
  },
  'organisation.manage': {
    risk: 'write',
    description:
      "Appoint a person of the company or an outside contact to a safety role (employer, RSPP, ASPP, occupational doctor, RLS or territorial RLS, supervisors, managers, first-aid and fire teams), upload the appointment letter, record the appointee's signature, end a term with the reason, and record the RLS notice filed on the INAIL portal with its reference and receipt.",
  },
})

export const SAFETY_VIEW = 'safety.view' satisfies Permission
export const SAFETY_ORGANISATION_MANAGE = 'safety.organisation.manage' satisfies Permission

export const SAFETY_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_VIEW, SAFETY_ORGANISATION_MANAGE])
