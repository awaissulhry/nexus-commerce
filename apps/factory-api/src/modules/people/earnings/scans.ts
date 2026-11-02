import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { entryKey, isScanFamily, piecesAmount, planLedger } from '@nexus/factory-domain/people/earnings/ledger'
import { isPaidScan, NOTHING_TO_PAY_WORDS, FIXED_BY_CLOCK_WORDS, payablePieces, paysOn, rateFor, REVERSAL_WORDS, skillWeightOf, type HoldReason, type RateCandidate } from '@nexus/factory-domain/people/earnings/rules'
import { defectPayOf, teamSplitOf, type DefectKind } from '@nexus/factory-domain/people/schemes/pay'
import type { SchemeRow } from '@nexus/factory-domain/people/schemes/rules'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import type { CommandTools } from '../../../core/command'
import { lockPerson } from '../attendance/compute'
import type { Client } from '../attendance/store'
import { dateOf } from '../employees/access'
import { payGuarded, tenantOf } from './access'
import { applyPlan, placeOf, reverseEntry, type EntryDraft } from './ledger'
import { clockOf, entriesOfKeys, ENTRY_SELECT, ledgerRowOf, membersOfScans, momentOf, SCAN_SELECT, withReversals, workOfScans, type PayFacts, type ScanRecord, type WorkFacts } from './store'

/**
 * Scans become pay as they happen (B-W2b-43; MES-256, MES-264). ONE place decides what one bundle at one operation pays, from
 * every scan it has: a resent event, an undo, a correction or a partial all come here, and the ledger moves only by what
 * changed (factory-domain people/earnings/ledger). So a scan an UNDO or CORRECTION voids is reversed, a REPORT pays what the
 * partials did not, and a run that finds a scan unpaid repairs it the same way.
 *
 *   hold      not clocked in (or on a break) at the moment of the scan, where the rule applies: a HeldScan, no pay. A team
 *             holds together: the guard holds a scan only on its own worker, so one member who was not clocked in holds the
 *             whole scan, and the record shows who.
 *   release   an OPEN hold whose worker now shows clocked in at that moment (a tablet's clock event that came later, HR's
 *             attendance fix) is COUNTED by that fact; a scan undone leaves nothing to pay, so its OPEN hold is closed.
 *   team      a scan of two or more members pays by share (TEAM_SPLIT): the shares depend on the day's minutes, so the
 *             period's run books them. Only in a month already locked are they booked here.
 *   own fault the scan's own scrap and rework follow the scheme's own-fault rule (nothing, or pieces at a set rate); no record
 *             says whose fault it was, so the statement says so and the worker can dispute it.
 */

const SCAN_KINDS = ['REPORT', 'CORRECTION', 'UNDO', 'PARTIAL'] as const

export interface ScanSync {
  readonly added: number
  readonly reversed: number
  readonly held: number
  readonly released: number
  readonly withoutRate: number
}

const NOTHING: ScanSync = Object.freeze({ added: 0, reversed: 0, held: 0, released: 0, withoutRate: 0 })

/** The floor sign-ins' employees. */
async function employeesOfWorkers(db: Client, workerIds: readonly string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(workerIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.worker.findMany({ where: { id: { in: ids } }, select: { id: true, employeeId: true } })).map((row) => [row.id, row.employeeId]))
}

/** Is someone of these people not clocked in at the moment? The first reason, or null. */
async function holdOf(db: Client, employeeIds: readonly string[], at: Date): Promise<{ readonly reason: HoldReason | null; readonly clockEventId: string | null }> {
  let clockEventId: string | null = null
  for (const employeeId of employeeIds) {
    const stood = await clockOf(db, employeeId, at)
    if (stood.hold) return { reason: stood.hold, clockEventId: null }
    clockEventId ??= stood.clockEventId
  }
  return { reason: null, clockEventId }
}

