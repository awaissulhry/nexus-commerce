import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDayRange, toUtcIso } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_PPE_ISSUE } from '@nexus/factory-domain/safety/ppe/permissions'
import { lineProblems, paperDateRefusal, PPE_LAW, PPE_LIMITS, PPE_REFUSALS, RECEIPT_STATEMENT, signedLanguageOf, type IssueLineDraft, type StatementLanguage } from '@nexus/factory-domain/safety/ppe/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { actorIdOf, asked, assertMayAt, assertMayWriteAt, officeOf, problemsError, refuse, siteScope } from '../organisation/access'
import { ISSUE_SELECT, lockPerson, receiptRowsOf, receiptViews, RECORD_ISSUE, type IssueRow, type ReceiptView } from './store'

/**
 * Issues and receipts (B-W2b-134; QHS-261; design plant.ppe "Issues and receipts" (art. 18 c.1 d, art. 77 c.4), the pop-ups
 * "Issue PPE" and "Void an issue"), office only, each write one command with an Idempotency-Key:
 *
 *   GET  /safety/ppe/issues                    every item handed over (safety.view; ?companyId&siteId&employeeId&ppeItemId&
 *                                              from&to&view all|notSigned|voided&limit): date, person, item, size, quantity,
 *                                              who handed it over, how it was signed, the receipt (its scan, its PDF), why, the
 *                                              void mark
 *   GET  /safety/ppe/receipts/:receiptId       one receipt (any of its rows' ids) with its lines and how it was signed
 *   POST /safety/ppe/issues                    PPE handed over in the office with the person's paper receipt (safety.ppe.issue):
 *                                              one person who works for the company (ACTIVE), items of their company's
 *                                              catalogue (ACTIVE) in one of their sizes, 1 to 99 each, why; signed on paper
 *                                              now or up to PPE_LIMITS.lateDays ago. The rows are one receipt; the answer
 *                                              names the record its signed scan is uploaded to (generic files routes,
 *                                              record type PpeIssue, the receipt's id): until then it counts as "not signed"
 *   POST /safety/ppe/issues/:issueId/void      a wrong line voided with the reason (a VOID row; once); its receipt stays
 *
 * "Signature: send to the floor tablet" writes nothing here: the person signs on the tablet (floor.training "Receive PPE",
 * ./floor.ts), whose screen prefills their missing kit. An office session never proves a worker's PIN (the floor's own sign-in
 * rules and lockout are the floor's), and the database refuses a badge-and-PIN receipt written by the office.
 * Every issue and void of a person takes the person's advisory lock first (store.ts `lockPerson`).
 */

const ISSUE_WORDS = 'PPE is handed over in the office by a role that records receipts (safety.ppe.issue).'

export interface IssueQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly employeeId?: string | undefined
  readonly ppeItemId?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly view?: 'all' | 'notSigned' | 'voided' | undefined
  readonly limit?: number | undefined
}

/** GET /safety/ppe/issues: one row per line handed over, newest first. */
export async function listIssues(caller: CommandCaller, query: IssueQuery) {
  const context = officeOf(caller)
  const limit = query.limit ?? PPE_LIMITS.list
  const view = query.view ?? 'all'
  return caller.withClient(async (client) => {
    const where: Prisma.PpeIssueWhereInput = {
      AND: [
        siteScope(context, SAFETY_VIEW) as Prisma.PpeIssueWhereInput,
        asked(query, 'strict') as Prisma.PpeIssueWhereInput,
        { kind: 'ISSUE' },
        ...(query.employeeId ? [{ employeeId: query.employeeId }] : []),
        ...(query.ppeItemId ? [{ ppeItemId: query.ppeItemId }] : []),
        ...(query.from ? [{ issuedAt: { gte: businessDayRange(query.from).start } }] : []),
        ...(query.to ? [{ issuedAt: { lt: businessDayRange(query.to).end } }] : []),
        ...(view === 'voided' ? [{ voidedBy: { some: {} } }] : []),
        ...(view === 'notSigned' ? [{ method: 'PAPER' as const, voidedBy: { none: {} } }] : []),
      ],
    }
    const rows = (await client.ppeIssue.findMany({ where, orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }], take: limit + PPE_LIMITS.lines, select: ISSUE_SELECT })) as IssueRow[]
    // The receipts the matching lines belong to, WHOLE (a filter or a page may hold some of a receipt's lines: its id, state,
    // scan and PDF are the whole receipt's); only the matching lines are listed.
    const keys = [...new Map(rows.map((row) => [`${row.siteId}|${row.employeeId}|${row.issuedAt.toISOString()}|${row.method}`, { siteId: row.siteId, employeeId: row.employeeId, issuedAt: row.issuedAt, method: row.method }])).values()]
    const whole = keys.length > 0 ? ((await client.ppeIssue.findMany({ where: { kind: 'ISSUE', OR: keys }, select: ISSUE_SELECT })) as IssueRow[]) : []
    const matching = new Set(rows.map((row) => row.id))
    const receipts = await receiptViews(client, context, whole)
    let lines = receipts.flatMap((receipt) => (view === 'notSigned' && receipt.state !== 'NOT_SIGNED' ? [] : receipt.lines)).filter((line) => matching.has(line.id))
    if (view === 'voided') lines = lines.filter((line) => line.voided !== null)
    if (view === 'notSigned') lines = lines.filter((line) => line.voided === null)
    return { issues: lines.slice(0, limit), complete: rows.length < limit && lines.length <= limit, law: PPE_LAW }
  })
}

