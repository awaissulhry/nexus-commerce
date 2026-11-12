import { z } from 'zod'
import { PPE_TEXT_KINDS, type PpeTextKind } from '@nexus/factory-domain/compliance/ppe-texts/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { downloadLink, presignedSchema } from '../../../../record-panels/api'
import { putToStore, sha256Hex, storeUrl } from '../../../../record-panels/store'

/**
 * The calls of Compliance › Rules & markets › Templates (B-W2b-288, FU2:01; GATE-PPE-TEXTS): the templates of generated PPE texts
 * with their approvals (GET /compliance/ppe-texts), the consultant's file announced and sent (POST /compliance/ppe-texts/evidence,
 * the store), the yes recorded (POST /compliance/ppe-texts: a fresh code) and withdrawn (POST …/:id/withdraw), the file opened
 * (GET /files/:id/download). Zod mirrors of the API's contracts (unknown fields dropped); the API's English is never shown.
 */

const person = z.object({ id: z.string(), name: z.string() }).nullable()
const kind = z.enum(PPE_TEXT_KINDS)

export const approvalSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  templateKind: kind,
  templateKey: z.string(),
  templateVersion: z.number(),
  templateId: z.string(),
  languages: z.array(z.string()),
  checkedBy: z.string(),
  recordedAt: z.string(),
  recordedBy: person,
  evidence: z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), status: z.string() }).nullable(),
  withdrawnAt: z.string().nullable(),
  withdrawnBy: person,
  withdrawReason: z.string().nullable(),
  live: z.boolean(),
  version: z.number(),
  mayWithdraw: z.boolean(),
})
export type Approval = z.infer<typeof approvalSchema>

export const TEMPLATE_STATES = ['APPROVED', 'WITHDRAWN', 'NONE'] as const
export type TemplateState = (typeof TEMPLATE_STATES)[number]

export const templateSchema = z.object({
  templateKind: kind,
  templateKey: z.string(),
  templateVersion: z.number(),
  templateId: z.string(),
  label: z.object({ id: z.string(), code: z.string(), revision: z.number(), name: z.string(), status: z.string(), companyId: z.string().nullable(), languages: z.array(z.string()) }).nullable(),
  state: z.enum(TEMPLATE_STATES),
  liveLanguages: z.array(z.string()),
  approvals: z.number(),
})
export type Template = z.infer<typeof templateSchema>

export const answerSchema = z.object({
  templates: z.array(templateSchema),
  approvals: z.array(approvalSchema),
  mayRecord: z.object({ company: z.boolean(), everyCompany: z.boolean() }),
  asOf: z.string(),
})
export type TemplatesAnswer = z.infer<typeof answerSchema>

/** GET /compliance/ppe-texts (the screen's company decides `mayRecord.company`). */
export const readTemplates = (api: ApiClient, companyId: string | null): Promise<TemplatesAnswer> => api.get('/compliance/ppe-texts', { query: companyId ? { companyId } : {}, schema: answerSchema })

export interface RecordBody {
  readonly companyId: string | null
  readonly templateKind: PpeTextKind
  readonly templateKey: string
  readonly templateVersion: number
  readonly languages: readonly string[]
  readonly checkedBy: string
}

/** The consultant's file announced as a file of the approval to come, then sent to the store: the approval's id and the file's. */
export async function sendEvidence(api: ApiClient, companyId: string | null, file: File): Promise<{ approvalId: string; fileId: string }> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post('/compliance/ppe-texts/evidence', {
    body: { companyId, originalName: file.name || 'consultant-check.pdf', contentType: file.type || 'application/pdf', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: z.object({ approvalId: z.string(), file: z.object({ id: z.string() }), upload: presignedSchema }),
    idempotencyKey: newIdempotencyKey(),
  })
  await putToStore(announced.upload, bytes)
  return { approvalId: announced.approvalId, fileId: announced.file.id }
}

/** POST /compliance/ppe-texts: the yes (a 403 `stepUp` first: the caller's guard asks the code and calls again with the same key). */
export const recordApproval = (api: ApiClient, sent: { approvalId: string; fileId: string }, body: RecordBody, key: string): Promise<Approval> =>
  api.post('/compliance/ppe-texts', { body: { ...sent, ...body }, schema: z.object({ approval: approvalSchema }), idempotencyKey: key }).then((answer) => answer.approval)

/** POST /compliance/ppe-texts/:id/withdraw. */
export const withdrawApproval = (api: ApiClient, approval: Pick<Approval, 'id' | 'version'>, reason: string): Promise<Approval> =>
  api
    .post(`/compliance/ppe-texts/${encodeURIComponent(approval.id)}/withdraw`, { body: { version: approval.version, reason }, schema: z.object({ approval: approvalSchema }), idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.approval)

/** The consultant's file, opened through its 60-second address (files.read). */
export const evidenceAddress = async (api: ApiClient, fileId: string): Promise<string> => storeUrl((await downloadLink(api, fileId)).download.url)
