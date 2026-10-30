import type { DefectClass as DbDefectClass, DispositionFollowUp as DbFollowUp, Prisma, StockMoveReason } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import type { DispositionCodeChange } from '@nexus/factory-domain/quality/holds/changes'
import {
  dispositionDraftProblems,
  mergedLabels,
  OUTCOME_RULES,
  outcomeOptions,
  stockActionWords,
  type DefectClass,
  type DispositionDraft,
  type DispositionFollowUp,
  type DispositionMove,
  type DispositionOutcome,
} from '@nexus/factory-domain/quality/defects/rules'
import { missingDispositions } from '@nexus/factory-domain/quality/defects/standard'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertManage, mayManage, officeOf } from './access'
import type { DispositionView } from './contract'

/**
 * The disposition codes (B-W2a-26; QHS-005; design quality.defects df-dispositions): each outcome with the stock move a
 * decision with it posts and the record it opens, whether the goods are inspected again, and when a decision needs a
 * second person's approval (by the NCR's class, or the value of the goods: the cost grain). Tenant-wide, kept with
 * quality.defects.manage over every company; read with quality.defects.view.
 *
 *   GET   /quality/dispositions                     the codes in order, each with its stock action in words and how
 *                                                   often NCR decisions name it; the options of each outcome.
 *   POST  /quality/dispositions                     a new code: its outcome, move and follow-up are fixed from now on.
 *   PATCH /quality/dispositions/:dispositionId      words, icon, colour, re-inspection, the approval rule, order,
 *                                                   active. Never the code, outcome, move or follow-up.
 *   POST  /quality/dispositions/standard            the standard codes the tenant does not have yet.
 *
 * A decision with a code posts its move through ./stock.ts (postDispositionInCommand, for the NCR's decisions).
 */

const COLUMNS = {
  id: true,
  code: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  icon: true,
  colour: true,
  outcome: true,
  stockMoveReason: true,
  followUp: true,
  reinspection: true,
  approvalSeverity: true,
  approvalAmount: true,
  sortOrder: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.DispositionCodeSelect
export type DispositionRow = Prisma.DispositionCodeGetPayload<{ select: typeof COLUMNS }>

const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

const actionOf = (row: DispositionRow) => ({
  outcome: row.outcome as DispositionOutcome,
  stockMoveReason: row.stockMoveReason as DispositionMove | null,
  followUp: row.followUp as DispositionFollowUp | null,
  reinspection: row.reinspection,
})

const viewOf = (row: DispositionRow, usedCount: number): DispositionView => ({
  id: row.id,
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
  ...actionOf(row),
  stockAction: stockActionWords(actionOf(row)),
  approvalSeverity: row.approvalSeverity as DefectClass | null,
  approvalAmount: asMoney('cost', row.approvalAmount),
  sortOrder: row.sortOrder,
  active: row.active,
  usedCount,
  version: row.version,
  createdAt: toUtcIso(row.createdAt),
  updatedAt: toUtcIso(row.updatedAt),
})

const audited = (row: DispositionRow) => ({
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
  outcome: row.outcome,
  stockMoveReason: row.stockMoveReason,
  followUp: row.followUp,
  reinspection: row.reinspection,
  approvalSeverity: row.approvalSeverity,
  approvalAmount: markMoney('cost', row.approvalAmount),
  sortOrder: row.sortOrder,
  active: row.active,
})

const byOrder = (a: DispositionRow, b: DispositionRow): number => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : 1)

async function usage(db: Pick<CommandTx, 'ncrDispositionLine'>): Promise<Map<string, number>> {
  const rows = await db.ncrDispositionLine.groupBy({ by: ['dispositionCodeId'], _count: { _all: true } })
  return new Map(rows.map((row) => [row.dispositionCodeId, row._count._all]))
}

