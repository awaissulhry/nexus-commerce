import { z } from 'zod'
import { RUN_PICK_MAX, RUN_STATUSES } from '@nexus/factory-domain/invoicing/runs/runs'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The monthly invoice run (B-W2b-396's API; FIN-068; design finance.invoices pop:monthly-run): the customers whose DDTs of
 * a month take a deferred invoice, a PREVIEW run per company and month (one TD24 draft per customer, each with its checks),
 * picking again, deleting the preview, and "Issue and send n invoices" (invoices.issue + a fresh code). Amounts are the
 * price grain (absent without it). The API's English `words` are dropped: the screen says its own from the codes.
 */

export { RUN_PICK_MAX, RUN_STATUSES }
export type RunStatus = (typeof RUN_STATUSES)[number]

const deadlineSchema = z.object({ docType: z.enum(['TD01', 'TD24']), dueBy: z.string(), daysLeft: z.number(), state: z.enum(['OPEN', 'DUE_SOON', 'LATE']) })
const problemSchema = z.object({ code: z.string(), path: z.string() })

export const candidateSchema = z.object({
  partyId: z.string(),
  code: z.string(),
  legalName: z.string(),
  ddts: z.number(),
  valueAmount: z.number().optional(),
  freightAmount: z.number().optional(),
  drafts: z.array(z.string()),
  deadline: deadlineSchema.nullable(),
  inRunId: z.string().nullable(),
})
export type Candidate = z.infer<typeof candidateSchema>

const candidatesSchema = z.object({ asOf: z.string(), companyId: z.string(), month: z.string(), customers: z.array(candidateSchema) })
export type Candidates = z.infer<typeof candidatesSchema>

export const runSchema = z.object({
  id: z.string(),
  version: z.number(),
  companyId: z.string(),
  month: z.string(),
  status: z.enum(RUN_STATUSES),
  issuedAt: z.string().nullable(),
  createdAt: z.string(),
  customers: z.array(
    z.object({
      partyId: z.string(),
      code: z.string(),
      legalName: z.string(),
      invoice: z
        .object({
          id: z.string(),
          version: z.number(),
          docType: z.string(),
          status: z.string(),
          number: z.string().nullable(),
          currency: z.string(),
          ddts: z.number(),
          netTotal: z.number().optional(),
          grossTotal: z.number().optional(),
          ready: z.boolean(),
          problems: z.array(problemSchema),
        })
        .nullable(),
    }),
  ),
  counts: z.object({ customers: z.number(), drafts: z.number(), ready: z.number(), issued: z.number() }),
  can: z.object({ pick: z.boolean(), issue: z.boolean(), delete: z.boolean() }),
})
export type Run = z.infer<typeof runSchema>
export type RunCustomer = Run['customers'][number]

const runRowSchema = z.object({ id: z.string(), version: z.number(), companyId: z.string(), month: z.string(), status: z.enum(RUN_STATUSES), customers: z.number(), invoices: z.number(), issuedAt: z.string().nullable() })
export type RunRow = z.infer<typeof runRowSchema>

const skippedSchema = z.array(z.object({ partyId: z.string() }))
export type Skipped = z.infer<typeof skippedSchema>

const runPath = (id: string) => `/invoicing/runs/${encodeURIComponent(id)}`

/** The company's runs of a month (invoices.view): a live PREVIEW opens as it is; an ISSUED one is said. */
export async function listRuns(api: ApiClient, companyId: string, month: string, signal?: AbortSignal): Promise<RunRow[]> {
  return (await api.get('/invoicing/runs', { query: { companyId, month }, schema: z.object({ runs: z.array(runRowSchema) }), signal })).runs
}

export function runCandidates(api: ApiClient, companyId: string, month: string, signal?: AbortSignal): Promise<Candidates> {
  return api.get('/invoicing/runs/candidates', { query: { companyId, month }, schema: candidatesSchema, signal })
}

export async function getRun(api: ApiClient, runId: string, signal?: AbortSignal): Promise<Run> {
  return (await api.get(runPath(runId), { schema: z.object({ run: runSchema }), signal })).run
}

/** A PREVIEW: one deferred draft per customer (invoices.manage). */
export function createRun(api: ApiClient, body: { companyId: string; month: string; partyIds: string[] }, idempotencyKey: string): Promise<{ run: Run; skipped: Skipped }> {
  return api.post('/invoicing/runs', { body, schema: z.object({ run: runSchema, skipped: skippedSchema }), idempotencyKey })
}

/** Pick again: the drafts of customers left out stay drafts outside the run. */
export function pickRun(api: ApiClient, run: Pick<Run, 'id' | 'version'>, partyIds: string[], idempotencyKey: string): Promise<{ run: Run; skipped: Skipped; removed: string[] }> {
  return api.request('PUT', `${runPath(run.id)}/customers`, { body: { version: run.version, partyIds }, schema: z.object({ run: runSchema, skipped: skippedSchema, removed: z.array(z.string()) }), idempotencyKey })
}

const issuedSchema = z.object({
  run: runSchema,
  issued: z.array(z.object({ invoiceId: z.string(), number: z.string(), filesPending: z.boolean(), sent: z.boolean(), sendProblem: z.string().nullable() })),
  held: z.array(z.object({ invoiceId: z.string(), partyId: z.string(), problems: z.array(problemSchema) })),
})
export type IssuedRun = z.infer<typeof issuedSchema>

/** Every ready draft issued (and sent to SDI when `send`), each its own command; held drafts let go (invoices.issue + step-up). */
export function issueRun(api: ApiClient, run: Pick<Run, 'id' | 'version'>, send: boolean, idempotencyKey: string): Promise<IssuedRun> {
  return api.post(`${runPath(run.id)}/issue`, { body: { version: run.version, send }, schema: issuedSchema, idempotencyKey })
}

/** Deletes a PREVIEW with nothing issued; its drafts stay drafts. */
export function deleteRun(api: ApiClient, run: Pick<Run, 'id' | 'version'>, idempotencyKey: string): Promise<{ draftsLetGo: number }> {
  return api.request('DELETE', runPath(run.id), { query: { version: run.version }, schema: z.object({ draftsLetGo: z.number() }), idempotencyKey })
}

/** A live event that changes a run or the DDTs it takes. */
export const runTouched = (change: { type: string }): boolean => change.type === 'invoice_run.changed' || change.type.startsWith('invoice.') || change.type.startsWith('ddt.')
