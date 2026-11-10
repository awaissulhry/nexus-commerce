import {
  answeredOnTime,
  certificateCoverage,
  crViBySupplier,
  decimalText,
  gapsByType,
  monthsOf,
  openGaps,
  pct,
  REPORT_LIMITS,
  registerSummary,
  shippedCoverage,
} from '@nexus/factory-domain/compliance/reports/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { headOf, placeOf, type Place } from './access'
import type { Cr6Query, ExpiriesQuery, GapsQuery, KpisQuery, RegisterQuery } from './contract'
import {
  brandStyleIds,
  crViGapLots,
  crViLotsUsed,
  crViResults,
  expiriesOf,
  gateRefusals,
  matrixOf,
  noticesOf,
  recallsOf,
  registerFacts,
  registerOpenAt,
  requestsOf,
  shippedPairs,
  type Matrix,
} from './facts'

/**
 * The five answers of the compliance reports (B-W2b-272; ANA-025; design compliance.reports SCR-261): the headline numbers
 * (cr-kpi), the open gaps by type (cr-gaps), the expiry calendar (cr-expiry), chromium VI per supplier (cr-cr6) and the
 * register summary (cr-register). The annual review (tab:cr-pdf) is the same five reads for one calendar year. Each answer
 * reads on its own (a panel that fails leaves the others); each figure only from records the reader may see.
 */

const stylesOf = (matrix: Matrix | null) => (matrix ? { read: matrix.styles, more: matrix.more, markets: [...matrix.markets] } : null)

/** GET /compliance/reports/kpis */
export async function kpisAnswer(caller: CommandCaller, query: KpisQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const brandStyles = await brandStyleIds(db, place)
    const matrix = await matrixOf(db, place)
    const coverage = matrix ? { ...certificateCoverage(matrix.cells), cells: matrix.cells.length } : null
    const shipped = matrix && place.sight.shipments ? await shippedPairs(db, place, brandStyles) : null
    const crViGaps = place.sight.lots ? await crViGapLots(db, place) : null
    const used = place.sight.lots ? await crViLotsUsed(db, place) : null
    return {
      ...headOf(place),
      sight: place.sight,
      styles: stylesOf(matrix),
      brands: matrix ? [...matrix.brands] : [],
      kpis: {
        coverage,
        shipped: matrix && shipped ? { ...shippedCoverage(shipped.pairs, matrix.cells), shipments: shipped.shipments } : null,
        gaps: matrix ? { count: openGaps(gapsByType(matrix.missing, crViGaps)), crViCounted: crViGaps !== null } : null,
        refusals: place.sight.certificates ? await gateRefusals(db, place, brandStyles) : null,
        registerOpen: place.sight.register ? await registerOpenAt(db, place, brandStyles) : null,
        crViLots: used ? { ...used, pct: pct(used.withEvidence, used.lots) } : null,
      },
    }
  })
}

/** GET /compliance/reports/gaps — today's open gaps (no period: a gap is open now or not). */
export async function gapsAnswer(caller: CommandCaller, query: GapsQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, { brandId: query.brandId })
    const matrix = await matrixOf(db, place)
    const crViGaps = place.sight.lots ? await crViGapLots(db, place) : null
    return {
      ...headOf(place, { from: place.today, to: place.today }),
      sight: place.sight,
      styles: stylesOf(matrix),
      rows: gapsByType(matrix?.missing ?? [], crViGaps)
        .filter((row) => row.type === 'crVi' || matrix !== null)
        .map((row) => ({ ...row, requirements: [...row.requirements] })),
    }
  })
}

/** GET /compliance/reports/expiries — what stops within the next months (12 unless asked), per month. */
export async function expiriesAnswer(caller: CommandCaller, query: ExpiriesQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, { brandId: query.brandId })
    const months = query.months ?? REPORT_LIMITS.expiryMonths
    const brandStyles = await brandStyleIds(db, place)
    const calendar = await expiriesOf(db, place, months, brandStyles)
    return { ...headOf(place, { from: place.today, to: calendar.end }), sight: place.sight, months: calendar.months, count: calendar.count }
  })
}

/** GET /compliance/reports/cr6 — the chromium VI results of the period per supplier (lots are not per brand: no brand). */
export async function cr6Answer(caller: CommandCaller, query: Cr6Query) {
  return caller.withClient(async (db) => {
    const place: Place = { ...(await placeOf(db, caller, query)), brand: null }
    if (!place.sight.lots) return { ...headOf(place), sight: place.sight, unit: 'mg/kg' as const, results: 0, suppliers: [] }
    const { results, parties } = await crViResults(db, place)
    return {
      ...headOf(place),
      sight: place.sight,
      unit: 'mg/kg' as const,
      results: results.length,
      suppliers: crViBySupplier(results).map((row) => ({
        party: row.supplierId ? (parties.get(row.supplierId) ?? null) : null,
        lots: row.lots,
        results: row.results,
        measured: row.measured,
        belowDetection: row.belowDetection,
        median: decimalText(row.median),
        highest: decimalText(row.highest),
        fails: row.fails,
        limit: decimalText(row.limit),
        lotReports: row.lotReports,
        supplierReports: row.supplierReports,
      })),
    }
  })
}

/** GET /compliance/reports/register — the register per kind, authority notices, recalls and authority requests. */
export async function registerAnswer(caller: CommandCaller, query: RegisterQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const months = monthsOf(place.period)
    if (!place.sight.register) return { ...headOf(place), sight: place.sight, months, kinds: [], all: null, notices: null, recalls: null, requests: null }
    const brandStyles = await brandStyleIds(db, place)
    const summary = registerSummary(await registerFacts(db, place, brandStyles), place.span, months, (instant) => businessDate(instant))
    const requests = await requestsOf(db, place, brandStyles)
    const onTime = requests.answered.filter(answeredOnTime).length
    return {
      ...headOf(place),
      sight: place.sight,
      months,
      kinds: summary.rows.map((row) => ({ ...row, months: [...row.months] })),
      all: { ...summary.total, months: [...summary.total.months] },
      notices: await noticesOf(db, place, brandStyles),
      recalls: await recallsOf(db, place, brandStyles),
      requests: { received: requests.received, answered: requests.answered.length, onTime, onTimePct: pct(onTime, requests.answered.length), open: requests.open, overdue: requests.overdue },
    }
  })
}
