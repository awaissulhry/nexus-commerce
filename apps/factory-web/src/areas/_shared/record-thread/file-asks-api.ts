import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { askPartner } from '../../admin/users/partners/api'
import { refusalCode } from './state'

/**
 * F-OF-202 / F-OF-203 (order FILES tab W2) — the ask commands of 13-backend.md §2 (B-OF-031; S2 #1881, apps/factory-api modules/sales/
 * file-asks), through the ONE client; every write at the ask's version with the caller's Idempotency-Key (a Retry after a lost answer
 * never asks twice). Each answers `{ ask: { id, version, status }, tasks }`; the band reads the order's files read again after it. "The customer (portal)" is the existing PartnerTask command
 * (POST /partners/:partyId/tasks, UPLOAD_DOCUMENT) — no ask command on it. The pickers read ONE walled read of S3 (B-OF-035: the
 * choices over the order); a read the reader may not make hides the kinds it fills.
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

// ---- the pickers: ONE walled read (B-OF-035, S3 #1884) ----------------------------------------------------------------------------
const named = z.object({ id: z.string(), name: z.string() })
const choicesSchema = z.object({
  people: z.array(named),
  officeRoles: z.array(named),
  floorRoles: z.array(named.extend({ siteIds: z.array(z.string()) })),
  teams: z.array(named.extend({ siteId: z.string() })),
  lines: z.array(z.object({ id: z.string(), seq: z.number(), label: z.string() })),
  workOrders: z.array(z.object({ id: z.string(), number: z.string(), siteId: z.string().nullable(), steps: z.array(z.object({ id: z.string(), seq: z.number(), name: z.string() })) })),
  truncated: z.boolean(),
})
export type AskChoicesRead = z.infer<typeof choicesSchema>

/**
 * GET /sales/orders/:orderId/file-asks/choices (tasks.manage + threads.post over the order) — who may be asked and where it may land:
 * the office people a task may go to on the order, the office roles with such a person, the floor roles and the teams of the plants of
 * its work orders (never a floor worker's name, never a count), the lines, the work orders the reader reaches with their steps; `truncated`
 * when a list was cut short. No "sees prices" flag: a priced ask to someone without prices is refused when it is made (the server's words).
 */
export const readAskChoices = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<AskChoicesRead> => api.get(`${asksPath(orderId)}/choices`, { schema: choicesSchema, signal })

/** A picker's read refused for this reader's rights: its kind is hidden (never a held door for a right). */
export const notForThisReader = (error: unknown): boolean => isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up')
