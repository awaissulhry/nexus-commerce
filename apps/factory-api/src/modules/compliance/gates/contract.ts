import { z } from 'zod'
import { COMPLIANCE_GATES, FIX_PLACES, WHO } from '@nexus/factory-domain/compliance/requirements/rules'
import { LINE_STATES } from '@nexus/factory-domain/compliance/gates/gate'
import { OVERRIDE_REASON_MAX, OVERRIDE_REASON_MIN } from '@nexus/factory-domain/compliance/gates/override'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Gate refusals, overrides and the gate's answer (B-W2b-254; PRD-272; design compliance.status › cs-gates, cs-override).
 * Ids, codes, gates, states and words. No price, no cost; a refusal names no person.
 */

const gate = z.enum(COMPLIANCE_GATES)
const person = output({ id: id(), name: z.string() }).nullable()

export const feedContract = defineContract({
  querystring: input({
    days: z.coerce.number().int().min(1).max(90).optional(),
    gate: gate.optional(),
    outcome: z.enum(['REFUSED', 'OVERRIDDEN']).optional(),
    subjectType: z.enum(['WorkOrder', 'Shipment']).optional(),
    subjectId: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  response: {
    200: output({
      events: z.array(
        output({
          id: id(),
          at: instant(),
          gate,
          place: z.string(),
          outcome: z.enum(['REFUSED', 'OVERRIDDEN']),
          subject: output({ type: z.string(), id: id(), number: z.string().nullable(), status: z.string().nullable() }),
          site: output({ id: id(), code: z.string().nullable() }).nullable(),
          style: output({ id: id(), code: z.string().nullable() }).nullable(),
          colourway: z.string().nullable(),
          size: z.string().nullable(),
          marketCode: z.string().nullable(),
          requirement: output({ id: id(), code: z.string(), name: z.string(), legalReference: z.string(), locked: z.boolean(), overrideRoleKeys: z.array(z.string()), overrideMaxDays: z.number().int() }),
          reason: z.string(),
          explanation: z.record(z.string(), z.unknown()),
          /** A refusal: still BLOCKED, CLEARED (the subject passed since), OVERRIDDEN (an override in force); an override row: OVERRIDE. */
          state: z.enum(['BLOCKED', 'CLEARED', 'OVERRIDDEN', 'OVERRIDE']),
          refusedEventId: id().nullable(),
          overrideUntil: instant().nullable(),
          by: person,
          overrides: z.array(output({ id: id(), at: instant(), until: instant().nullable(), reason: z.string(), by: person, inForce: z.boolean() })),
          mayOverride: z.boolean(),
        }),
      ),
      days: z.number().int(),
      asOf: instant(),
    }),
  },
})

export const overrideContract = defineContract({
  params: input({ eventId: id() }),
  body: input({ reason: z.string().trim().min(OVERRIDE_REASON_MIN).max(OVERRIDE_REASON_MAX), until: instant() }),
  response: {
    201: output({
      override: output({ id: id(), refusedEventId: id(), gate, subjectType: z.string(), subjectId: id(), requirementCode: z.string(), until: instant(), reason: z.string() }),
    }),
  },
})

export const checkContract = defineContract({
  querystring: input({ gate, subjectType: z.enum(['WorkOrder', 'Shipment']), subjectId: id() }),
  response: {
    200: output({
      gate,
      allowed: z.boolean(),
      decisions: z.array(
        output({
          style: output({ id: id(), code: z.string() }),
          allowed: z.boolean(),
          refusal: output({ requirementCode: z.string(), target: z.string(), words: z.string() }).nullable(),
          lines: z.array(
            output({
              requirement: output({ id: id().nullable(), code: z.string(), name: z.string(), legalReference: z.string() }),
              check: z.string(),
              target: output({ key: z.string(), label: z.string(), marketCode: z.string().nullable(), destination: z.string().nullable() }),
              state: z.enum(LINE_STATES),
              message: z.string(),
              fix: z.string().nullable(),
              blocks: z.boolean(),
              locked: z.boolean(),
              who: z.enum(WHO),
              fixPlace: z.enum(FIX_PLACES),
              evidence: output({ recordType: z.string(), recordId: id(), label: z.string() }).nullable(),
              override: output({ eventId: id(), until: instant() }).nullable(),
            }),
          ),
        }),
      ),
      asOf: instant(),
    }),
  },
})
