import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { EMPLOYEE_KINDS } from '@nexus/factory-domain/people/employees/rules'
import { LEAVER_LIMITS, LEAVER_REFUSALS, LEAVER_STEP_KINDS, LEAVER_VIEWS } from '@nexus/factory-domain/people/leavers/rules'
import { leaverCaseOut, refOut } from '../employees/contract'

/**
 * Leaver steps (B-W2b-26; MES-214; design people.employees "Leavers in progress", "Start leaver steps"). No figure about
 * a person's work, no pay: the payroll flag is a step, the payroll export (B-W2b-54) reads it.
 */

const version = () => z.number().int().min(1)
const reason = () => z.string().trim().min(1).max(LEAVER_LIMITS.reason)

const personOut = output({ id: id(), name: z.string(), displayName: z.string(), employeeCode: z.string().nullable(), kind: z.enum(EMPLOYEE_KINDS), site: refOut, companyId: id() })

export const leaverOut = leaverCaseOut.extend({ employee: personOut, openSteps: z.number().int() })

export const listLeaversContract = defineContract({
  querystring: input({ view: z.enum(LEAVER_VIEWS).default('open'), siteId: id().optional(), companyId: id().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
  response: { 200: output({ leavers: z.array(leaverOut), today: z.string() }) },
})

export const leaverRecordContract = defineContract({
  params: input({ caseId: id() }),
  response: { 200: output({ leaver: leaverOut, canManage: z.boolean(), today: z.string() }) },
})

const plannedStepOut = output({ kind: z.enum(LEAVER_STEP_KINDS), seq: z.number().int(), automatic: z.boolean(), dueOn: z.string().nullable() })

export const leavingPreviewContract = defineContract({
  params: input({ employeeId: id() }),
  querystring: input({
    lastWorkingDay: businessDate(),
    exitVisit: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    ppeReturn: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  }),
  response: {
    200: output({
      steps: z.array(plannedStepOut),
      /** What leaving means for this person (design "Consequences listed"). */
      consequences: output({
        floorSignIns: z.number().int(),
        activeBadges: z.number().int(),
        officeAccount: z.boolean(),
        openTasks: z.number().int(),
        openMaintenanceJobs: z.number().int(),
        shiftsAfter: z.number().int(),
        loansAfter: z.number().int(),
      }),
      refusal: output({ code: z.enum(LEAVER_REFUSALS), message: z.string() }).nullable(),
    }),
  },
})

export const startLeavingContract = defineContract({
  params: input({ employeeId: id() }),
  body: input({ lastWorkingDay: businessDate(), exitVisit: z.boolean().optional(), ppeReturn: z.boolean().optional() }),
  response: { 200: output({ leaver: leaverOut }), 201: output({ leaver: leaverOut }) },
})

export const stepDoneContract = defineContract({
  params: input({ caseId: id(), stepId: id() }),
  /** Where it was done, when a record shows it (both or neither). */
  body: input({ version: version(), recordType: z.string().trim().min(1).max(64).optional(), recordId: id().optional() }),
  response: { 200: output({ leaver: leaverOut }) },
})

export const stepSkipContract = defineContract({
  params: input({ caseId: id(), stepId: id() }),
  body: input({ version: version(), reason: reason() }),
  response: { 200: output({ leaver: leaverOut }) },
})

export const stepReopenContract = defineContract({
  params: input({ caseId: id(), stepId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ leaver: leaverOut }) },
})

export const cancelLeavingContract = defineContract({
  params: input({ caseId: id() }),
  body: input({ version: version(), reason: reason() }),
  response: { 200: output({ leaver: leaverOut }) },
})

export const checkLeavingContract = defineContract({
  params: input({ caseId: id() }),
  response: { 200: output({ leaver: leaverOut, ticked: z.array(z.enum(LEAVER_STEP_KINDS)), floorSwitchedOff: z.number().int(), closed: z.boolean() }) },
})
