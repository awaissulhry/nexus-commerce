import { APPROVAL_KINDS, isAnswered, KIND_RULES, type ApprovalKind, type ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { mayDecideForParty, OWN_WORD_KINDS } from '@nexus/factory-domain/approvals-out/rules'
import { parsePreview, type ApprovalField } from '@nexus/factory-domain/approvals/rules'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { OVERRIDE_TASK_KIND, overrideGrantProblem, overrideOrderOf } from '@nexus/factory-domain/production-brand/override'
import { PRODUCTION_BRAND_OVERRIDE } from '@nexus/factory-domain/production-brand/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
import { decideForPartyInCommand } from '../../approvals-out/override-acts'
import { adapterOf } from '../../approvals-out/records'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * BRAND_OVERRIDE (B-PR-38; production plan §3 "Decide for a brand, undo — production.brand.override, step-up; a second person
 * when the brand's switch is on", "No silent decisions"; review fixes R-06, R-36 — the enum value came with B-PR-23's schema
 * wave 4/5; 07-control §6.5 "the internal approvals engine, new kind BRAND_OVERRIDE"; factory-domain production-brand/override
 * overridePlan): a decision the office takes FOR a customer on one of its approval requests (decide for it while open), or the
 * putting back of the customer's answer (reverse once answered), that a SECOND office person grants while the customer's
 * PortalSettings.overrideFourEyes is on. Its subject is the customer's ApprovalRequest; only its module asks
 * (`ask` null: B-PR-30a's POST /approvals-out/:requestId/decide-for-party and B-PR-30b's …/reverse ask it, never the generic
 * route), the engine never lets the asker grant it (engine.ts), and B-PR-30a/b carry the act out on the yes (onApproved) from
 * the act the asker named in the task's preview.
 *
 *   on the yes B-PR-30a: in the second person's own command (its fresh step-up asked by the engine), the act read back from
 *              the preview (factory-domain production-brand/override overrideOrderOf: decide for the customer), never granted by the person who asked the customer either (overrideGrantProblem); then carried
 *              out as the person who asked for it (platform/approvals-out/override-acts.ts: the request re-read under its lock
 *              and every refusal checked again — the record moved on, cut meanwhile: the yes is refused in words and nothing
 *              is written). A no, a withdrawal or a stale request write nothing: nothing was written before the yes.
 *
 *   facts      the approval's kind, whether it is answered (a reversal) or open (a decision for the customer), the record type
 *              it is about, the customer's code — no money, no person
 *   snapshot   the request as it stands: its status, version, answer time and any decision for the customer or reversal — the
 *              customer answering meanwhile, a withdrawal or a reversal makes the task STALE
 *   held       never a concession, a revised order, a signature or a proof (the customer's own word); an open request may be
 *              decided for the customer, an answered one put back once; a withdrawn or expired one neither
 *   the wall   every task is about ONE customer's request: the subject names its party (`partyId`), the history and the task
 *              list read it walled (platform/approvals store customerWall, history/registry); the words name the customer by
 *              its code to our own office only
 */

export const BRAND_OVERRIDE_RECORD = 'ApprovalRequest'

const REQUEST_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  kind: true,
  recordType: true,
  recordId: true,
  status: true,
  version: true,
  answeredAt: true,
  decidedForPartyById: true,
  reversedAt: true,
} as const

/** Why the request takes no override now, in words (null: it may be decided for the customer, or its answer put back). */
function heldOf(request: { readonly kind: ApprovalKind; readonly status: ApprovalStatus; readonly reversedAt: Date | null }): string | null {
  if (!mayDecideForParty(request.kind)) return `A ${KIND_RULES[request.kind].name.en.toLowerCase()} is the customer's own word: nobody decides it for them or puts their answer back.`
  if (request.status === 'OPEN') return null
  if (isAnswered(request.status)) return request.reversedAt === null ? null : 'This answer was put back already.'
  return `This request is ${request.status.toLowerCase()}: there is nothing to decide for the customer.`
}

async function readSubject(client: Reader, requestId: string): Promise<ApprovalSubject | null> {
  const request = await client.approvalRequest.findUnique({ where: { id: requestId }, select: REQUEST_SELECT })
  if (!request) return null
  const kind = request.kind as ApprovalKind
  const status = request.status as ApprovalStatus
  const adapter = adapterOf(kind, request.recordType)
  const [party, record] = await Promise.all([
    client.party.findUnique({ where: { id: request.partyId }, select: { code: true } }),
    adapter ? adapter.read(client, request.recordId, kind, { partyId: request.partyId, now: new Date() }) : Promise.resolve(null),
  ])
  const code = party?.code ?? 'customer'
  const what = `${KIND_RULES[kind].name.en} · ${record?.label.en ?? request.recordType}`
  const answered = isAnswered(status)
  return {
    companyId: request.companyId,
    siteId: null,
    partyId: request.partyId,
    label: `${what} · ${code}`.slice(0, 200),
    summary: (answered ? `${what} (${code}): put the customer's answer back, with a reason they read` : `${what} (${code}): decide it for the customer, with a reason they read`).slice(0, 500),
    facts: { approvalKind: kind, answered, recordType: request.recordType, customerCode: party?.code ?? null },
    snapshot: {
      id: request.id,
      status: request.status,
      version: request.version,
      answeredAt: request.answeredAt ? request.answeredAt.toISOString() : null,
      decidedForParty: request.decidedForPartyById !== null,
      reversedAt: request.reversedAt ? request.reversedAt.toISOString() : null,
    },
    changes: answered ? [{ field: 'reversed', from: false, to: true }] : [{ field: 'status', from: 'OPEN', to: 'DECIDED_FOR_CUSTOMER' }],
    held: heldOf({ kind, status, reversedAt: request.reversedAt }),
  }
}

const DECIDABLE_KINDS = APPROVAL_KINDS.filter((kind) => !(OWN_WORD_KINDS as readonly string[]).includes(kind))

const NO_ACT_WORDS = 'This request names nothing to do for the customer: ask again from the approval request.'

/** B-PR-30a: the yes carries out the act the asker named (decided for the customer). */
async function onApproved(tools: CommandTools, task: TaskRef): Promise<void> {
  const row = await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { preview: true } })
  const order = row ? overrideOrderOf(parsePreview(row.preview).changes) : null
  if (!order || !task.requestedById || !task.decidedById) throw new DomainError('conflict', NO_ACT_WORDS, [{ path: 'refusal/NO_ACT', message: NO_ACT_WORDS }])
  const asked = await tools.tx.approvalRequest.findUnique({ where: { id: task.recordId }, select: { createdById: true } })
  const problem = overrideGrantProblem({ requestedById: task.requestedById, askedById: asked?.createdById ?? null }, task.decidedById)
  if (problem) throw new DomainError('forbidden', problem, [{ path: 'refusal/OWN_ASK', message: problem }])
  if (order.act !== 'DECIDE_FOR') throw new DomainError('conflict', NO_ACT_WORDS, [{ path: 'refusal/NO_ACT', message: NO_ACT_WORDS }])
  await decideForPartyInCommand(tools, { requestId: task.recordId, deciderId: task.requestedById, order, evidence: null, grantedById: task.decidedById })
}

