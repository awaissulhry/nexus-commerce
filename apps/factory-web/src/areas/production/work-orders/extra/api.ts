import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * An unplanned operation in the office (B-W2b-82; MES-086; apps/factory-api modules/production/extraops): the work order's list
 * (workorders.view), and what may be added and the add (production.extraops.add). Standard minutes are no money, `pays` is a
 * word; nothing names a person: who added it stays in the audit log, `addedOn` says where.
 */

const REASON_CODES = ['QUALITY_FIX', 'MATERIAL_ISSUE', 'CUSTOMER_CHANGE', 'MISSING_FROM_ROUTING', 'OTHER'] as const
export type ExtraReasonCode = (typeof REASON_CODES)[number]

const operation = z.object({ id: z.string(), code: z.string(), name: z.string(), workCentreKind: z.string(), standardMinutes: z.string() })
const pays = z.enum(['PIECE_RATE', 'OFF_STANDARD', 'NO_PIECE_PAY'])
const record = z.object({ id: z.string(), workOrderOperationId: z.string().nullable(), seq: z.number().nullable(), at: z.string(), operation, reasonCode: z.enum(REASON_CODES), reason: z.string().nullable(), addedOn: z.enum(['FLOOR', 'OFFICE']) })
export type ExtraRecord = z.infer<typeof record>

const listSchema = z.object({ added: z.array(record) })
const choicesSchema = z.object({
  operations: z.array(operation.extend({ pays })),
  reasons: z.array(z.object({ code: z.enum(REASON_CODES), label: z.object({ it: z.string(), en: z.string() }), needsNote: z.boolean() })),
})
export type ExtraChoices = z.infer<typeof choicesSchema>
const addedSchema = record.extend({ pays })
export type ExtraAdded = z.infer<typeof addedSchema>

const base = (workOrderId: string) => `/production/extra-operations/work-orders/${encodeURIComponent(workOrderId)}`

export const getExtras = async (api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<ExtraRecord[]> => (await api.get(base(workOrderId), { schema: listSchema, signal })).added

export const getExtraChoices = (api: ApiClient, workOrderId: string, signal?: AbortSignal): Promise<ExtraChoices> => api.get(`${base(workOrderId)}/choices`, { schema: choicesSchema, signal })

export interface ExtraBody {
  operationId: string
  reasonCode: ExtraReasonCode
  note?: string
}

export const addExtra = (api: ApiClient, workOrderId: string, body: ExtraBody, idempotencyKey: string): Promise<ExtraAdded> => api.post(base(workOrderId), { body, schema: addedSchema, idempotencyKey })
