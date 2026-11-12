import { z } from 'zod'
import { PPE_GATE_STATES, PPE_TEXT_KINDS, PPE_TEXT_LIMITS } from '@nexus/factory-domain/compliance/ppe-texts/rules'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The PPE text approvals (B-W2b-288, FU2:01; GATE-PPE-TEXTS): a PPE consultant's yes to one template of generated PPE texts,
 * per template, version, company and languages, with the consultant's file; withdrawn once with a reason. Codes, languages,
 * the consultant as typed and office people's names. No money.
 */

const person = output({ id: id(), name: z.string() })
const kind = z.enum(PPE_TEXT_KINDS)

export const approvalView = output({
  id: id(),
  /** null: every company of the tenant. */
  companyId: id().nullable(),
  templateKind: kind,
  templateKey: z.string(),
  templateVersion: z.number().int(),
  /** `<key>.<version>`, as a generated text names it. */
  templateId: z.string(),
  languages: z.array(z.string()),
  checkedBy: z.string(),
  recordedAt: instant(),
  recordedBy: person.nullable(),
  evidence: output({ id: id(), originalName: z.string(), contentType: z.string(), status: z.string() }).nullable(),
  withdrawnAt: instant().nullable(),
  withdrawnBy: person.nullable(),
  withdrawReason: z.string().nullable(),
  /** In force (not withdrawn). */
  live: z.boolean(),
  version: z.number().int(),
  /** The reader may withdraw it (compliance.ppeTexts.manage over its company, and it is in force). */
  mayWithdraw: z.boolean(),
})
export type ApprovalView = z.infer<typeof approvalView>

const templateView = output({
  templateKind: kind,
  templateKey: z.string(),
  templateVersion: z.number().int(),
  templateId: z.string(),
  /** A label template's class warnings: the label (null for the generators' templates). */
  label: output({ id: id(), code: z.string(), revision: z.number().int(), name: z.string(), status: z.string(), companyId: id().nullable(), languages: z.array(z.string()) }).nullable(),
  /** APPROVED: an approval in force; WITHDRAWN: only withdrawn ones; NONE: never approved. */
  state: z.enum(['APPROVED', 'WITHDRAWN', 'NONE']),
  /** The languages approvals in force cover (any company). */
  liveLanguages: z.array(z.string()),
  approvals: z.number().int(),
})

export const listContract = defineContract({
  querystring: input({ kind: kind.optional(), q: z.string().trim().min(1).max(80).optional(), companyId: id().optional() }),
  response: {
    200: output({
      templates: z.array(templateView),
      approvals: z.array(approvalView),
      /** The reader may record an approval (for this company or, over every company, for every company). */
      mayRecord: output({ company: z.boolean(), everyCompany: z.boolean() }),
      asOf: instant(),
    }),
  },
})

export const announceContract = defineContract({
  body: input({
    /** null or left out: an approval of every company (its file is every company's too). */
    companyId: id().nullable().optional(),
    originalName: z.string().min(1).max(500),
    /** The consultant's signed check: a PDF (or a scan). */
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, { message: 'Expected the SHA-256 of the content, 64 lower-case hex digits.' }),
  }),
  response: { 201: output({ approvalId: id(), file: fileView, upload: presignedView }) },
})

export const recordContract = defineContract({
  body: input({
    /** The id the announce gave (the file is the approval's). */
    approvalId: id(),
    fileId: id(),
    companyId: id().nullable().optional(),
    templateKind: kind,
    templateKey: z.string().trim().max(PPE_TEXT_LIMITS.key * 2),
    templateVersion: z.number().int(),
    languages: z.array(z.string().max(10)).max(PPE_TEXT_LIMITS.languages * 2),
    checkedBy: z.string().max(PPE_TEXT_LIMITS.checkedBy * 2),
  }),
  response: { 201: output({ approval: approvalView }) },
})

export const withdrawContract = defineContract({
  params: input({ approvalId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().max(PPE_TEXT_LIMITS.reason * 2) }),
  response: { 200: output({ approval: approvalView }) },
})

/** What a generated text's gate says (the declarations and the user information read it: their detail's `gate`). */
export const ppeGateView = output({
  name: z.literal('GATE-PPE-TEXTS'),
  words: z.string(),
  /** True: still a draft (no approval in force covers it). */
  open: z.boolean(),
  state: z.enum(PPE_GATE_STATES),
  /** The approval in force that covers it. */
  approval: output({ id: id(), checkedBy: z.string(), recordedAt: instant(), languages: z.array(z.string()), companyId: id().nullable() }).nullable(),
  /** The languages approvals in force cover for its template and company. */
  languages: z.array(z.string()),
  /** An approval that covered it was withdrawn. */
  withdrawn: z.boolean(),
})