export const BRAND_OVERRIDE_KIND: ApprovalKindDefinition = Object.freeze({
  kind: OVERRIDE_TASK_KIND,
  recordType: BRAND_OVERRIDE_RECORD,
  label: { en: 'Decision for a customer', it: 'Decisione per conto di un cliente' },
  view: PRODUCTION_BRAND_OVERRIDE,
  ask: null,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'approvalKind', label: { en: 'approval kind', it: "tipo di approvazione" }, kind: 'choice', options: DECIDABLE_KINDS.map((kind) => ({ value: kind, label: KIND_RULES[kind].name })) },
    { id: 'answered', label: { en: 'the customer answered (put the answer back)', it: 'il cliente ha risposto (si revoca la risposta)' }, kind: 'yesNo' },
    { id: 'recordType', label: { en: 'record', it: 'documento' }, kind: 'text' },
    { id: 'customerCode', label: { en: 'customer code', it: 'codice cliente' }, kind: 'text' },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    // The customer's request: its answer cannot land between the re-read and the yes.
    await tx.$queryRaw`SELECT 1 FROM "ApprovalRequest" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.approvalRequest.findMany({ where: { kind: { in: [...DECIDABLE_KINDS] }, ...(companyId ? { companyId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  // The request is shown on the record it asks about (a sample round, a swatch, an order …).
  async parent(client: Reader, recordId: string) {
    const request = await client.approvalRequest.findUnique({ where: { id: recordId }, select: { recordType: true, recordId: true } })
    return request ? { type: request.recordType, id: request.recordId } : null
  },
  // B-PR-30a: the act on the second person's yes.
  onApproved,
})