/** What a team scan pays each member: their share of the pieces × the rate (a 0 share gets no entry). */
export async function teamDrafts(
  db: Client,
  input: {
    readonly scan: Pick<ScanRecord, 'id' | 'siteId'>
    readonly day: BusinessDate
    readonly work: WorkFacts
    readonly pieces: number
    readonly rate: RateCandidate
    readonly scheme: SchemeRow | null
    readonly members: readonly { readonly workerId: string; readonly employeeId: string | null }[]
    readonly heldScanId: string | null
  },
): Promise<EntryDraft[]> {
  const { scan, day, work, pieces, rate, scheme, members } = input
  const pay = piecesAmount(pieces, rate.ratePerPiece, rate.currency)
  const everyone = members.map((member) => ({ key: member.workerId, skillWeight: '1' }))
  let shares = teamSplitOf({ basis: 'SKILL_WEIGHT', pay, members: everyone })
  const employees = members.flatMap((member) => (member.employeeId ? [member.employeeId] : []))
  if (scheme?.teamSplit === 'HOURS_PRESENT') {
    const days = await db.attendanceDay.findMany({ where: { employeeId: { in: employees }, date: dateOf(day) }, select: { employeeId: true, presentMinutes: true } })
    const minutes = new Map(days.map((row) => [row.employeeId, row.presentMinutes]))
    const weighted = members.map((member) => ({ key: member.workerId, minutesPresent: member.employeeId ? (minutes.get(member.employeeId) ?? 0) : 0 }))
    // No minutes on record for anyone (no clock at this site): equal shares, never no pay.
    if (weighted.some((member) => member.minutesPresent > 0)) shares = teamSplitOf({ basis: 'HOURS_PRESENT', pay, members: weighted })
  } else if (scheme?.teamSplit === 'SKILL_WEIGHT' && work.operationId) {
    const skills = await db.employeeSkill.findMany({ where: { employeeId: { in: employees }, removedAt: null, skill: { operationId: work.operationId } }, select: { employeeId: true, level: true } })
    const levels = new Map(skills.map((row) => [row.employeeId, row.level as string]))
    shares = teamSplitOf({ basis: 'SKILL_WEIGHT', pay, members: members.map((member) => ({ key: member.workerId, skillWeight: skillWeightOf(member.employeeId ? levels.get(member.employeeId) : null) })) })
  }
  const byWorker = new Map(shares.map((share) => [share.key, share]))
  return members.flatMap((member) => {
    const share = byWorker.get(member.workerId)
    if (!member.employeeId || !share || Number(share.sharePct) <= 0) return []
    return [
      {
        key: entryKey.team(scan.id, member.workerId),
        kind: 'TEAM_SPLIT' as const,
        siteId: scan.siteId,
        employeeId: member.employeeId,
        workerId: member.workerId,
        workDate: day,
        pieces,
        minutes: null,
        rate: rate.ratePerPiece,
        amount: share.amount,
        currency: rate.currency,
        operationScanId: scan.id,
        rateEntryId: rate.entryId,
        sharePct: share.sharePct,
        heldScanId: input.heldScanId,
      },
    ]
  })
}

/** The own-fault lines of a scan: its rework and scrap at the scheme's rule (nothing when it does not pay them). */
function ownFaultDrafts(scan: ScanRecord, draft: Omit<EntryDraft, 'key' | 'pieces' | 'rate' | 'amount'>, rate: RateCandidate, scheme: SchemeRow | null): EntryDraft[] {
  if (!scheme) return []
  const parts: readonly [DefectKind, number, string][] = [
    ['REWORK', scan.reworkQuantity, entryKey.rework(scan.id)],
    ['SCRAP', scan.scrapQuantity, entryKey.scrap(scan.id)],
  ]
  return parts.flatMap(([what, pieces, key]) => {
    if (pieces === 0) return []
    const pay = defectPayOf(scheme, { what, fault: 'OWN', pieces, ratePerPiece: rate.ratePerPiece, minutes: 0, averagePerMinute: null })
    return pay.pays === 'PIECES' ? [{ ...draft, key, pieces, rate: pay.rate, amount: pay.amount }] : []
  })
}

