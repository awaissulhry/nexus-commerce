/**
 * CX A2 — what the Finances 2024 dry run reports besides identity overlap. Pure accumulators.
 *
 * The shape census counts transactions by type, status and breakdown path, and every mapping
 * outcome by name. It carries NO amounts and NO identifiers: provider labels are reported only when
 * they look like vocabulary, and each map is bounded, so a malformed label cannot smuggle an id out.
 *
 * Cents parity compares, per matched order and transaction type, what the mapped 2024 transactions
 * would store against what v0 already stored, column by column, in exact hundredths. It is a
 * measurement for the cutover decision, not a reconciliation and not an approval to write.
 */
import {
  minorToDecimal, statusRank, toHundredths,
  type Finances2024Mapping, type Finances2024Row,
} from './amazon-finances-2024-mapping.js'

export const PARITY_COLUMNS = ['amount', 'grossRevenue', 'netRevenue', 'amazonFee', 'fbaFee', 'otherFees'] as const
export type ParityColumn = typeof PARITY_COLUMNS[number]

const LABEL = /^[A-Za-z][A-Za-z0-9 _&\-/().,']{0,63}$/
const MAX_KEYS = 100
// Vocabulary, not data: a label with a run of digits could be an order or transaction id.
function label(value: string | null): string { return value === null ? '(missing)' : LABEL.test(value) && !/\d{3,}/.test(value) ? value : '(unlisted)' }
function pathLabel(path: string): string {
  const item = path.startsWith('item: ')
  const segments = (item ? path.slice(6) : path).split(' > ').map(segment => label(segment))
  return `${item ? 'item: ' : ''}${segments.join(' > ')}`
}
function bump(map: Record<string, number>, key: string) {
  const bounded = key in map || Object.keys(map).length < MAX_KEYS ? key : '(other)'
  map[bounded] = (map[bounded] ?? 0) + 1
}

export interface FinancesCensusReport {
  transactions: number
  byType: Record<string, number>
  byStatus: Record<string, number>
  byTypeAndStatus: Record<string, number>
  breakdownPaths: Record<string, number>
  outcomes: { mapped: number; counted: number; refused: number }
  counted: Record<string, number>
  /** Refusals and invariant failures (sum, currency, precision, vocabulary), by name. */
  refusals: Record<string, number>
  /** One transactionId seen with more than one status during this run; counted once, latest status. */
  statusChangesWithinRun: number
}

export class FinancesCensus {
  private report: FinancesCensusReport = {
    transactions: 0, byType: {}, byStatus: {}, byTypeAndStatus: {}, breakdownPaths: {},
    outcomes: { mapped: 0, counted: 0, refused: 0 }, counted: {}, refusals: {}, statusChangesWithinRun: 0,
  }

  /** Call once per DISTINCT transactionId, with its superseding status. */
  add(mapping: Finances2024Mapping) {
    const r = this.report
    r.transactions++
    const type = label(mapping.transactionType), status = label(mapping.transactionStatus)
    bump(r.byType, type)
    bump(r.byStatus, status)
    bump(r.byTypeAndStatus, `${type}/${status}`)
    for (const path of new Set(mapping.paths.map(pathLabel))) bump(r.breakdownPaths, path)
    if (mapping.kind === 'row') r.outcomes.mapped++
    else if (mapping.kind === 'counted') { r.outcomes.counted++; bump(r.counted, mapping.reason) } else { r.outcomes.refused++; bump(r.refusals, mapping.reason) }
  }

  statusChanged() { this.report.statusChangesWithinRun++ }
  toJSON(): FinancesCensusReport { return structuredClone(this.report) }
}

interface Side { currency: string; columns: Record<ParityColumn, bigint> }
export interface ColumnParity { equal: number; different: number; v0Only: number; newOnly: number; absDelta: string; v0OnlyAbs: string; newOnlyAbs: string }
export interface CentsParityReport {
  scope: 'cents_parity_for_matched_orders_by_type_not_reconciliation'
  comparedKeys: number
  byCurrency: Record<string, Record<ParityColumn, ColumnParity>>
  currencyMismatches: number
  /** Mapped rows kept out of the comparison, and why: v0 never sees a deferred transaction. */
  excluded: { deferred: number }
}

/** A v0 row as read back: the numeric columns as Prisma returns them (Decimal, number or string). */
export interface V0ParityRow {
  orderId: string; transactionType: string; currencyCode: string
  amount: unknown; grossRevenue: unknown; netRevenue: unknown; amazonFee: unknown; fbaFee: unknown; otherFees: unknown
}

/** Exact hundredths of a stored numeric(…,2) value. A value with more precision is not one of ours. */
export function storedHundredths(value: unknown): bigint {
  const text = value !== null && typeof value === 'object' && typeof (value as { toFixed?: unknown }).toFixed === 'function'
    ? (value as { toFixed(places: number): string }).toFixed(2)
    : String(value)
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) throw new Error('A stored financial amount is not a two-decimal number; parity cannot compare it.')
  const hundredths = BigInt(match[2]! + (match[3] ?? '').padEnd(2, '0'))
  return match[1] ? -hundredths : hundredths
}

