import { newId } from '@nexus/factory-domain/core/ids'
import type { MinorUnits } from '@nexus/factory-domain/core/money'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { entryKey, baseKey, frozenBases, isPeriodFamily, isScanFamily, othersCodeOf, periodBonus, periodMakeUp, planLedger, type BonusWork, type PaidDay } from '@nexus/factory-domain/people/earnings/ledger'
import { BONUS_PIECES_WORDS, defectsByFault, isPaidScan, LATE_DAYS, paidRuleOf, payablePieces, paysOn, PERIOD_FIGURE_WORDS, rateFor, traineeOn, voidedScans, type TraineeSpan } from '@nexus/factory-domain/people/earnings/rules'
import { statementOf, type BuiltStatement, type PayLine } from '@nexus/factory-domain/people/earnings/statement'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { averagePerMinuteOf, defectMinutesOf, defectPayOf, paidTimeOf } from '@nexus/factory-domain/people/schemes/pay'
import { paysByPiece, type SchemeRow } from '@nexus/factory-domain/people/schemes/rules'
import { minutesOf } from '@nexus/factory-domain/production/offstandard/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { actorIdOf, dateOf, dayOf, dayOrNull } from '../employees/access'
import type { Client, PersonRow } from '../attendance/store'
import { applyPlan, placeOf, type EntryDraft } from './ledger'
import { syncBundleInCommand, teamDrafts } from './scans'
import { decimalOf, defectsOfScans, entriesOfKeys, ENTRY_SELECT, ledgerRowOf, membersOfScans, momentOf, monthOfPeriod, SCAN_SELECT, workOfScans, type EntryRecord, type PayFacts, type PeriodRecord, type ScanRecord } from './store'

/**
 * One person's period (B-W2b-43; MES-260, MES-261, MES-148; c.c. arts. 2100-2101). ONE place computes it, for the preview,
 * for the review and for the statement, so the figures a person reviews are the ones the ledger books.
 *
 *   scans        what the scans' event handler may have missed is put right first (scans.ts)
 *   team shares  each team scan's share of this person (the day's minutes present, or the skill in the scheme's split)
 *   time         APPROVED off-standard blocks, by paidRuleOf (MES-148: waiting is never unpaid). A block of an earlier,
 *                locked month that was decided late is paid here too, naming that month
 *   minutes      the guaranteed pay counts ordinary minutes and APPROVED overtime (OvertimeEntry, never
 *                AttendanceDay.overtimeMinutes: that is overtime nobody approved yet), day by day, only inside the site's
 *                piece-pay window, each day under the scheme of its line
 *   make-up      periodMakeUp: guaranteed − (pieces + team shares + paid time); work of an earlier month paid now and
 *                adjustments do not count towards it (factory-domain schemes/pay earnedForMakeUp)
 *   fault        (B-W2b-84) rework and scrap of the person's own scans whose reasons put them down to others: paid time
 *                (OFF_STANDARD, `others:`), the garments' standard minutes at the scheme's othersFaultPay. The reasons'
 *                fault is read as it stands at each run, so a bundle with scrap or rework is synced again first
 *   bonus        (B-W2b-84) days under a standard-minute bonus scheme: their guaranteed pay whole (the make-up: the pieces
 *                pay nothing by the piece there), and the BONUS of the standard minutes their work earned above the
 *                threshold. Waiting, rework and scrap are inside those minutes: no paid time on such a day
 *
 * The preview books scans only: team shares, paid time and the make-up move with every late scan, and an append-only ledger
 * must not carry each preview's guess. They are shown on the DRAFT statement, and booked when the review starts (`book`).
 */

export interface PersonRun {
  readonly statementId: string
  readonly added: number
  readonly reversed: number
  readonly built: BuiltStatement
}

const CODE_SELECT = { id: true, code: true, payRule: true } as const

function monthRange(period: PeriodRecord): { readonly from: Date; readonly to: Date } {
  // A wider window than the month: a scan's day is the site's, of the tablet's moment. The day filter below is exact.
  return { from: new Date(period.periodStart.getTime() - 2 * 86_400_000), to: new Date(period.periodEnd.getTime() + 3 * 86_400_000) }
}

