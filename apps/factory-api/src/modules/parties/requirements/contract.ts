import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { REQUIREMENT_KINDS, REQUIREMENT_LIMITS, REQUIREMENT_RECORD_TYPES, REQUIREMENT_STAGES } from '@nexus/factory-domain/parties/requirements/requirements'

/** The requirement routes' contracts (B-W2b-290; SAL-014; modules/parties/requirements). */

const words = output({ en: z.string(), it: z.string() })
export const requirementView = output({
  id: id(),
  companyId: id().nullable(),
  companyCode: z.string().nullable(),
  kind: z.enum(REQUIREMENT_KINDS),
  words: z.string(),
  appliesAt: z.array(z.enum(REQUIREMENT_STAGES)),
  shownOn: words,
  styles: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  everyStyle: z.boolean(),
  file: output({ id: id(), fileName: z.string() }).nullable(),
  supersedesId: id().nullable(),
  active: z.boolean(),
  createdAt: instant(),
  createdBy: z.string().nullable(),
  endedAt: instant().nullable(),
  endedBy: z.string().nullable(),
  endReason: z.string().nullable(),
  version: z.number().int(),
})
const requirementsView = output({ partyId: id(), code: z.string(), inForce: z.array(requirementView), ended: z.array(requirementView) })

const party = input({ partyId: id() })
const one = input({ partyId: id(), requirementId: id() })
const rule = {
  companyId: id().nullable(),
  kind: z.enum(REQUIREMENT_KINDS),
  words: z.string().max(REQUIREMENT_LIMITS.words + 200),
  appliesAt: z.array(z.enum(REQUIREMENT_STAGES)).max(REQUIREMENT_STAGES.length + 2),
  styleIds: z.array(z.string()).max(REQUIREMENT_LIMITS.styles + 1).optional(),
  fileId: id().nullish(),
}

export const getRequirementsContract = defineContract({ params: party, response: { 200: output({ requirements: requirementsView }) } })
export const addRequirementContract = defineContract({ params: party, body: input(rule), response: { 201: output({ requirementId: id(), requirements: requirementsView }) } })
export const replaceRequirementContract = defineContract({
  params: one,
  body: input({ ...rule, version: z.number().int().min(1), reason: z.string().max(REQUIREMENT_LIMITS.endReason + 100).nullish() }),
  response: { 201: output({ requirementId: id(), requirements: requirementsView }) },
})
export const endRequirementContract = defineContract({ params: one, body: input({ version: z.number().int().min(1), reason: z.string().max(REQUIREMENT_LIMITS.endReason + 100) }), response: { 200: output({ requirements: requirementsView }) } })
export const requirementsForRecordContract = defineContract({
  params: input({ recordType: z.enum(REQUIREMENT_RECORD_TYPES as [string, ...string[]]), recordId: id() }),
  response: {
    200: output({
      record: output({ type: z.string(), id: id(), number: z.string(), companyId: id() }),
      party: output({ id: id(), code: z.string(), legalName: z.string() }),
      stages: z.array(output({ stage: z.enum(REQUIREMENT_STAGES), requirements: z.array(requirementView) })),
      count: z.number().int(),
    }),
  },
})
