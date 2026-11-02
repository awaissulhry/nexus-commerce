import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { ClockFact, ClockFlag, ClockKind, ClockSource } from '@nexus/factory-domain/people/clock/rules'
import { CLOCK_RULES } from '@nexus/factory-domain/people/clock/rules'
import { baseKey, type LedgerRow } from '@nexus/factory-domain/people/earnings/ledger'
import { clockAt, clockRuleApplies, windowsOf, type ClockAt, type PayWindow, type RateCandidate } from '@nexus/factory-domain/people/earnings/rules'
import { monthPeriod } from '@nexus/factory-domain/people/overtime/timesheets'
import type { PeriodStatus, SchemeRow } from '@nexus/factory-domain/people/schemes/rules'
import { schemeFor } from '@nexus/factory-domain/people/schemes/rules'
import { believedTime } from '@nexus/factory-domain/production/offstandard/rules'
import type { Client } from '../attendance/store'
import { dateOf, dayOf, dayOrNull } from '../employees/access'
import { legalGateFor, type GateReader } from '../privacy/gate'
import { SCHEME_SELECT, schemeRowOf } from '../schemes/store'

/**
 * What earnings read (B-W2b-43), office or system scope; every read names its columns. A scan's moment is the one the
 * tablet can be believed about (an offline scan keeps its own time), and its work day is the site's day of that moment.
 */

export const PERIOD_SELECT = {
  id: true,
  companyId: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  previewedAt: true,
  reviewStartedAt: true,
  lockedAt: true,
  lockNote: true,
  version: true,
} as const satisfies Prisma.PayPeriodSelect
export type PeriodRecord = Prisma.PayPeriodGetPayload<{ select: typeof PERIOD_SELECT }>

export const monthOfPeriod = (row: Pick<PeriodRecord, 'periodStart'>): string => dayOf(row.periodStart).slice(0, 7)
export const periodStatus = (row: Pick<PeriodRecord, 'status'>): PeriodStatus => row.status as PeriodStatus

export async function periodById(db: Client, periodId: string): Promise<PeriodRecord | null> {
  return isUuid(periodId) ? db.payPeriod.findUnique({ where: { id: periodId }, select: PERIOD_SELECT }) : null
}

export async function periodOfMonth(db: Client, companyId: string, month: string): Promise<PeriodRecord | null> {
  const bounds = monthPeriod(month)
  if (!bounds) throw new NotFoundError('Pay period not found.')
  return db.payPeriod.findFirst({ where: { companyId, periodStart: dateOf(bounds.periodStart) }, select: PERIOD_SELECT })
}

export const ENTRY_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  payPeriodId: true,
  employeeId: true,
  workerId: true,
  workDate: true,
  kind: true,
  operationScanId: true,
  rateEntryId: true,
  pieces: true,
  minutes: true,
  rate: true,
  sharePct: true,
  amount: true,
  currency: true,
  heldScanId: true,
  sourceType: true,
  sourceId: true,
  correctsPeriodId: true,
  reversalOfId: true,
  reason: true,
  idempotencyKey: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.EarningsEntrySelect
export type EntryRecord = Prisma.EarningsEntryGetPayload<{ select: typeof ENTRY_SELECT }>

const decimal = (value: { toString(): string } | null): string | null => (value === null ? null : value.toString())

export const ledgerRowOf = (row: EntryRecord): LedgerRow => ({ id: row.id, idempotencyKey: row.idempotencyKey, pieces: row.pieces, minutes: decimal(row.minutes), rate: decimal(row.rate), amount: row.amount, reversalOfId: row.reversalOfId })
export const decimalOf = decimal

/** Every entry whose key's base is one of these, and their reversals (the reversal's key does not carry the base). */
export async function entriesOfKeys(db: Client, keys: readonly string[]): Promise<EntryRecord[]> {
  if (keys.length === 0) return []
  const bases = [...new Set(keys.map(baseKey))]
  const originals = await db.earningsEntry.findMany({ where: { OR: bases.flatMap((base) => [{ idempotencyKey: base }, { idempotencyKey: { startsWith: `${base}#` } }]) }, select: ENTRY_SELECT })
  return withReversals(db, originals)
}

export async function withReversals(db: Client, originals: readonly EntryRecord[]): Promise<EntryRecord[]> {
  if (originals.length === 0) return []
  const reversals = await db.earningsEntry.findMany({ where: { reversalOfId: { in: originals.map((row) => row.id) } }, select: ENTRY_SELECT })
  return [...originals, ...reversals]
}

export const SCAN_SELECT = {
  id: true,
  siteId: true,
  kind: true,
  correctsId: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  workOrderId: true,
  workOrderOperationId: true,
  bundleId: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  deviceTime: true,
  serverTime: true,
} as const satisfies Prisma.OperationScanSelect
export type ScanRecord = Prisma.OperationScanGetPayload<{ select: typeof SCAN_SELECT }>

