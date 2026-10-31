import { ConflictError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { QUALITY_NCR_MANAGE, QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { NCR_BULK_LIMIT, type NcrStage } from '@nexus/factory-domain/quality/ncr/rules'
import { command, type CommandCaller } from '../../../core/command'
import { emitChanged, frozenWords, may, officeOf } from './ncr'
import { NCR_COLUMNS, NCR_RECORD, ncrSummary, summaryFactsOf, type Reader } from './store'
import { serverClock } from '../../../core/time'

/**
 * Bulk owner (B-W2b-17; B-W2a-68's gap: "Assign owner N" was one PATCH per NCR): POST /quality/ncr/assign — ONE command
 * gives the selected NCRs (≤ 50) one owner (an ACTIVE office person) or none, every NCR or none. Each NCR is locked
 * FOR UPDATE in id order, at the version the caller read, open (not CLOSED or CANCELLED), at a site where the caller
 * has quality.ncr.manage; a refusal names the NCR (409 `ncrs/<i>/<CODE>` — NOT_FOUND, NO_RIGHT, CLOSED, STALE — in words). One audit row and one ncr.changed (fields
 * ownerId) per NCR whose owner changed; an NCR that has that owner already is left as it is.
 */

/** Some NCRs cannot take the owner: a 409 naming each one (`ncrs/<i>`), nothing changed. */
export class AssignRefusedError extends ConflictError {
  override name = 'AssignRefusedError'
  override readonly issues: readonly Issue[]
  constructor(problems: readonly Issue[], total: number) {
    super(problems.length === 1 ? problems[0]!.message : `${problems.length} of the ${total} NCRs cannot take the owner: nothing was changed.`)
    this.issues = problems
  }
}

export interface AssignBody {
  readonly ncrs: readonly { readonly id: string; readonly version: number }[]
  readonly ownerId: string | null
}

export async function assignNcrs(caller: CommandCaller, body: AssignBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const ids = body.ncrs.map((entry) => entry.id)
  if (body.ncrs.length === 0 || body.ncrs.length > NCR_BULK_LIMIT) throw new ValidationError(`Pick 1 to ${NCR_BULK_LIMIT} NCRs.`, [{ path: 'body/ncrs', message: `1 to ${NCR_BULK_LIMIT} NCRs.` }])
  if (new Set(ids).size !== ids.length) throw new ValidationError('Each NCR once.', [{ path: 'body/ncrs', message: 'Each NCR once.' }])
  const answer = async (db: Reader, changed: string[]) => {
    const rows = await db.nonconformance.findMany({ where: { id: { in: ids } }, select: NCR_COLUMNS })
    const facts = await summaryFactsOf(db, rows)
    const now = serverClock.now()
    const byId = new Map(rows.map((row) => [row.id, ncrSummary(row, facts, now)]))
    return { ncrs: ids.map((id) => byId.get(id)!), changed }
  }
  // Nothing to change (each one has this owner already, at the version read, and may be managed): the answer as it
  // stands, no command — a command writes and audits something.
  const current = await caller.withClient((db) => db.nonconformance.findMany({ where: { id: { in: ids } }, select: { id: true, version: true, ownerId: true, companyId: true, siteId: true, stage: true } }))
  const unchanged =
    current.length === ids.length &&
    body.ncrs.every((entry) => {
      const row = current.find((candidate) => candidate.id === entry.id)
      return row !== undefined && row.version === entry.version && row.ownerId === body.ownerId && may(context, QUALITY_NCR_MANAGE, row) && frozenWords(row.stage as NcrStage) === null
    })
  if (unchanged) return caller.withClient((db) => answer(db, []))
  const { result } = await command(caller, { name: 'quality.assignNcrs', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (body.ownerId !== null && body.ownerId !== context.actorId) {
      const owner = isUuid(body.ownerId) ? await tx.user.findUnique({ where: { id: body.ownerId }, select: { status: true } }) : null
      if (!owner || owner.status !== 'ACTIVE') throw new ValidationError('The owner is an active person of the office.', [{ path: 'body/ownerId', message: 'An active person of the office.' }])
    }
    // Locks in id order (two bulk assigns of overlapping NCRs take turns, never deadlock).
    const order = [...ids].sort()
    const locked = new Map<string, { version: number; stage: NcrStage }>()
    for (const id of order) {
      const [row] = await tx.$queryRaw<{ version: number; stage: NcrStage }[]>`SELECT "version", "stage"::text AS "stage" FROM "Nonconformance" WHERE "id" = ${id}::uuid FOR UPDATE`
      if (row) locked.set(id, row)
    }
    const rows = new Map((await tx.nonconformance.findMany({ where: { id: { in: ids } }, select: NCR_COLUMNS })).map((row) => [row.id, row]))
    const problems: Issue[] = []
    body.ncrs.forEach((entry, index) => {
      const row = rows.get(entry.id)
      const lock = locked.get(entry.id)
      if (!row || !lock || !may(context, QUALITY_NCR_VIEW, row)) return void problems.push({ path: `ncrs/${index}/NOT_FOUND`, message: 'NCR not found.' })
      const label = row.number
      if (!may(context, QUALITY_NCR_MANAGE, row)) return void problems.push({ path: `ncrs/${index}/NO_RIGHT`, message: `${label}: assigning an owner needs quality.ncr.manage at its site.` })
      const frozen = frozenWords(lock.stage)
      if (frozen) return void problems.push({ path: `ncrs/${index}/CLOSED`, message: `${label}: ${frozen}` })
      if (lock.version !== entry.version) problems.push({ path: `ncrs/${index}/STALE`, message: `${label} changed since it was read: read the list again.` })
    })
    if (problems.length > 0) throw new AssignRefusedError(problems, body.ncrs.length)
    const changed: string[] = []
    for (const id of order) {
      const row = rows.get(id)!
      if (row.ownerId === body.ownerId) continue
      await tx.nonconformance.update({ where: { id }, data: { ownerId: body.ownerId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'quality.assignNcr', recordType: NCR_RECORD, recordId: id, companyId: row.companyId, siteId: row.siteId, before: { ownerId: row.ownerId }, after: { ownerId: body.ownerId } })
      emitChanged(tools, row, ['ownerId'])
      changed.push(id)
    }
    // Read as changed before the command, unchanged now: another person gave them this owner meanwhile.
    if (changed.length === 0) throw new ConflictError('These NCRs changed while you assigned them: read them again.')
    return answer(tx, changed)
  })
  return result
}