export class CentsParity {
  private next = new Map<string, Side | 'mixed'>()
  private v0 = new Map<string, Side | 'mixed'>()
  private deferred = 0

  private static add(map: Map<string, Side | 'mixed'>, key: string, currency: string, columns: Record<ParityColumn, bigint>) {
    const current = map.get(key)
    if (current === 'mixed') return
    if (!current) { map.set(key, { currency, columns: { ...columns } }); return }
    if (current.currency !== currency) { map.set(key, 'mixed'); return }
    for (const column of PARITY_COLUMNS) current.columns[column] += columns[column]
  }

  /** A mapped 2024 row whose order matched in the selected account. Deferred money is excluded. */
  addNew(orderId: string, row: Finances2024Row) {
    if (row.transactionStatus === 'DEFERRED') { this.deferred++; return }
    const columns = Object.fromEntries(PARITY_COLUMNS.map(column => [column, toHundredths(row.money[column], row.minorUnits)])) as Record<ParityColumn, bigint>
    CentsParity.add(this.next, `${orderId}\u0000${row.transactionType}`, row.currencyCode, columns)
  }

  addV0(row: V0ParityRow) {
    const columns = Object.fromEntries(PARITY_COLUMNS.map(column => [column, storedHundredths(row[column])])) as Record<ParityColumn, bigint>
    CentsParity.add(this.v0, `${row.orderId}\u0000${row.transactionType}`, row.currencyCode, columns)
  }

  toJSON(): CentsParityReport {
    const abs = (v: bigint) => (v < 0n ? -v : v)
    const totals: Record<string, Record<ParityColumn, { equal: number; different: number; v0Only: number; newOnly: number; absDelta: bigint; v0OnlyAbs: bigint; newOnlyAbs: bigint }>> = {}
    let currencyMismatches = 0
    const keys = new Set([...this.next.keys(), ...this.v0.keys()])
    for (const key of keys) {
      const next = this.next.get(key), v0 = this.v0.get(key)
      if (next === 'mixed' || v0 === 'mixed' || (next && v0 && next.currency !== v0.currency)) { currencyMismatches++; continue }
      const currency = (next ?? v0)!.currency
      totals[currency] ??= Object.fromEntries(PARITY_COLUMNS.map(column => [column, { equal: 0, different: 0, v0Only: 0, newOnly: 0, absDelta: 0n, v0OnlyAbs: 0n, newOnlyAbs: 0n }])) as never
      for (const column of PARITY_COLUMNS) {
        const t = totals[currency]![column]
        if (next && v0) {
          const delta = abs(next.columns[column] - v0.columns[column])
          if (delta === 0n) t.equal++; else { t.different++; t.absDelta += delta }
        } else if (v0) { t.v0Only++; t.v0OnlyAbs += abs(v0.columns[column]) } else { t.newOnly++; t.newOnlyAbs += abs(next!.columns[column]) }
      }
    }
    const byCurrency = Object.fromEntries(Object.entries(totals).map(([currency, columns]) => [currency, Object.fromEntries(
      Object.entries(columns).map(([column, t]) => [column, { ...t, absDelta: minorToDecimal(t.absDelta, 2), v0OnlyAbs: minorToDecimal(t.v0OnlyAbs, 2), newOnlyAbs: minorToDecimal(t.newOnlyAbs, 2) }]),
    )])) as CentsParityReport['byCurrency']
    return { scope: 'cents_parity_for_matched_orders_by_type_not_reconciliation', comparedKeys: keys.size, byCurrency, currencyMismatches, excluded: { deferred: this.deferred } }
  }
}

/** The status one transactionId keeps when a run sees it more than once. */
export function supersedes(candidate: string | null | undefined, current: string | null | undefined): boolean {
  return statusRank(candidate ?? null) > statusRank(current ?? null)
}