export async function readableReceipt(caller: CommandCaller, context: OfficeContext, issueId: string): Promise<ReceiptView> {
  const view = isUuid(issueId)
    ? await caller.withClient(async (client) => {
        const rows = await receiptRowsOf(client, issueId)
        return rows ? ((await receiptViews(client, context, rows))[0] ?? null) : null
      })
    : null
  if (!view) throw new NotFoundError('Receipt not found.')
  assertMayAt(context, SAFETY_VIEW, view, 'Receipt')
  return view
}

/**
 * GET /safety/ppe/receipts/:receiptId (any row of it): the receipt, and for a PIN receipt the words the person signed and
 * whether its SHA-256 is of exactly these lines (`verified`: the statement in the person's language, the person, the worker,
 * the tablet, the instant, each line's item, size, units and why).
 */
export async function receiptRecord(caller: CommandCaller, receiptId: string) {
  const context = officeOf(caller)
  const receipt = await readableReceipt(caller, context, receiptId)
  const language = signedLanguage(receipt)
  return { receipt, statement: language ? RECEIPT_STATEMENT[language] : null, verified: language !== null, law: PPE_LAW }
}

/** The language whose statement reproduces a PIN receipt's SHA-256 (null: a paper receipt, or none reproduces it). */
export function signedLanguage(receipt: ReceiptView): StatementLanguage | null {
  if (!receipt.signature || !receipt.signature.device) return null
  return signedLanguageOf(
    {
      companyId: receipt.companyId,
      siteId: receipt.siteId,
      employeeId: receipt.employee.id,
      workerId: receipt.signature.workerId,
      deviceId: receipt.signature.device.id,
      issuedAt: receipt.issuedAt,
      lines: receipt.lines.map((line) => ({ ppeItemId: line.item.id, code: line.item.code, size: line.size, quantity: line.quantity, reason: line.reason })),
    },
    receipt.signature.sha256,
  )
}

/** The person the PPE is handed to: readable, of a company, working for it; null fields refused by the caller. */
export async function readPerson(tools: Pick<CommandTools, 'tx'>, employeeId: string) {
  return tools.tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true, status: true, firstName: true, lastName: true } })
}