/** The moment that counts for a scan: the tablet's, when its clock can be believed. */
export const momentOf = (scan: Pick<ScanRecord, 'deviceTime' | 'serverTime'>): Date => believedTime(scan.deviceTime, scan.serverTime)

/** Where and what a scan's work was: the facts its rate and scheme depend on. */
export interface WorkFacts {
  readonly operationId: string | null
  readonly code: string
  readonly name: string
  readonly standardMinutes: string
  readonly styleId: string
  readonly size: string
  readonly lineId: string | null
  readonly bundleCode: string
}

/** The work of each scan (read together: a period reads hundreds). */
export async function workOfScans(db: Client, scans: readonly ScanRecord[]): Promise<Map<string, WorkFacts>> {
  if (scans.length === 0) return new Map()
  const unique = <T>(values: readonly (T | null)[]): T[] => [...new Set(values.filter((value): value is T => value !== null))]
  const [operations, workOrders, bundles, stations, devices] = await Promise.all([
    db.workOrderOperation.findMany({ where: { id: { in: unique(scans.map((scan) => scan.workOrderOperationId)) } }, select: { id: true, code: true, name: true, standardMinutes: true, routingOperation: { select: { operationId: true } } } }),
    db.workOrder.findMany({ where: { id: { in: unique(scans.map((scan) => scan.workOrderId)) } }, select: { id: true, styleId: true } }),
    db.bundle.findMany({ where: { id: { in: unique(scans.map((scan) => scan.bundleId)) } }, select: { id: true, code: true, workOrderSize: { select: { size: true } } } }),
    db.station.findMany({ where: { id: { in: unique(scans.map((scan) => scan.stationId)) } }, select: { id: true, lineId: true } }),
    db.device.findMany({ where: { id: { in: unique(scans.map((scan) => scan.deviceId)) } }, select: { id: true, lineId: true } }),
  ])
  const operationBy = new Map(operations.map((row) => [row.id, row]))
  const workOrderBy = new Map(workOrders.map((row) => [row.id, row]))
  const bundleBy = new Map(bundles.map((row) => [row.id, row]))
  const stationBy = new Map(stations.map((row) => [row.id, row]))
  const deviceBy = new Map(devices.map((row) => [row.id, row]))
  return new Map(
    scans.map((scan) => {
      const operation = operationBy.get(scan.workOrderOperationId)!
      const bundle = bundleBy.get(scan.bundleId)!
      const lineId = (scan.stationId ? stationBy.get(scan.stationId)?.lineId : null) ?? (scan.deviceId ? deviceBy.get(scan.deviceId)?.lineId : null) ?? null
      return [scan.id, { operationId: operation.routingOperation.operationId, code: operation.code, name: operation.name, standardMinutes: operation.standardMinutes.toString(), styleId: workOrderBy.get(scan.workOrderId)!.styleId, size: bundle.workOrderSize.size, lineId, bundleCode: bundle.code }]
    }),
  )
}

