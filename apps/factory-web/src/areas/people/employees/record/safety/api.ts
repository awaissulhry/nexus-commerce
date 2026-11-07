import { z } from 'zod'
import { FITNESS_OUTCOMES, JUDGEMENT_STATES, VISIT_STATES, VISIT_STATUSES, VISIT_TYPES } from '@nexus/factory-domain/safety/health/rules'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * Every read of Employee › Safety (B-W2b-146) on the merged APIs: the person's role sheet (B-W2b-128, people.view), their PPE
 * card (B-W2b-134, safety.view) and their fitness judgement (B-W2b-135, safety.health.view). The health readers are this
 * tab's own (B-W2b-148's page reader takes no person yet): the judgement list is anonymised (ids, days, states — nothing is
 * recorded); its values and the next visit come only from the recorded routes, on the person's Show, and live in the tab's
 * state alone (never a cache, the address, an export or a search index). No money: the PPE card's unit cost is never read.
 */

const seg = (value: string) => encodeURIComponent(value)
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

// ---- the role sheet (people.view) --------------------------------------------------------------------------------------------

const roleSheetSchema = z.object({
  employee: z.object({ id: z.string(), name: z.string(), siteId: z.string(), jobRole: z.string().nullable(), status: z.enum(['ACTIVE', 'LEFT']), version: z.number() }),
  roleSheet: ref.extend({ status: z.string() }).nullable(),
  since: z.string().nullable(),
  asks: z
    .object({
      risks: z.array(z.string()),
      courses: z.array(z.object({ courseId: z.string(), course: z.object({ code: z.string(), name: z.string(), type: z.string() }).nullable(), withinDays: z.number().nullable(), held: z.boolean() })),
      kit: z.array(z.object({ ppeItemId: z.string(), item: z.object({ code: z.string(), name: z.string(), category: z.string() }).nullable(), quantity: z.number(), whenToWear: z.string(), held: z.number() })),
      /** `shown: false`: the reader may not know a person's visit need (GDPR art. 9): the tab says nothing about visits. */
      visits: z.object({ shown: z.boolean(), needed: z.boolean().nullable(), frequencyMonths: z.number().nullable(), needs: z.array(z.string()) }),
    })
    .nullable(),
  law: z.object({ roleSheet: z.string(), kit: z.string(), training: z.string(), surveillance: z.string() }),
  today: z.string(),
})
export type PersonRoleSheet = z.infer<typeof roleSheetSchema>

export const getPersonRoleSheet = (api: ApiClient, employeeId: string) => api.get(`/people/employees/${seg(employeeId)}/role-sheet`, { schema: roleSheetSchema })

// ---- PPE (safety.view) -----------------------------------------------------------------------------------------------------------

const names = z.record(z.string(), z.string()).nullable()
const kitLine = z.object({ ppeItemId: z.string(), item: z.object({ code: z.string(), name: z.string(), nameI18n: names, category: z.string() }), quantity: z.number(), held: z.number(), missing: z.number(), replace: z.number(), whenToWear: z.string() })
const issueLine = z.object({ id: z.string(), issuedAt: z.string(), item: z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names }), size: z.string().nullable(), quantity: z.number(), voided: z.object({ at: z.string() }).nullable() })
const receipt = z.object({
  id: z.string(),
  issuedAt: z.string(),
  method: z.string(),
  state: z.string(),
  scan: z.object({ fileId: z.string(), name: z.string() }).nullable(),
  document: z.object({ fileId: z.string() }).nullable(),
  lines: z.array(issueLine),
})
const ppeCardSchema = z.object({
  employee: z.object({ id: z.string(), name: z.string(), status: z.string() }),
  role: ref.nullable(),
  kit: z.array(kitLine),
  receipts: z.array(receipt),
  canIssue: z.boolean(),
  today: z.string(),
  law: z.object({ issue: z.string(), receipt: z.string() }),
})
export type PpeCard = z.infer<typeof ppeCardSchema>
export type PpeReceipt = PpeCard['receipts'][number]

export const getPpeCard = (api: ApiClient, employeeId: string) => api.get(`/safety/ppe/people/${seg(employeeId)}`, { schema: ppeCardSchema })

// ---- fitness (safety.health.view; every view of a value recorded by the API) -------------------------------------------------------

const judgementRow = z.object({ id: z.string(), judgedOn: z.string(), expiresOn: z.string().nullable(), state: z.enum(JUDGEMENT_STATES), fromVisit: z.boolean(), hasCopy: z.boolean(), version: z.number() })
export type JudgementRow = z.infer<typeof judgementRow>

/** GET /safety/health/judgements?employeeId= — ANONYMISED (ids, days, states); nothing is recorded. */
export const listPersonJudgements = (api: ApiClient, employeeId: string) =>
  api.get('/safety/health/judgements', { query: { employeeId, state: 'current' }, schema: z.object({ today: z.string(), judgements: z.array(judgementRow), more: z.boolean() }) })

const shown = judgementRow.extend({ outcome: z.enum(FITNESS_OUTCOMES), taskLimits: z.string().nullable(), unfitUntil: z.string().nullable() })
export type ShownJudgement = z.infer<typeof shown>

/** POST /safety/health/judgements/show — the values of the rows asked; one OPEN view recorded per row. */
export const showJudgements = (api: ApiClient, judgementIds: readonly string[]) => api.post('/safety/health/judgements/show', { body: { judgementIds: [...judgementIds] }, schema: z.object({ judgements: z.array(shown), recorded: z.boolean() }) })

const visitRow = z.object({ id: z.string(), type: z.enum(VISIT_TYPES), dueOn: z.string(), status: z.enum(VISIT_STATUSES), state: z.enum(VISIT_STATES), booked: z.object({ on: z.string(), place: z.string().nullable() }).nullable() })
export type VisitRow = z.infer<typeof visitRow>

/** POST /safety/health/visits/list {employeeId} — the person's open visits (the next one due); a recorded LIST. */
export const listPersonVisits = (api: ApiClient, employeeId: string) => api.post('/safety/health/visits/list', { body: { employeeId, status: 'open', limit: 10 }, schema: z.object({ today: z.string(), visits: z.array(visitRow), recorded: z.boolean() }) })
