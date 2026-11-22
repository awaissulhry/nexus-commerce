import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { askPartner } from '../../admin/users/partners/api'
import { refusalCode } from './state'

/**
 * F-OF-202 / F-OF-203 (order FILES tab W2) — the ask commands of 13-backend.md §2 (B-OF-031; S2 #1881, apps/factory-api modules/sales/
 * file-asks), through the ONE client; every write at the ask's version with the caller's Idempotency-Key (a Retry after a lost answer
 * never asks twice). Each answers `{ ask: { id, version, status }, tasks }`; the band reads the order's files read again after it. "The customer (portal)" is the existing PartnerTask command
 * (POST /partners/:partyId/tasks, UPLOAD_DOCUMENT) — no ask command on it. The pickers read what exists today: the people a task may go
 * to on the order (GET /tasks/assignees), the roles (GET /auth/roles), a site's teams (GET /people/teams) and a work order's steps
 * (GET /production/work-orders/:id); a list the reader may not read hides its kind.
 */

const enc = encodeURIComponent
const asksPath = (orderId: string) => `/sales/orders/${enc(orderId)}/file-asks`
const key = () => globalThis.crypto.randomUUID()
/** The answer is read again from the order's files read (its `asks`): the commands' own answers are not parsed beyond their shape. */
const anyAnswer = z.object({}).passthrough()

export type AskAct = 'reassign' | 'chase' | 'answer' | 'accept' | 'ask-again' | 'cancel'

/** POST /sales/orders/:orderId/file-asks (tasks.manage + threads.post over the order; priced → the price grain; body data → measurements). */
export const makeFileAsk = (api: ApiClient, orderId: string, body: Readonly<Record<string, unknown>>) => api.post(asksPath(orderId), { body, schema: anyAnswer, idempotencyKey: key() })

/** PATCH …/file-asks/:askId { version, words?, dueOn? } (OPEN only). */
export const changeFileAsk = (api: ApiClient, orderId: string, askId: string, body: Readonly<Record<string, unknown>>) => api.request('PATCH', `${asksPath(orderId)}/${enc(askId)}`, { body, schema: anyAnswer, idempotencyKey: key() })

/** POST …/file-asks/:askId/{reassign | chase | answer | accept | ask-again | cancel}. */
export const fileAskAct = (api: ApiClient, orderId: string, askId: string, act: AskAct, body: Readonly<Record<string, unknown>>) => api.post(`${asksPath(orderId)}/${enc(askId)}/${act}`, { body, schema: anyAnswer, idempotencyKey: key() })

/** "The customer (portal)": its portal task "upload a document" on this order (the existing command; partners.tasks.manage). */
export const askCustomerForFile = (api: ApiClient, input: { readonly partyId: string; readonly orderId: string; readonly companyId: string | null; readonly dueOn: string | null }) =>
  askPartner(api, input.partyId, { kind: 'UPLOAD_DOCUMENT', recordType: 'SalesOrder', recordId: input.orderId, dueAt: input.dueOn, ...(input.companyId ? { companyId: input.companyId } : {}) }, key())

/** A refusal as the band reads it: the API's kind, its code (S2 #1881: the issue path `fileAsk/<CODE>`), the server's words. */
export function askError(error: unknown): { readonly kind: string; readonly code: string | null; readonly detail: string | null } | null {
  if (!isApiError(error)) return null
  const issue = error.issues.find((one) => issuePath(one).startsWith('fileAsk/'))
  return { kind: error.kind, code: issue ? issuePath(issue).slice('fileAsk/'.length) : (refusalCode(error) ?? null), detail: issue?.message ?? error.issues.find((one) => one.message)?.message ?? (error.message || null) }
}

// ---- the pickers --------------------------------------------------------------------------------------------------------------------
const named = z.object({ id: z.string(), name: z.string() })

/** GET /tasks/assignees?recordType=SalesOrder&recordId — the office people a task may go to on this order (ACTIVE, reach it, tasks.manage). */
export const readAskPeople = async (api: ApiClient, orderId: string, signal?: AbortSignal) =>
  (await api.get('/tasks/assignees', { query: { recordType: 'SalesOrder', recordId: orderId }, schema: z.object({ people: z.array(named.passthrough()) }), signal })).people.map((person) => ({ id: person.id, name: person.name }))

const roleSchema = z.object({ id: z.string(), name: z.string(), audience: z.string(), archivedAt: z.string().nullable() })
/** GET /auth/roles (roles.view) — the office and the floor roles, not archived. */
export async function readAskRoles(api: ApiClient, signal?: AbortSignal): Promise<{ readonly office: readonly { id: string; name: string }[]; readonly floor: readonly { id: string; name: string }[] }> {
  const roles = (await api.get('/auth/roles', { schema: z.object({ roles: z.array(roleSchema.passthrough()) }), signal })).roles.filter((role) => role.archivedAt === null)
  const of = (audience: string) => roles.filter((role) => role.audience.toLowerCase() === audience).map((role) => ({ id: role.id, name: role.name }))
  return { office: of('office'), floor: of('floor') }
}

/** GET /people/teams?siteId (people.view) — the site's active teams. */
export const readAskTeams = async (api: ApiClient, siteId: string, signal?: AbortSignal) =>
  (await api.get('/people/teams', { query: { siteId }, schema: z.object({ teams: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() }).passthrough()) }), signal })).teams.filter((team) => team.status === 'ACTIVE').map((team) => ({ id: team.id, name: team.name }))

const stepsSchema = z.object({ workOrder: z.object({ spec: z.object({ operations: z.array(z.object({ id: z.string().nullable(), seq: z.number(), name: z.string() }).passthrough()) }).passthrough() }).passthrough() })
/** GET /production/work-orders/:id (workorders.view) — its steps (a step not yet made a row of the work order cannot be asked). */
export const readAskSteps = async (api: ApiClient, workOrderId: string, signal?: AbortSignal) =>
  (await api.get(`/production/work-orders/${enc(workOrderId)}`, { schema: stepsSchema, signal })).workOrder.spec.operations.flatMap((step) => (step.id ? [{ id: step.id, seq: step.seq, name: step.name }] : []))

/** A picker's read refused for this reader's rights: its kind is hidden (never a held door for a right). */
export const notForThisReader = (error: unknown): boolean => isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up')