/** The members of a team scan: its own, else those of the report it corrects. */
export async function membersOfScans(db: Client, scans: readonly Pick<ScanRecord, 'id' | 'correctsId'>[]): Promise<Map<string, { workerId: string; employeeId: string | null }[]>> {
  const out = new Map<string, { workerId: string; employeeId: string | null }[]>()
  let round = scans.map((scan) => ({ scanId: scan.id, at: scan.id, correctsId: scan.correctsId }))
  while (round.length > 0) {
    const rows = await db.operationScanMember.findMany({ where: { scanId: { in: round.map((item) => item.at) } }, select: { scanId: true, workerId: true, employeeId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const byScan = new Map<string, { workerId: string; employeeId: string | null }[]>()
    for (const row of rows) byScan.set(row.scanId, [...(byScan.get(row.scanId) ?? []), { workerId: row.workerId, employeeId: row.employeeId }])
    const next: typeof round = []
    for (const item of round) {
      const members = byScan.get(item.at)
      if (members) out.set(item.scanId, members)
      else if (item.correctsId) next.push({ scanId: item.scanId, at: item.correctsId, correctsId: null })
    }
    if (next.length === 0) break
    const parents = await db.operationScan.findMany({ where: { id: { in: next.map((item) => item.at) } }, select: { id: true, correctsId: true } })
    const parentBy = new Map(parents.map((row) => [row.id, row.correctsId]))
    round = next.map((item) => ({ ...item, correctsId: parentBy.get(item.at) ?? null }))
  }
  return out
}

const clockFact = (row: { id: string; kind: string; source: string; occurredAt: Date; voidsEventId: string | null; flags: string[] }): ClockFact => ({ id: row.id, kind: row.kind as ClockKind, source: row.source as ClockSource, occurredAt: row.occurredAt, voidsEventId: row.voidsEventId, flags: row.flags as ClockFlag[] })

/** Where a person stood at a moment. By employee, never by floor worker: a MANUAL clock event names no worker. */
export async function clockOf(db: Client, employeeId: string, at: Date): Promise<ClockAt> {
  const from = new Date(at.getTime() - CLOCK_RULES.readBackHours * 3_600_000)
  const rows = await db.clockEvent.findMany({ where: { employeeId, occurredAt: { gte: from } }, select: { id: true, kind: true, source: true, occurredAt: true, voidsEventId: true, flags: true } })
  return clockAt(rows.map(clockFact), at)
}

const RATE_SELECT = { id: true, operationId: true, sizeBand: true, ratePerPiece: true, standardMinutes: true, versionId: true } as const

/** What pay reads about a place, once per run. */
export class PayFacts {
  private readonly sites = new Map<string, { timezone: string; companyId: string; windows: readonly PayWindow[] }>()
  private readonly rates = new Map<string, RateCandidate[]>()
  private readonly schemes = new Map<string, SchemeRow[]>()
  private readonly gates = new Map<string, boolean>()

  constructor(
    private readonly db: Client,
    private readonly now: Date,
  ) {}

  /** A site's time zone and piece-pay windows (none: never on, nothing is paid). */
  async site(siteId: string): Promise<{ timezone: string; companyId: string; windows: readonly PayWindow[] }> {
    const known = this.sites.get(siteId)
    if (known) return known
    const site = await this.db.site.findUniqueOrThrow({ where: { id: siteId }, select: { timezone: true, companyId: true } })
    const row = await this.db.piecePaySwitch.findFirst({ where: { siteId }, select: { onFrom: true, offFrom: true, earlierWindows: true } })
    const found = { ...site, windows: row ? windowsOf({ onFrom: dayOrNull(row.onFrom), offFrom: dayOrNull(row.offFrom), earlierWindows: row.earlierWindows }) : [] }
    this.sites.set(siteId, found)
    return found
  }

  /** Every rate of the site that may pay some day. */
  async ratesAt(siteId: string): Promise<RateCandidate[]> {
    const known = this.rates.get(siteId)
    if (known) return known
    const versions = await this.db.pieceRateVersion.findMany({
      where: { siteId, status: { in: ['PROVISIONAL', 'PUBLISHED', 'SUPERSEDED'] } },
      select: { id: true, status: true, effectiveFrom: true, effectiveTo: true, table: { select: { styleId: true, lineId: true, currency: true } } },
    })
    const entries = versions.length === 0 ? [] : await this.db.pieceRateEntry.findMany({ where: { versionId: { in: versions.map((row) => row.id) } }, select: RATE_SELECT })
    const versionBy = new Map(versions.map((row) => [row.id, row]))
    const found = entries.map((entry): RateCandidate => {
      const version = versionBy.get(entry.versionId)!
      return {
        entryId: entry.id,
        operationId: entry.operationId,
        sizeBand: entry.sizeBand,
        ratePerPiece: entry.ratePerPiece.toString(),
        standardMinutes: decimal(entry.standardMinutes),
        currency: version.table.currency,
        status: version.status,
        effectiveFrom: dayOf(version.effectiveFrom),
        effectiveTo: dayOrNull(version.effectiveTo),
        styleId: version.table.styleId,
        lineId: version.table.lineId,
      }
    })
    this.rates.set(siteId, found)
    return found
  }

  /** The schemes that pay a company's days: ACTIVE, and RETIRED on their own days. */
  async schemesOf(companyId: string): Promise<SchemeRow[]> {
    const known = this.schemes.get(companyId)
    if (known) return known
    const rows = await this.db.incentiveScheme.findMany({ where: { companyId, status: { in: ['ACTIVE', 'RETIRED'] } }, select: SCHEME_SELECT })
    const found = rows.map(schemeRowOf)
    this.schemes.set(companyId, found)
    return found
  }

  async schemeFor(companyId: string, lineId: string | null, day: BusinessDate): Promise<SchemeRow | null> {
    return schemeFor(await this.schemesOf(companyId), lineId, day)
  }

  /** The site's clock may be read (its ATTENDANCE gate is on). */
  async clockReadable(siteId: string): Promise<boolean> {
    const known = this.gates.get(siteId)
    if (known !== undefined) return known
    const { open } = await legalGateFor(this.db as GateReader, siteId, 'ATTENDANCE', this.now)
    this.gates.set(siteId, open)
    return open
  }

  /** The day of a moment at a site. */
  async dayAt(siteId: string, at: Date): Promise<BusinessDate> {
    return businessDate(at, (await this.site(siteId)).timezone)
  }

  /** Does the clocked-in rule apply to this work? */
  async holdsApply(input: { readonly companyId: string; readonly siteId: string; readonly lineId: string | null; readonly day: BusinessDate }): Promise<boolean> {
    const scheme = await this.schemeFor(input.companyId, input.lineId, input.day)
    return clockRuleApplies({ payOnlyWhileClockedIn: scheme?.payOnlyWhileClockedIn ?? null, attendanceGateOpen: await this.clockReadable(input.siteId) })
  }
}
