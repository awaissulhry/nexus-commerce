import type { FastifyRequest } from 'fastify'
import type { ApprovalDecision, ApprovalKind, ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { PARTNERS_APPROVALS_VIEW } from '@nexus/factory-domain/approvals-out/permissions'
import { answerWords, decideForPartyProblems, decideForRefusal, reverseProblems, reverseRefusal, typedNameOf } from '@nexus/factory-domain/approvals-out/rules'
import { APPROVALS_DECIDE } from '@nexus/factory-domain/approvals/permissions'
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { userAgentOf } from '@nexus/factory-domain/links/evidence'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { OVERRIDE_TASK_KIND, overrideChanges, overridePlan, SECOND_PERSON_WORDS, type OverrideOrder, type ReverseEffect } from '@nexus/factory-domain/production-brand/override'
import { PRODUCTION_BRAND_OVERRIDE } from '@nexus/factory-domain/production-brand/permissions'
import type { FactoryClient } from '@nexus/factory-db'
import { clientAddressOf } from '../../core/client-address'
import { command, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../core/context'
import { askApproval } from '../approvals/engine'
import { decidersOf } from '../approvals/store'
import { databaseRefusal } from '../approvals/tasks'
import { requireStepUp } from '../auth/office/account'
import { officeAuthOf } from '../auth/sessions/office-auth'
import type { RecordAdapter } from './adapter'
import { pendingOverrideOf, viewAfterOverride } from './office'
import { decideForPartyInCommand, fail, refuse, reverseCheckOf, reverseInCommand, type DecideForOrder } from './override-acts'
import { adapterOf } from './records'
import { readOfficeRow, refOf, type OfficeRow } from './store'

/**
 * Decide for the customer, and put its answer back (B-PR-30a, B-PR-30b; production plan §3 "Decide for a brand, undo —
 * production.brand.override, step-up; a second person when the brand's switch is on", "No silent decisions … Undo is refused in
 * words when the effect cannot be undone (for example a PP approval after cutting). Not for concessions, revised orders,
 * signatures, proofs."; 08-backend §4.6; lead pick L6; review fixes R-06, R-36; the Owner rule 2026-11-16: "One brand must not be
 * able to see anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it
 * all as well."):
 *
 *   POST /approvals-out/:requestId/decide-for-party {version, decision, answer?, typedName, reason}
 *   POST /approvals-out/:requestId/reverse          {version, reason}
 *        production.brand.override over the request's company AND customer (another customer's request: 404, the words of an
 *        unknown id — the brand wall; a person who sees it without the right: 403), then a fresh step-up (action
 *        production.override), then the refusals in words with their codes (./override-acts.ts), all before anything is written.
 *        With the customer's PortalSettings.overrideFourEyes on, nothing is written on the request: ONE internal BRAND_OVERRIDE
 *        approval is asked (the act on its preview, a role that may override and decide approvals, a fresh step-up for the yes;
 *        never granted by the person who asked for it nor by the person who asked the customer), and the second person's yes
 *        carries it out (platform/approvals/kinds/brand-override.ts). Without it, the act runs at once in this command.
 *   The answer: the request as the office reads it (./office.ts: who decided for the customer, the reversal, the override
 *   waiting), the outcome (DONE, or SECOND_PERSON with its task and words), for a reversal what it did and, when a new date is
 *   asked again, its link ONCE (a customer without a portal answers by it).
 */

type Client = FactoryClient | CommandTx

export interface DecideForBody {
  readonly version: number
  readonly decision: ApprovalDecision
  readonly answer?: string | null | undefined
  readonly typedName: string
  readonly reason: string
}

export interface ReverseBody {
  readonly version: number
  readonly reason: string
}

const NO_RIGHT_WORDS = "Deciding for a customer, or putting its answer back, needs the right to override for customers (a production manager's or an admin's)."
const PENDING_WORDS = 'What we do for the customer on this request waits for a second person already: see it in Home › Approvals.'
const NO_GRANTER_WORDS =
  "This customer needs a second person for what we do for them, and no office role may grant it: give a role the right to override for customers and the right to decide approvals (Admin › Roles), or switch the customer's second person off on its limits card."

/** The request the office person may override for its customer: theirs to reach, or 404 (another customer's) / 403 (no right). */
async function reach(request: FastifyRequest, requestId: string): Promise<{ context: OfficeContext; actor: Actor; row: OfficeRow; adapter: RecordAdapter }> {
  const context = requireContext(request)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const row = isUuid(requestId) ? await request.withClient((client) => readOfficeRow(client, requestId)) : null
  const adapter = row ? adapterOf(row.kind as ApprovalKind, row.recordType) : undefined
  if (!row || !adapter) throw new NotFoundError('Approval request not found.')
  const scope = { companyId: row.companyId, partyId: row.partyId }
  if (!can(actor, PRODUCTION_BRAND_OVERRIDE, scope)) {
    // The brand wall: a request of a customer the person does not reach reads as an unknown id (never "another customer's").
    if (!can(actor, PARTNERS_APPROVALS_VIEW, scope)) throw new NotFoundError('Approval request not found.')
    throw new ForbiddenError(NO_RIGHT_WORDS)
  }
  return { context, actor, row, adapter }
}

/** The customer's second-person switch (its limits card; PortalSettings is the office's, its row id is the party's). */
async function fourEyesOf(client: Client, partyId: string): Promise<boolean> {
  const row = await client.portalSettings.findUnique({ where: { id: partyId }, select: { partyId: true, overrideFourEyes: true } })
  return row !== null && row.partyId === partyId && row.overrideFourEyes
}

/** Before anything: a request already waiting for a second person, or changed since the page read it. */
async function notWaiting(request: FastifyRequest, row: OfficeRow, version: number): Promise<void> {
  if (row.version !== version) throw new ConflictError(`This request changed since you read it (now version ${row.version}). Read it again.`)
  if (await request.withClient((client) => pendingOverrideOf(client, row.id))) refuse({ code: 'PENDING', message: PENDING_WORDS })
}

/**
 * The office role that grants an override when no switched-on approval rule names one: a role holding production.brand.override
 * and approvals.decide (the production manager's and the admin's templates; the Owner's role last), the first with someone other
 * than the people asking who may decide over the request's company; else the first such role (it then waits, "nobody else can
 * approve it yet"); none → null.
 */
async function granterRoleOf(tools: CommandTools, companyId: string, askers: readonly string[]): Promise<string | null> {
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : undefined
  if (!tenantId) return null
  const roles = await tools.tx.role.findMany({ where: { audience: 'OFFICE', permissions: { hasEvery: [PRODUCTION_BRAND_OVERRIDE, APPROVALS_DECIDE] } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, key: true } })
  const ordered = [...roles.filter((role) => role.key !== 'owner'), ...roles.filter((role) => role.key === 'owner')]
  for (const role of ordered) {
    if ((await decidersOf(tools.tx, tenantId, { approverRoleId: role.id, approverUserId: null }, { companyId, siteId: null }, askers, tools.now)).length > 0) return role.id
  }
  return ordered[0]?.id ?? null
}

/** ONE internal BRAND_OVERRIDE approval with the act on its preview, in the route's command; its task's id. */
async function askSecondPerson(tools: CommandTools, row: OfficeRow, askerId: string, order: OverrideOrder): Promise<string> {
  const askers = [askerId, ...(row.createdById ? [row.createdById] : [])]
  const roleId = await granterRoleOf(tools, row.companyId, askers)
  const outcome = await askApproval(tools, { kind: OVERRIDE_TASK_KIND, recordId: row.id, requester: { userId: askerId }, note: order.reason, changes: overrideChanges(order), ...(roleId ? { whenNoRule: { approverRoleId: roleId, requireStepUp: true } } : {}) })
  if (!outcome.asked) throw new DomainError('conflict', NO_GRANTER_WORDS, [{ path: 'refusal/NO_APPROVER', message: NO_GRANTER_WORDS }])
  return outcome.taskId
}

const overrideOf = (outcome: 'DONE' | 'SECOND_PERSON', taskId: string | null) => ({ outcome, taskId, words: outcome === 'SECOND_PERSON' ? SECOND_PERSON_WORDS : null })

// ---- B-PR-30a: decide for the customer ----------------------------------------------------------------------------------------

/** POST /approvals-out/:requestId/decide-for-party. */
export async function decideForParty(request: FastifyRequest, requestId: string, body: DecideForBody, idempotencyKey?: string) {
  const { context, row, adapter } = await reach(request, requestId)
  const auth = officeAuthOf(request.server)
  requireStepUp(auth, request)
  const kind = row.kind as ApprovalKind
  const status = row.status as ApprovalStatus
  const refusal = decideForRefusal({ kind, status, askedById: row.createdById }, context.actorId)
  if (refusal) refuse(refusal, refusal.code === 'OWN_ASK' ? 'forbidden' : 'conflict')
  const problems = decideForPartyProblems({ kind, status, askedById: row.createdById }, { decision: body.decision, answer: body.answer, typedName: body.typedName, reason: body.reason }, context.actorId)
  if (problems.length > 0) throw fail(problems, 'The decision is not complete.')
  await notWaiting(request, row, body.version)
  // The record moved on (a newer revision, decided meanwhile): said in words before anything is asked or written.
  const held = adapter.answerHeld ? await request.withClient((client) => adapter.answerHeld!(client, refOf(row), 'en')) : null
  if (held) refuse({ code: 'HELD', message: held })

  const order: DecideForOrder = { act: 'DECIDE_FOR', decision: body.decision, answer: answerWords(body), typedName: typedNameOf(body), reason: body.reason.trim() }
  const plan = overridePlan('DECIDE_FOR', await request.withClient((client) => fourEyesOf(client, row.partyId)))
  const evidence = { ipHash: auth.secrets.ipHash(clientAddressOf(request)), userAgent: userAgentOf(request.headers['user-agent']) }
  const { result } = await command(request, { name: 'approvalsOut.decideForParty', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    if (plan.outcome === 'SECOND_PERSON') return { outcome: 'SECOND_PERSON' as const, taskId: await askSecondPerson(tools, row, context.actorId, order) }
    await decideForPartyInCommand(tools, { requestId, version: body.version, deciderId: context.actorId, order, evidence, grantedById: null })
    return { outcome: 'DONE' as const, taskId: null }
  }).catch(databaseRefusal)
  return { ...(await viewAfterOverride(request, requestId)), override: overrideOf(result.outcome, result.taskId) }
}

// ---- B-PR-30b: put the customer's answer back -------------------------------------------------------------------------------

/** POST /approvals-out/:requestId/reverse. */
export async function reverseAnswer(request: FastifyRequest, requestId: string, body: ReverseBody, idempotencyKey?: string) {
  const { context, row, adapter } = await reach(request, requestId)
  const auth = officeAuthOf(request.server)
  requireStepUp(auth, request)
  const kind = row.kind as ApprovalKind
  const status = row.status as ApprovalStatus
  const refusal = reverseRefusal({ kind, status, reversedAt: row.reversedAt })
  if (refusal) refuse(refusal)
  const problems = reverseProblems({ kind, status, reversedAt: row.reversedAt }, body.reason)
  if (problems.length > 0) throw fail(problems, 'Say why the answer is put back.')
  await notWaiting(request, row, body.version)
  // What it would do to the record, or why it cannot be put back any more (a cut, a counter carried out, the record keeps it).
  const check = await request.withClient((client) => reverseCheckOf(client, adapter, row))
  if (!check.ok) refuse({ code: check.code, message: check.words.en })

  const order: OverrideOrder = { act: 'REVERSE', reason: body.reason.trim() }
  const plan = overridePlan('REVERSE', await request.withClient((client) => fourEyesOf(client, row.partyId)))
  // A new date asked again: its link's token minted here, outside the command (its URL handed once, never kept in the receipt).
  const askAgain = plan.outcome === 'AT_ONCE' && check.effects.includes('ASK_AGAIN')
  const linkId = newId()
  const token = askAgain ? mintLinkToken({ tenantId: context.tenantId, partyId: row.partyId, linkId }) : null
  const ask = token ? { requestId: newId(), linkId, tokenHash: linkTokenHash(token.value) } : null
  const { result, replayed } = await command(request, { name: 'approvalsOut.reverse', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    if (plan.outcome === 'SECOND_PERSON') return { outcome: 'SECOND_PERSON' as const, taskId: await askSecondPerson(tools, row, context.actorId, order), effects: [] as ReverseEffect[], askedAgain: null }
    const done = await reverseInCommand(tools, { requestId, version: body.version, reverserId: context.actorId, reason: order.reason, grantedById: null, ask })
    return { outcome: 'DONE' as const, taskId: null, effects: [...done.effects], askedAgain: done.askedAgain }
  }).catch(databaseRefusal)
  const asked = result.askedAgain ? { requestId: result.askedAgain, url: !replayed && token && ask?.requestId === result.askedAgain ? auth.link('/l', token.value) : null } : null
  return { ...(await viewAfterOverride(request, requestId)), override: overrideOf(result.outcome, result.taskId), effects: result.effects, asked }
}