function changed(tools: Pick<CommandTools, 'emit'>, change: DispositionCodeChange, codes: readonly string[]): void {
  if (codes.length > 0) tools.emit({ type: 'quality.dispositions_changed', subject: 'disposition-codes', companyId: null, siteId: null, payload: { change, codes: [...codes] } })
}

const refuse = (problems: Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

/** The code a decision names, as other modules read it (your own client; null when there is no such code). */
export async function dispositionCodeOf(db: Pick<CommandTx, 'dispositionCode'>, id: string): Promise<DispositionRow | null> {
  return isUuid(id) ? db.dispositionCode.findUnique({ where: { id }, select: COLUMNS }) : null
}

// ---- reads ----------------------------------------------------------------------------------------------------------

export async function readDispositions(caller: CommandCaller) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = (await client.dispositionCode.findMany({ select: COLUMNS })).sort(byOrder)
    const used = await usage(client)
    return {
      dispositions: rows.map((row) => viewOf(row, used.get(row.id) ?? 0)),
      outcomes: outcomeOptions(),
      standardMissing: missingDispositions(new Set(rows.map((row) => row.code))).map((code) => code.code),
      canManage: mayManage(context),
    }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------

export interface CreateDispositionBody extends DispositionDraft {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly outcome: DispositionOutcome
}

async function nextOrder(db: Pick<CommandTx, 'dispositionCode'>): Promise<number> {
  const last = await db.dispositionCode.aggregate({ _max: { sortOrder: true } })
  return (last._max.sortOrder ?? -1) + 1
}

/** POST /quality/dispositions. */
export async function createDisposition(caller: CommandCaller, body: CreateDispositionBody, idempotencyKey?: string): Promise<{ disposition: DispositionView }> {
  const context = officeOf(caller)
  assertManage(context)
  const code = body.code.trim().toUpperCase()
  const problems = dispositionDraftProblems({ ...body, code }, true)
  if (problems.length > 0) refuse(problems, 'The disposition code is not valid.')
  const rule = OUTCOME_RULES[body.outcome]
  const stockMoveReason = body.stockMoveReason === undefined ? rule.moves[0]! : body.stockMoveReason
  const followUp = body.followUp === undefined ? rule.followUps[0]! : body.followUp
  const id = newId()
  const { result } = await command(caller, { name: 'quality.createDisposition', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const taken = await tx.dispositionCode.findFirst({ where: { code }, select: { active: true } })
    if (taken) throw new ConflictError(`Code ${code} is taken${taken.active ? '' : ' by an inactive code'}.`)
    const row = await tx.dispositionCode.create({
      data: {
        id,
        code,
        labelIt: body.labelIt.trim(),
        labelEn: body.labelEn.trim(),
        labelI18n: mergedLabels({}, body.labelI18n),
        icon: body.icon ?? null,
        colour: body.colour?.toLowerCase() ?? null,
        outcome: body.outcome,
        stockMoveReason: stockMoveReason as StockMoveReason | null,
        followUp: followUp as DbFollowUp | null,
        reinspection: body.reinspection ?? rule.reinspection,
        approvalSeverity: (body.approvalSeverity ?? null) as DbDefectClass | null,
        approvalAmount: body.approvalAmount ?? null,
        sortOrder: body.sortOrder ?? (await nextOrder(tx)),
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: COLUMNS,
    })
    tools.audit({ recordType: 'DispositionCode', recordId: id, companyId: null, after: audited(row) })
    changed(tools, 'CREATED', [code])
    return { disposition: viewOf(row, 0) }
  })
  return result
}

export interface EditDispositionBody extends Omit<DispositionDraft, 'code' | 'outcome' | 'stockMoveReason' | 'followUp'> {
  readonly version: number
  readonly active?: boolean | undefined
}

/** PATCH /quality/dispositions/:dispositionId. */
export async function editDisposition(caller: CommandCaller, dispositionId: string, body: EditDispositionBody, idempotencyKey?: string): Promise<{ disposition: DispositionView }> {
  const context = officeOf(caller)
  assertManage(context)
  const before = await caller.withClient((client) => dispositionCodeOf(client, dispositionId))
  if (!before) throw new NotFoundError('Disposition code not found.')
  const problems = dispositionDraftProblems(body, false)
  if (before.outcome === 'USE_AS_IS' && body.reinspection === true) problems.push({ path: 'reinspection', message: 'Goods used as they are are not inspected again.' })
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  const { result } = await command(
    caller,
    { name: 'quality.editDisposition', idempotencyKey, input: { dispositionId, ...body }, record: { type: 'DispositionCode', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const current = (await dispositionCodeOf(tx, before.id))!
      const data: Prisma.DispositionCodeUpdateInput = { updatedAt: now }
      if (body.labelIt !== undefined) data.labelIt = body.labelIt.trim()
      if (body.labelEn !== undefined) data.labelEn = body.labelEn.trim()
      if (body.labelI18n !== undefined) data.labelI18n = mergedLabels(wordsOf(current.labelI18n), body.labelI18n)
      if (body.icon !== undefined) data.icon = body.icon
      if (body.colour !== undefined) data.colour = body.colour?.toLowerCase() ?? null
      if (body.reinspection !== undefined) data.reinspection = body.reinspection
      if (body.approvalSeverity !== undefined) data.approvalSeverity = body.approvalSeverity as DbDefectClass | null
      if (body.approvalAmount !== undefined) data.approvalAmount = body.approvalAmount
      if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
      if (body.active !== undefined) data.active = body.active
      const row = await tx.dispositionCode.update({ where: { id: current.id }, data, select: COLUMNS })
      tools.audit({ recordType: 'DispositionCode', recordId: row.id, companyId: null, before: audited(current), after: audited(row) })
      changed(tools, body.active === false && current.active ? 'DEACTIVATED' : body.active === true && !current.active ? 'REACTIVATED' : 'EDITED', [row.code])
      return { disposition: viewOf(row, (await usage(tx)).get(row.id) ?? 0) }
    },
  )
  return result
}

/** POST /quality/dispositions/standard: the standard codes the tenant does not have yet. */
export async function addStandardDispositions(caller: CommandCaller, idempotencyKey?: string): Promise<{ added: string[] }> {
  const context = officeOf(caller)
  assertManage(context)
  const { result } = await command(caller, { name: 'quality.addStandardDispositions', idempotencyKey, input: {} }, async (tools) => {
    const { tx, now } = tools
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.disposition-codes', current_setting('factory.tenant_id', true)), 0))`
    const rows = await tx.dispositionCode.findMany({ select: { code: true, sortOrder: true } })
    let order = Math.max(-1, ...rows.map((row) => row.sortOrder))
    const added: string[] = []
    for (const code of missingDispositions(new Set(rows.map((row) => row.code)))) {
      const id = newId()
      order += 1
      const row = await tx.dispositionCode.create({
        data: {
          id,
          code: code.code,
          labelIt: code.labelIt,
          labelEn: code.labelEn,
          icon: code.icon,
          colour: code.colour,
          outcome: code.outcome,
          stockMoveReason: code.stockMoveReason as StockMoveReason | null,
          followUp: code.followUp as DbFollowUp | null,
          reinspection: code.reinspection,
          approvalSeverity: code.approvalSeverity as DbDefectClass | null,
          approvalAmount: code.approvalAmount,
          sortOrder: order,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
        select: COLUMNS,
      })
      tools.audit({ recordType: 'DispositionCode', recordId: id, companyId: null, after: audited(row) })
      added.push(code.code)
    }
    if (added.length === 0) tools.audit({ recordType: 'Tenant', recordId: context.tenantId, companyId: null, after: { standardDispositions: 'nothing missing' } })
    changed(tools, 'STANDARD_ADDED', added)
    return { added }
  })
  return result
}