/** The catalogue items the lines name (any company: the lines' check refuses another company's). */
export async function itemsOfLines(tools: Pick<CommandTools, 'tx'>, lines: readonly IssueLineDraft[]) {
  const rows = await tools.tx.ppeItem.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.ppeItemId))] } }, select: { id: true, companyId: true, status: true, sizes: true, code: true, name: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

/** POST /safety/ppe/issues: a paper receipt. */
export async function issueOnPaper(caller: CommandCaller, body: { readonly employeeId: string; readonly lines: readonly IssueLineDraft[]; readonly issuedAt?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const person = isUuid(body.employeeId) ? await caller.withClient((client) => client.employee.findUnique({ where: { id: body.employeeId }, select: { id: true, companyId: true, siteId: true } })) : null
  if (!person) throw new NotFoundError('Person not found.')
  assertMayAt(context, SAFETY_VIEW, person, 'Person')
  assertMayWriteAt(context, SAFETY_PPE_ISSUE, person, ISSUE_WORDS)
  const { result, replayed } = await command(caller, { name: 'safety.issuePpe', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockPerson(tx, person.id)
    const current = (await readPerson(tools, person.id))!
    if (current.status !== 'ACTIVE') refuse('NOT_ACTIVE', PPE_REFUSALS.NOT_ACTIVE, 'employeeId')
    const issuedAt = body.issuedAt ? new Date(body.issuedAt) : now
    const late = paperDateRefusal(issuedAt, now)
    if (late) refuse(late, PPE_REFUSALS[late], 'issuedAt')
    const items = await itemsOfLines(tools, body.lines)
    const problems = lineProblems(body.lines, items, current.companyId)
    if (problems.length > 0) throw problemsError(problems, 'The items to hand over are not valid.')
    if (await tx.ppeIssue.findFirst({ where: { kind: 'ISSUE', siteId: current.siteId, employeeId: current.id, issuedAt }, select: { id: true } })) refuse('SAME_TIME', PPE_REFUSALS.SAME_TIME, 'issuedAt')
    const actorId = actorIdOf(tools.context)
    const ids = body.lines.map(() => newId()).sort()
    for (const [index, line] of body.lines.entries()) {
      await tx.ppeIssue.create({
        data: {
          id: ids[index]!,
          companyId: current.companyId,
          siteId: current.siteId,
          kind: 'ISSUE',
          employeeId: current.id,
          ppeItemId: line.ppeItemId,
          size: line.size?.trim() || null,
          quantity: line.quantity,
          reason: line.reason,
          issuedAt,
          issuedById: actorId,
          method: 'PAPER',
          createdAt: now,
          createdById: actorId,
        },
        select: { id: true },
      })
    }
    const receiptId = ids[0]!
    const units = body.lines.reduce((sum, line) => sum + line.quantity, 0)
    tools.audit({
      action: 'safety.issuePpe',
      recordType: RECORD_ISSUE,
      recordId: receiptId,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { receiptId, employeeId: current.id, method: 'PAPER', issuedAt: toUtcIso(issuedAt), lines: body.lines.map((line, index) => ({ issueId: ids[index], ppeItemId: line.ppeItemId, code: items.get(line.ppeItemId)!.code, size: line.size?.trim() || null, quantity: line.quantity, reason: line.reason })) },
    })
    tools.emit({ type: 'ppe.issued', subject: receiptId, companyId: current.companyId, siteId: current.siteId, payload: { receiptId, employeeId: current.id, issueIds: ids, units, method: 'PAPER', via: 'OFFICE' } })
    return { receiptId, companyId: current.companyId }
  })
  const receipt = await readableReceipt(caller, context, result.receiptId)
  return { receipt, scan: { recordType: RECORD_ISSUE as 'PpeIssue', recordId: result.receiptId, companyId: result.companyId }, replayed }
}

/** POST /safety/ppe/issues/:issueId/void: a VOID row copying the line, with the reason; the receipt stays. */
export async function voidIssue(caller: CommandCaller, issueId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const row = isUuid(issueId) ? await caller.withClient((client) => client.ppeIssue.findUnique({ where: { id: issueId }, select: ISSUE_SELECT })) : null
  if (!row) throw new NotFoundError('Issue not found.')
  assertMayAt(context, SAFETY_VIEW, row, 'Issue')
  assertMayWriteAt(context, SAFETY_PPE_ISSUE, row, 'A wrong issue is voided by a role that records receipts (safety.ppe.issue).')
  if (row.kind !== 'ISSUE') refuse('NOT_AN_ISSUE', PPE_REFUSALS.NOT_AN_ISSUE)
  const { result } = await command(caller, { name: 'safety.voidPpeIssue', idempotencyKey, input: { issueId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockPerson(tx, row.employeeId)
    if (await tx.ppeIssue.findFirst({ where: { voidsId: issueId }, select: { id: true } })) refuse('VOIDED_ALREADY', PPE_REFUSALS.VOIDED_ALREADY)
    const rows = (await receiptRowsOf(tx, issueId))!
    const receiptId = rows[0]!.id
    const id = newId()
    const actorId = actorIdOf(tools.context)
    await tx.ppeIssue.create({
      data: { id, companyId: row.companyId, siteId: row.siteId, kind: 'VOID', employeeId: row.employeeId, ppeItemId: row.ppeItemId, size: row.size, quantity: row.quantity, issuedAt: now, voidsId: issueId, voidReason: body.reason.trim(), createdAt: now, createdById: actorId },
      select: { id: true },
    })
    tools.audit({ action: 'safety.voidPpeIssue', recordType: RECORD_ISSUE, recordId: issueId, companyId: row.companyId, siteId: row.siteId, after: { voidId: id, receiptId, employeeId: row.employeeId, ppeItemId: row.ppeItemId, size: row.size, quantity: row.quantity }, reason: body.reason })
    tools.emit({ type: 'ppe_issue.voided', subject: issueId, companyId: row.companyId, siteId: row.siteId, payload: { issueId, voidId: id, receiptId, employeeId: row.employeeId } })
    return { receiptId }
  })
  return { receipt: await readableReceipt(caller, context, result.receiptId) }
}