/** Keeps one bundle at one operation in step, inside the caller's command. Takes the people's locks. */
export async function syncBundleInCommand(tools: CommandTools, facts: PayFacts, ref: { readonly bundleId: string; readonly workOrderOperationId: string }): Promise<ScanSync> {
  const { tx } = tools
  const rows = await tx.operationScan.findMany({ where: { bundleId: ref.bundleId, workOrderOperationId: ref.workOrderOperationId, kind: { in: [...SCAN_KINDS] } }, select: SCAN_SELECT, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
  const paid = rows.filter((scan) => isPaidScan(scan.kind))
  if (paid.length === 0) return NOTHING
  const site = await facts.site(paid[0]!.siteId)
  if (site.windows.length === 0) return NOTHING
  const companyId = site.companyId
  const pieces = payablePieces(rows)
  const [members, work, holds] = await Promise.all([membersOfScans(tx, paid), workOfScans(tx, paid), tx.heldScan.findMany({ where: { operationScanId: { in: paid.map((scan) => scan.id) } }, select: { id: true, operationScanId: true, status: true, payPeriodId: true } })])
  const employees = await employeesOfWorkers(tx, [...paid.flatMap((scan) => (scan.workerId ? [scan.workerId] : [])), ...[...members.values()].flat().map((member) => member.workerId)])
  for (const employeeId of [...new Set([...employees.values()].filter((id): id is string => id !== null))].sort()) await lockPerson(tx, tenantOf(tools.context), employeeId)
  const rates = await facts.ratesAt(paid[0]!.siteId)
  const wanted: EntryDraft[] = []
  let held = 0
  let released = 0
  let withoutRate = 0
  let teamAdded = 0
  for (const scan of paid) {
    const hold = holds.find((row) => row.operationScanId === scan.id) ?? null
    const count = pieces.get(scan.id)
    if (count === undefined) {
      if (hold?.status === 'OPEN') {
        await closeHold(tools, hold.id, 'NOT_PAID', { note: NOTHING_TO_PAY_WORDS }, companyId, scan.siteId)
        released += 1
      }
      continue
    }
    const at = momentOf(scan)
    const day = await facts.dayAt(scan.siteId, at)
    const employeeId = scan.workerId ? (employees.get(scan.workerId) ?? null) : null
    if (!paysOn(site.windows, day) || !scan.workerId || !employeeId) continue
    const team = members.get(scan.id) ?? []
    const isTeam = team.length >= 2
    const scanWork = work.get(scan.id)!
    const people = isTeam ? team.flatMap((member) => (member.employeeId ? [member.employeeId] : [])) : [employeeId]
    let heldScanId: string | null = null
    if (hold?.status === 'NOT_PAID') continue
    if (hold?.status === 'OPEN') {
      const stood = await holdOf(tx, people, at)
      if (stood.reason !== null || stood.clockEventId === null) continue
      await closeHold(tools, hold.id, 'COUNTED', { note: FIXED_BY_CLOCK_WORDS, fixRecordType: 'ClockEvent', fixRecordId: stood.clockEventId }, companyId, scan.siteId)
      released += 1
      heldScanId = hold.id
    } else if (hold?.status === 'COUNTED') {
      heldScanId = hold.id
    } else if (await facts.holdsApply({ companyId, siteId: scan.siteId, lineId: scanWork.lineId, day })) {
      const stood = await holdOf(tx, people, at)
      if (stood.reason !== null) {
        await openHold(tools, { companyId, scan, employeeId, workerId: scan.workerId, day, reason: stood.reason, heldAt: at })
        held += 1
        continue
      }
    }
    const rate = scanWork.operationId ? rateFor(rates, { day, operationId: scanWork.operationId, styleId: scanWork.styleId, lineId: scanWork.lineId, size: scanWork.size }) : null
    if (!rate) {
      if (count > 0) withoutRate += 1
      continue
    }
    const scheme = await facts.schemeFor(companyId, scanWork.lineId, day)
    if (isTeam) {
      // A team's shares are the period's, unless its month is locked already: then this is the only pass it gets.
      const place = await placeOf(tools, companyId, day)
      if (place.correctsPeriodId === null || count === 0) continue
      const drafts = await teamDrafts(tx, { scan, day, work: scanWork, pieces: count, rate, scheme, members: team, heldScanId })
      const existing = await entriesOfKeys(tx, drafts.map((draft) => draft.key))
      const plan = planLedger(existing.map(ledgerRowOf), drafts, () => false)
      teamAdded += (await applyPlan(tools, companyId, plan, existing, REVERSAL_WORDS)).added
      continue
    }
    const base = { kind: 'SCAN' as const, siteId: scan.siteId, employeeId, workerId: scan.workerId, workDate: day, minutes: null, currency: rate.currency, operationScanId: scan.id, rateEntryId: rate.entryId, heldScanId }
    if (count > 0) wanted.push({ ...base, key: entryKey.scan(scan.id), pieces: count, rate: rate.ratePerPiece, amount: piecesAmount(count, rate.ratePerPiece, rate.currency) })
    wanted.push(...ownFaultDrafts(scan, base, rate, scheme))
  }
  const keys = paid.flatMap((scan) => [entryKey.scan(scan.id), entryKey.rework(scan.id), entryKey.scrap(scan.id)])
  const existing = await entriesOfKeys(tx, keys)
  const plan = planLedger(existing.map(ledgerRowOf), wanted, isScanFamily)
  const moved = await applyPlan(tools, companyId, plan, existing, REVERSAL_WORDS)
  // A team's scan undone or corrected: its shares go with it (the corrected scan's come from the run).
  const voided = paid.filter((scan) => !pieces.has(scan.id)).map((scan) => scan.id)
  let teamReversed = 0
  if (voided.length > 0) {
    const shares = await withReversals(tx, await tx.earningsEntry.findMany({ where: { operationScanId: { in: voided }, kind: 'TEAM_SPLIT', reversalOfId: null }, select: ENTRY_SELECT }))
    const gone = new Set(shares.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
    for (const row of shares) {
      if (row.reversalOfId || gone.has(row.id)) continue
      await reverseEntry(tools, row, REVERSAL_WORDS)
      teamReversed += 1
    }
  }
  const change = { added: moved.added + teamAdded, reversed: moved.reversed + teamReversed, held, released, withoutRate }
  if (change.added + change.reversed + change.held + change.released > 0) {
    tools.audit({ action: 'people.recordEarnings', recordType: 'Bundle', recordId: ref.bundleId, companyId, siteId: paid[0]!.siteId, after: { workOrderOperationId: ref.workOrderOperationId, added: change.added, reversed: change.reversed, held, released } })
    tools.emit({ type: 'earnings.recorded', subject: ref.bundleId, companyId, siteId: paid[0]!.siteId, payload: { siteId: paid[0]!.siteId, bundleId: ref.bundleId, added: change.added, reversed: change.reversed, held, released } })
  }
  return change
}

async function openHold(tools: CommandTools, input: { readonly companyId: string; readonly scan: ScanRecord; readonly employeeId: string; readonly workerId: string; readonly day: BusinessDate; readonly reason: HoldReason; readonly heldAt: Date }): Promise<void> {
  const { period } = await placeOf(tools, input.companyId, input.day)
  const id = newId()
  await payGuarded(() =>
    tools.tx.heldScan.create({
      data: { id, companyId: input.companyId, siteId: input.scan.siteId, payPeriodId: period.id, employeeId: input.employeeId, workerId: input.workerId, operationScanId: input.scan.id, reason: input.reason, heldAt: input.heldAt, key: `held:${input.scan.id}` },
      select: { id: true },
    }),
  )
  tools.emit({ type: 'held_scan.changed', subject: id, companyId: input.companyId, siteId: input.scan.siteId, payload: { heldScanId: id, siteId: input.scan.siteId, periodId: period.id, status: 'OPEN', change: 'HELD' } })
}

/** The system closes a hold by a fact (the clock shows the worker in; the scan is gone). A person's decision is held.ts's. */
async function closeHold(tools: CommandTools, id: string, status: 'COUNTED' | 'NOT_PAID', input: { readonly note: string; readonly fixRecordType?: string; readonly fixRecordId?: string }, companyId: string, siteId: string): Promise<void> {
  const row = await payGuarded(() =>
    tools.tx.heldScan.update({
      where: { id },
      data: { status, resolvedAt: tools.now, resolvedById: SYSTEM_ACTOR_ID, resolutionNote: input.note, fixRecordType: input.fixRecordType ?? null, fixRecordId: input.fixRecordId ?? null, version: { increment: 1 } },
      select: { payPeriodId: true },
    }),
  )
  tools.audit({ action: 'people.settleHeldScan', recordType: 'HeldScan', recordId: id, companyId, siteId, before: { status: 'OPEN' }, after: { status, fixRecordType: input.fixRecordType ?? null, fixRecordId: input.fixRecordId ?? null } })
  tools.emit({ type: 'held_scan.changed', subject: id, companyId, siteId, payload: { heldScanId: id, siteId, periodId: row.payPeriodId, status, change: status } })
}