/** The person's scans of the month, by their floor sign-ins, and what stands on them: which bundles need the sync. */
async function ownScans(db: Client, facts: PayFacts, workerIds: readonly string[], period: PeriodRecord, companyId: string): Promise<{ readonly scans: ScanRecord[]; readonly stale: readonly { bundleId: string; workOrderOperationId: string }[] }> {
  if (workerIds.length === 0) return { scans: [], stale: [] }
  const { from, to } = monthRange(period)
  const first = dayOf(period.periodStart)
  const last = dayOf(period.periodEnd)
  const rows = await db.operationScan.findMany({ where: { workerId: { in: [...workerIds] }, kind: { in: ['REPORT', 'CORRECTION', 'UNDO', 'PARTIAL'] }, serverTime: { gte: from, lt: to } }, select: SCAN_SELECT, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
  const scans: ScanRecord[] = []
  for (const row of rows) {
    const day = await facts.dayAt(row.siteId, momentOf(row))
    if (day >= first && day <= last) scans.push(row)
  }
  const ids = scans.map((scan) => scan.id)
  const [paid, holds] = await Promise.all([
    ids.length === 0 ? [] : db.earningsEntry.findMany({ where: { operationScanId: { in: ids }, reversalOfId: null }, select: { operationScanId: true, id: true, kind: true, amount: true, reversedBy: { select: { id: true } } } }),
    ids.length === 0 ? [] : db.heldScan.findMany({ where: { operationScanId: { in: ids } }, select: { operationScanId: true, status: true } }),
  ])
  const livePaid = new Set(paid.filter((row) => row.reversedBy.length === 0).map((row) => row.operationScanId))
  // B-W2b-84: a scan a bonus scheme covers, still paid by the piece (booked before the ledger knew the bonus), is put right.
  const pricedLive = paid.filter((row) => row.reversedBy.length === 0 && row.kind === 'SCAN' && row.amount > 0)
  const pricedScans = scans.filter((scan) => pricedLive.some((row) => row.operationScanId === scan.id))
  const pricedWork = await workOfScans(db, pricedScans)
  const bonusPriced = new Set<string>()
  for (const scan of pricedScans) {
    const day = await facts.dayAt(scan.siteId, momentOf(scan))
    if (!paysByPiece(await facts.schemeFor(companyId, pricedWork.get(scan.id)?.lineId ?? null, day))) bonusPriced.add(scan.id)
  }
  const holdBy = new Map(holds.map((row) => [row.operationScanId, row.status]))
  const voided = voidedScans(scans)
  const seen = new Set<string>()
  const stale: { bundleId: string; workOrderOperationId: string }[] = []
  for (const scan of scans) {
    if (!isPaidScan(scan.kind)) continue
    const isVoided = voided.has(scan.id)
    const hold = holdBy.get(scan.id)
    const settled = hold === 'NOT_PAID' || (hold !== 'OPEN' && (isVoided ? !livePaid.has(scan.id) : livePaid.has(scan.id)))
    // Scrap and rework pay by their reasons' fault as it stands now: such a bundle is synced at every run.
    const faultsMove = !isVoided && scan.scrapQuantity + scan.reworkQuantity > 0
    if (settled && !faultsMove && !bonusPriced.has(scan.id)) continue
    const key = `${scan.bundleId}|${scan.workOrderOperationId}`
    if (seen.has(key)) continue
    seen.add(key)
    stale.push({ bundleId: scan.bundleId, workOrderOperationId: scan.workOrderOperationId })
  }
  return { scans, stale }
}

/** This person's share of each team scan of the month (a corrected team scan: its correction's members are the report's). */
async function teamShares(db: Client, facts: PayFacts, person: PersonRow, period: PeriodRecord): Promise<EntryDraft[]> {
  const { from, to } = monthRange(period)
  const rows = await db.operationScanMember.findMany({ where: { employeeId: person.id, scan: { serverTime: { gte: from, lt: to } } }, select: { scan: { select: { bundleId: true, workOrderOperationId: true } } } })
  const pairs = new Map(rows.map((row) => [`${row.scan.bundleId}|${row.scan.workOrderOperationId}`, row.scan]))
  const first = dayOf(period.periodStart)
  const last = dayOf(period.periodEnd)
  const out: EntryDraft[] = []
  for (const pair of pairs.values()) {
    const siblings = await db.operationScan.findMany({ where: { bundleId: pair.bundleId, workOrderOperationId: pair.workOrderOperationId, kind: { in: ['REPORT', 'CORRECTION', 'UNDO', 'PARTIAL'] } }, select: SCAN_SELECT })
    const pieces = payablePieces(siblings)
    const standing = siblings.filter((scan) => (pieces.get(scan.id) ?? 0) > 0)
    const members = await membersOfScans(db, standing)
    for (const scan of standing) {
      const team = members.get(scan.id) ?? []
      if (team.length < 2 || !team.some((member) => member.employeeId === person.id)) continue
      const site = await facts.site(scan.siteId)
      const day = await facts.dayAt(scan.siteId, momentOf(scan))
      if (day < first || day > last || !paysOn(site.windows, day)) continue
      const hold = await db.heldScan.findFirst({ where: { operationScanId: scan.id }, select: { id: true, status: true } })
      if (hold && hold.status !== 'COUNTED') continue
      const work = (await workOfScans(db, [scan])).get(scan.id)!
      const rate = work.operationId ? rateFor(await facts.ratesAt(scan.siteId), { day, operationId: work.operationId, styleId: work.styleId, lineId: work.lineId, size: work.size }) : null
      if (!rate) continue
      const scheme = await facts.schemeFor(site.companyId, work.lineId, day)
      const drafts = await teamDrafts(db, { scan, day, work, pieces: pieces.get(scan.id)!, rate, scheme, members: team, heldScanId: hold?.id ?? null })
      out.push(...drafts.filter((draft) => draft.employeeId === person.id))
    }
  }
  return out
}

interface PaidMinutes {
  readonly days: readonly (PaidDay & { readonly day: BusinessDate; readonly siteId: string })[]
  readonly ordinary: number
  readonly overtime: number
}

/** The minutes that pay: ordinary, and overtime a person approved; inside the window, under each day's scheme. */
async function paidMinutes(db: Client, facts: PayFacts, person: PersonRow, period: PeriodRecord): Promise<PaidMinutes | null> {
  const range = { gte: period.periodStart, lte: period.periodEnd }
  const [days, overtime, skills] = await Promise.all([
    db.attendanceDay.findMany({ where: { employeeId: person.id, date: range }, select: { date: true, siteId: true, ordinaryMinutes: true } }),
    db.overtimeEntry.findMany({ where: { employeeId: person.id, date: range, status: 'APPROVED' }, select: { date: true, minutes: true } }),
    db.employeeSkill.findMany({ where: { employeeId: person.id, traineeUntil: { not: null }, removedAt: null }, select: { since: true, traineeUntil: true, signedOffOn: true } }),
  ])
  if (days.length === 0) return null
  const spans: TraineeSpan[] = skills.map((row) => ({ since: dayOf(row.since), traineeUntil: dayOf(row.traineeUntil!), signedOffOn: dayOrNull(row.signedOffOn) }))
  const approved = new Map<string, number>()
  for (const row of overtime) approved.set(dayOf(row.date), (approved.get(dayOf(row.date)) ?? 0) + row.minutes)
  const out: (PaidDay & { day: BusinessDate; siteId: string })[] = []
  let ordinary = 0
  let extra = 0
  for (const row of days) {
    const day = dayOf(row.date)
    const site = await facts.site(row.siteId)
    if (!paysOn(site.windows, day)) continue
    const scheme = await facts.schemeFor(person.companyId, person.homeLineId, day)
    const over = approved.get(day) ?? 0
    const minutes = row.ordinaryMinutes + over
    if (!scheme || minutes === 0) continue
    ordinary += row.ordinaryMinutes
    extra += over
    out.push({ day, siteId: row.siteId, scheme, minutes, trainee: traineeOn(spans, day) })
  }
  return { days: out, ordinary, overtime: extra }
}

/** Rework or scrap of one of the person's scans that its reasons put down to others: the minutes to pay as time. */
interface OthersFault {
  readonly scan: ScanRecord
  readonly what: 'REWORK' | 'SCRAP'
  readonly day: BusinessDate
  readonly minutes: number
  readonly scheme: SchemeRow
  readonly workerId: string
}

/**
 * The person's own standing scans of the month (not a team's: a team's rework and scrap pay nothing by themselves, as before)
 * whose rework or scrap their reasons put down to others (MES-258; ScrapReason.fault): the garments' standard minutes, inside
 * the window, on a scan not held, under a scheme that pays by the piece. Counts: the garments put down to others.
 */
async function othersFaultOf(db: Client, facts: PayFacts, period: PeriodRecord, scans: readonly ScanRecord[]): Promise<{ readonly lines: OthersFault[]; readonly scrap: number; readonly rework: number }> {
  const voided = voidedScans(scans)
  const standing = scans.filter((scan) => isPaidScan(scan.kind) && !voided.has(scan.id) && scan.scrapQuantity + scan.reworkQuantity > 0)
  if (standing.length === 0) return { lines: [], scrap: 0, rework: 0 }
  const [defects, members, work, holds] = await Promise.all([
    defectsOfScans(db, standing.map((scan) => scan.id)),
    membersOfScans(db, standing),
    workOfScans(db, standing),
    db.heldScan.findMany({ where: { operationScanId: { in: standing.map((scan) => scan.id) } }, select: { operationScanId: true, status: true } }),
  ])
  const first = dayOf(period.periodStart)
  const last = dayOf(period.periodEnd)
  const lines: OthersFault[] = []
  let scrap = 0
  let rework = 0
  for (const scan of standing) {
    const faults = defectsByFault(scan, defects.get(scan.id) ?? [])
    scrap += faults.SCRAP.OTHERS
    rework += faults.REWORK.OTHERS
    if ((members.get(scan.id) ?? []).length >= 2 || !scan.workerId) continue
    const hold = holds.find((row) => row.operationScanId === scan.id)
    if (hold && hold.status !== 'COUNTED') continue
    const day = await facts.dayAt(scan.siteId, momentOf(scan))
    const site = await facts.site(scan.siteId)
    if (day < first || day > last || !paysOn(site.windows, day)) continue
    const scanWork = work.get(scan.id)!
    const scheme = await facts.schemeFor(site.companyId, scanWork.lineId, day)
    if (!scheme || !paysByPiece(scheme)) continue
    for (const what of ['REWORK', 'SCRAP'] as const) {
      const minutes = defectMinutesOf(faults[what].OTHERS, scanWork.standardMinutes)
      if (minutes > 0) lines.push({ scan, what, day, minutes, scheme, workerId: scan.workerId })
    }
  }
  return { lines, scrap, rework }
}

/** What each scan line of the month is worth to a standard-minute bonus (B-W2b-84): this month's SCAN lines and team shares. */
async function bonusWorkOf(db: Client, facts: PayFacts, companyId: string, rows: readonly EntryRecord[], shares: readonly EntryDraft[]): Promise<BonusWork[]> {
  const scanLines = rows.filter((row) => row.kind === 'SCAN' && row.correctsPeriodId === null && row.operationScanId !== null && row.pieces !== null && row.rate !== null)
  const ids = [...new Set([...scanLines.map((row) => row.operationScanId!), ...shares.flatMap((draft) => (draft.operationScanId ? [draft.operationScanId] : []))])]
  if (ids.length === 0) return []
  const work = await workOfScans(db, await db.operationScan.findMany({ where: { id: { in: ids } }, select: SCAN_SELECT }))
  const out: BonusWork[] = []
  const add = async (scanId: string, day: BusinessDate, pieces: number, rate: string, sharePct: string | null) => {
    const scanWork = work.get(scanId)
    if (!scanWork) return
    const scheme = await facts.schemeFor(companyId, scanWork.lineId, day)
    if (scheme && !paysByPiece(scheme)) out.push({ scheme, pieces, standardMinutes: scanWork.standardMinutes, rate, sharePct })
  }
  for (const row of scanLines) await add(row.operationScanId!, dayOf(row.workDate), row.pieces!, row.rate!.toString(), null)
  for (const draft of shares) if (draft.operationScanId && draft.pieces !== null && draft.rate !== null) await add(draft.operationScanId, draft.workDate, draft.pieces, draft.rate, draft.sharePct ?? null)
  return out
}

const line = (entry: EntryRecord, work: { code: string; name: string; standardMinutes: string } | null, code: string | null, corrects: ReadonlyMap<string, string>, measuresBonus: boolean): PayLine => ({
  kind: entry.kind,
  measuresBonus,
  operationCode: work?.code ?? null,
  operationName: work?.name ?? null,
  standardMinutes: work?.standardMinutes ?? null,
  pieces: entry.pieces,
  minutes: decimalOf(entry.minutes),
  rate: decimalOf(entry.rate),
  sharePct: decimalOf(entry.sharePct),
  amount: entry.amount,
  code,
  correctsMonth: entry.correctsPeriodId ? (corrects.get(entry.correctsPeriodId) ?? null) : null,
  words: entry.reason,
})

/** Computes one person's period; books what `book` says; keeps the DRAFT statement in step. Inside the caller's command. */
export async function syncPersonInCommand(tools: CommandTools, facts: PayFacts, period: PeriodRecord, person: PersonRow, options: { readonly book: boolean }): Promise<PersonRun> {
  const { tx } = tools
  const workers = await tx.worker.findMany({ where: { employeeId: person.id }, select: { id: true, siteId: true } })
  const { scans, stale } = await ownScans(tx, facts, workers.map((row) => row.id), period, person.companyId)
  let added = 0
  let reversed = 0
  for (const ref of stale) {
    const moved = await syncBundleInCommand(tools, facts, ref)
    added += moved.added
    reversed += moved.reversed
  }
  const first = dayOf(period.periodStart)
  const month = monthOfPeriod(period)

  const shares = await teamShares(tx, facts, person, period)
  const minutes = await paidMinutes(tx, facts, person, period)

  // What the period's rows hold now (read after the sync above).
  const ledger = await tx.earningsEntry.findMany({ where: { payPeriodId: period.id, employeeId: person.id }, select: ENTRY_SELECT, orderBy: [{ workDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  const scanEarned = ledger.filter((row) => isScanFamily(baseKey(reversalBase(row, ledger))) && !row.correctsPeriodId).reduce((sum, row) => sum + row.amount, 0)
  const currency = ledger[0]?.currency ?? shares[0]?.currency ?? minutes?.days[0]?.scheme.currency ?? 'EUR'

  // Paid time: this month's blocks, and blocks of earlier locked months decided since.
  const lateFrom = plusDays(first, -LATE_DAYS)
  const blocks = await tx.offStandardEntry.findMany({ where: { employeeId: person.id, workDate: { gte: dateOf(lateFrom), lte: period.periodEnd }, status: 'APPROVED', endedAt: { not: null } }, select: { id: true, siteId: true, lineId: true, workerId: true, codeId: true, source: true, workDate: true, startedAt: true, endedAt: true } })
  const codes = blocks.length === 0 ? [] : await tx.offStandardCode.findMany({ where: { id: { in: [...new Set(blocks.map((row) => row.codeId))] } }, select: CODE_SELECT })
  const codeBy = new Map(codes.map((row) => [row.id, row]))
  const waitingCodes = new Set(blocks.length === 0 ? [] : (await tx.helpCallType.findMany({ where: { offStandardCodeId: { in: [...codeBy.keys()] } }, select: { offStandardCodeId: true } })).map((row) => row.offStandardCodeId))
  const blockMinutes = blocks.filter((row) => dayOf(row.workDate) >= first).reduce((sum, row) => sum + minutesOf(row.startedAt, row.endedAt), 0)
  const shareEarned = shares.reduce((sum, draft) => sum + draft.amount, 0)
  const pieceEarned = scanEarned + shareEarned
  const presentTotal = minutes ? minutes.days.reduce((sum, day) => sum + day.minutes, 0) : 0
  // Rework and scrap caused by others are time off standard work, as waiting is: not in the average's minutes.
  const others = await othersFaultOf(tx, facts, period, scans)
  const othersMinutes = others.lines.reduce((sum, item) => sum + item.minutes, 0)
  const average = averagePerMinuteOf({ earned: Math.max(0, pieceEarned), minutes: Math.max(0, presentTotal - blockMinutes - othersMinutes), currency })
  const time: EntryDraft[] = []
  for (const block of blocks) {
    const day = dayOf(block.workDate)
    const site = await facts.site(block.siteId)
    const code = codeBy.get(block.codeId)
    const paidMinutesOf = minutesOf(block.startedAt, block.endedAt)
    if (!code || !block.workerId || !paysOn(site.windows, day) || paidMinutesOf === 0) continue
    const late = day < first
    if (late) {
      // An earlier month: only once it is locked, and into the first period open after it.
      const place = await placeOf(tools, person.companyId, day)
      if (place.correctsPeriodId === null || place.period.id !== period.id) continue
    }
    const scheme = await facts.schemeFor(person.companyId, block.lineId ?? person.homeLineId, day)
    const rule = scheme ? paidRuleOf({ waiting: block.source === 'HELP_CALL' || waitingCodes.has(block.codeId), payRule: code.payRule as 'AVERAGE' | 'BASE' | 'UNPAID' }, scheme) : null
    // A bonus scheme's guaranteed pay covers every minute present, this block's too.
    if (!scheme || !rule || !paysByPiece(scheme)) continue
    const paid = paidTimeOf(scheme, { rule, minutes: paidMinutesOf, averagePerMinute: late ? null : average })
    time.push({ key: entryKey.block(block.id), kind: 'OFF_STANDARD', siteId: block.siteId, employeeId: person.id, workerId: block.workerId, workDate: day, pieces: null, minutes: new Dec(paid.minutes).toFixed(3), rate: paid.ratePerMinute, amount: paid.amount, currency: scheme.currency, sourceType: 'OffStandardEntry', sourceId: block.id })
  }
  for (const item of others.lines) {
    const paid = defectPayOf(item.scheme, { what: item.what, fault: 'OTHERS', pieces: 0, ratePerPiece: '0', minutes: item.minutes, averagePerMinute: average })
    if (paid.pays !== 'TIME') continue
    time.push({ key: entryKey.others(item.scan.id, item.what), kind: 'OFF_STANDARD', siteId: item.scan.siteId, employeeId: person.id, workerId: item.workerId, workDate: item.day, pieces: null, minutes: new Dec(paid.time.minutes).toFixed(3), rate: paid.time.ratePerMinute, amount: paid.amount, currency: item.scheme.currency, sourceType: 'OperationScan', sourceId: item.scan.id })
  }
  const timeEarned = time.filter((draft) => draft.workDate >= first).reduce((sum, draft) => sum + draft.amount, 0)

  // The make-up, on the last paid day of a site where the person has a floor sign-in.
  const makeUp = minutes ? periodMakeUp(minutes.days, pieceEarned + timeEarned) : null
  const makeUpDay = minutes ? [...minutes.days].sort((a, b) => b.day.localeCompare(a.day)).find((day) => workers.some((worker) => worker.siteId === day.siteId)) : undefined
  const makeUpDrafts: EntryDraft[] =
    makeUp && makeUp.makeUp > 0 && makeUpDay
      ? [{ key: entryKey.makeUp(period.id, person.id), kind: 'MAKE_UP', siteId: makeUpDay.siteId, employeeId: person.id, workerId: workers.find((worker) => worker.siteId === makeUpDay.siteId)!.id, workDate: makeUpDay.day, pieces: null, minutes: new Dec(makeUp.minutes).toFixed(3), rate: makeUp.ratePerMinute, amount: makeUp.makeUp, currency }]
      : []

  // The standard-minute bonus, on the same day as the make-up. No minutes present (no clock): none (BONUS_NO_CLOCK holds the review).
  const bonus = minutes ? periodBonus(minutes.days, await bonusWorkOf(tx, facts, person.companyId, ledger, shares)) : null
  const bonusDrafts: EntryDraft[] =
    bonus && bonus.amount > 0 && new Dec(bonus.bonusMinutes).greaterThan(0) && makeUpDay
      ? [{ key: entryKey.bonus(period.id, person.id), kind: 'BONUS', siteId: makeUpDay.siteId, employeeId: person.id, workerId: workers.find((worker) => worker.siteId === makeUpDay.siteId)!.id, workDate: makeUpDay.day, pieces: null, minutes: bonus.bonusMinutes, rate: null, amount: bonus.amount, currency }]
      : []

  // A source a person corrected pays no more by itself: neither here nor on the statement.
  const computed = [...shares, ...time, ...makeUpDrafts, ...bonusDrafts]
  const familyRows = ledger.filter((row) => !row.reversalOfId && isPeriodFamily(baseKey(row.idempotencyKey)))
  const existing = await entriesOfKeys(tx, [...computed.map((draft) => draft.key), ...familyRows.map((row) => row.idempotencyKey)])
  const frozen = frozenBases(existing.map(ledgerRowOf))
  const wanted = computed.filter((draft) => !frozen.has(draft.key))
  const wantedKeys = new Set(wanted.map((draft) => draft.key))
  if (options.book) {
    const plan = planLedger(existing.map(ledgerRowOf), wanted, (key) => isPeriodFamily(key) && familyRows.some((row) => baseKey(row.idempotencyKey) === key))
    const moved = await applyPlan(tools, person.companyId, plan, existing, PERIOD_FIGURE_WORDS)
    added += moved.added
    reversed += moved.reversed
  }

  // The statement: the ledger's scan lines and corrections, and this computation's period figures.
  const rows = await tx.earningsEntry.findMany({ where: { payPeriodId: period.id, employeeId: person.id }, select: ENTRY_SELECT, orderBy: [{ workDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  const kept = rows.filter((row) => {
    const base = baseKey(reversalBase(row, rows))
    return !isPeriodFamily(base) || (row.correctsPeriodId !== null && !wantedKeys.has(base))
  })
  const scanIds = [...new Set([...kept, ...wanted].flatMap((row) => (row.operationScanId ? [row.operationScanId] : [])))]
  const scanRows = scanIds.length === 0 ? [] : await tx.operationScan.findMany({ where: { id: { in: scanIds } }, select: SCAN_SELECT })
  const work = await workOfScans(tx, scanRows)
  const correctedIds = [...new Set(kept.flatMap((row) => (row.correctsPeriodId ? [row.correctsPeriodId] : [])))]
  const corrected = new Map((correctedIds.length === 0 ? [] : await tx.payPeriod.findMany({ where: { id: { in: correctedIds } }, select: { id: true, periodStart: true } })).map((row) => [row.id, monthOfPeriod(row)]))
  const blockCode = new Map(blocks.map((row) => [row.id, codeBy.get(row.codeId)?.code ?? null]))
  const lines: PayLine[] = [
    // A reversal is marked by the line it reverses: the ledger's one writer gave a bonus scheme's pieces BONUS_PIECES_WORDS.
    ...kept.map((row) => line(row, row.operationScanId ? (work.get(row.operationScanId) ?? null) : null, (row.sourceId ? (blockCode.get(row.sourceId) ?? null) : null) ?? othersCodeOf(reversalBase(row, rows)), corrected, (row.reversalOfId ? rows.find((other) => other.id === row.reversalOfId) : row)?.reason === BONUS_PIECES_WORDS)),
    ...wanted
      .filter((draft) => draft.kind !== 'MAKE_UP')
      .map((draft): PayLine => {
        const scanWork = draft.operationScanId ? (work.get(draft.operationScanId) ?? null) : null
        return {
          kind: draft.kind,
          operationCode: scanWork?.code ?? null,
          operationName: scanWork?.name ?? null,
          standardMinutes: scanWork?.standardMinutes ?? null,
          pieces: draft.pieces,
          minutes: draft.minutes,
          rate: draft.rate,
          sharePct: draft.sharePct ?? null,
          amount: draft.amount,
          code: (draft.sourceId ? (blockCode.get(draft.sourceId) ?? null) : null) ?? othersCodeOf(draft.key),
          correctsMonth: draft.workDate < first ? draft.workDate.slice(0, 7) : null,
          words: null,
          measuresBonus: draft.reason === BONUS_PIECES_WORDS,
        }
      }),
  ]
  const held = await tx.heldScan.groupBy({ by: ['status'], where: { payPeriodId: period.id, employeeId: person.id }, _count: { _all: true } })
  const heldOf = (status: string): number => held.find((row) => row.status === status)?._count._all ?? 0
  const disputes = await tx.labourDispute.groupBy({ by: ['status'], where: { employeeId: person.id, workDate: { gte: period.periodStart, lte: period.periodEnd } }, _count: { _all: true } })
  const disputeOf = (status: string): number => disputes.find((row) => row.status === status)?._count._all ?? 0
  const standing = scans.filter((scan) => isPaidScan(scan.kind) && !voidedScans(scans).has(scan.id))
  const built = statementOf({
    currency,
    lines,
    attendance: minutes ? { ordinaryMinutes: minutes.ordinary, approvedOvertimeMinutes: minutes.overtime } : null,
    makeUp: makeUp ? { minutes: makeUp.minutes, ratePerMinute: makeUp.ratePerMinute, guaranteed: makeUp.guaranteed, earned: makeUp.earned, amount: wanted.some((draft) => draft.kind === 'MAKE_UP') ? makeUp.makeUp : 0 } : null,
    held: { open: heldOf('OPEN'), counted: heldOf('COUNTED'), notPaid: heldOf('NOT_PAID') },
    disputes: { open: disputeOf('OPEN'), answered: disputeOf('UPHELD') + disputeOf('REJECTED') },
    defects: { scrap: standing.reduce((sum, scan) => sum + scan.scrapQuantity, 0), rework: standing.reduce((sum, scan) => sum + scan.reworkQuantity, 0), othersScrap: others.scrap, othersRework: others.rework },
    bonus: bonus ? { ...bonus, amount: wanted.some((draft) => draft.kind === 'BONUS') ? bonus.amount : 0 } : null,
  })
  const statementId = await writeStatement(tools, period, person, built, month)
  return { statementId, added, reversed, built }
}

/** The key a row is about: its own, or for a reversal the key of the entry it reverses. */
function reversalBase(row: EntryRecord, rows: readonly EntryRecord[]): string {
  if (!row.reversalOfId) return row.idempotencyKey
  return rows.find((other) => other.id === row.reversalOfId)?.idempotencyKey ?? row.idempotencyKey
}

/** The one live statement of a person and period: a DRAFT follows the figures; an APPROVED one that no longer matches is superseded by a new revision. */
async function writeStatement(tools: CommandTools, period: PeriodRecord, person: PersonRow, built: BuiltStatement, month: string): Promise<string> {
  const { tx } = tools
  const live = await tx.workerStatement.findFirst({ where: { payPeriodId: period.id, employeeId: person.id, status: { not: 'SUPERSEDED' } }, orderBy: { revision: 'desc' }, select: { id: true, status: true, revision: true, earningsAmount: true, makeUpAmount: true, summary: true } })
  const place = { companyId: person.companyId, siteId: person.siteId }
  const data = { summary: toJson({ ...built.summary, leadReview: leadReviewOf(live?.summary) }), earningsAmount: built.earningsAmount, makeUpAmount: built.makeUpAmount, currency: built.summary.currency }
  if (live?.status === 'DRAFT') {
    await tx.workerStatement.update({ where: { id: live.id }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    return live.id
  }
  if (live && live.earningsAmount === built.earningsAmount && live.makeUpAmount === built.makeUpAmount) return live.id
  if (live) await tx.workerStatement.update({ where: { id: live.id }, data: { status: 'SUPERSEDED', supersededAt: tools.now, version: { increment: 1 } }, select: { id: true } })
  const id = newId()
  const revision = (live?.revision ?? 0) + 1
  await tx.workerStatement.create({ data: { id, ...place, payPeriodId: period.id, employeeId: person.id, revision, status: 'DRAFT', ...data, summary: toJson({ ...built.summary, leadReview: null }), createdById: actorIdOf(tools.context) }, select: { id: true } })
  tools.audit({ action: 'people.makeWorkerStatement', recordType: 'WorkerStatement', recordId: id, ...place, after: { periodId: period.id, month, employeeId: person.id, revision, status: 'DRAFT' } })
  tools.emit({ type: 'worker_statement.changed', subject: id, ...place, payload: { statementId: id, periodId: period.id, siteId: person.siteId, status: 'DRAFT', revision, change: 'MADE' } })
  return id
}

export const leadReviewOf = (summary: unknown): unknown => (summary && typeof summary === 'object' && 'leadReview' in summary ? (summary as { leadReview: unknown }).leadReview : null)

const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as object

/**
 * The total a person's ledger holds in a period (what a statement must match). A make-up of an earlier month corrected in
 * this period is a correction, not this month's make-up: the statement counts it with the earnings too.
 */
export async function ledgerSums(db: Client, periodId: string): Promise<Map<string, { readonly earnings: MinorUnits; readonly makeUp: MinorUnits }>> {
  const rows = await db.earningsEntry.groupBy({ by: ['employeeId', 'kind', 'correctsPeriodId'], where: { payPeriodId: periodId }, _sum: { amount: true } })
  const out = new Map<string, { earnings: number; makeUp: number }>()
  for (const row of rows) {
    const sums = out.get(row.employeeId) ?? { earnings: 0, makeUp: 0 }
    if (row.kind === 'MAKE_UP' && row.correctsPeriodId === null) sums.makeUp += row._sum.amount ?? 0
    else sums.earnings += row._sum.amount ?? 0
    out.set(row.employeeId, sums)
  }
  return out
}
