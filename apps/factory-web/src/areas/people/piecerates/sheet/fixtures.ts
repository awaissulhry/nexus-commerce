import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { VERSION } from '../demo/fixtures'
import { RateSheetView, type RateSheetModel, type SheetTable } from './view/RateSheetView'

/** SCR-158-rate-sheet — the rate sheet for publication and the notice board (a new tab), made-up rates. No person on it. */

const TABLE: SheetTable = {
  key: VERSION.table.id,
  title: `${VERSION.table.code} · ${VERSION.table.name}`,
  subtitle: VERSION.table.style ? `${VERSION.table.style.code} · ${VERSION.table.style.name}` : '',
  versionNo: VERSION.version.versionNo,
  effectiveFrom: VERSION.version.effectiveFrom,
  effectiveTo: null,
  provisionalUntil: null,
  currency: VERSION.table.currency,
  rates: VERSION.rates.map((rate) => ({ id: rate.id, operation: `${rate.operation.code} · ${rate.operation.name}`, sizeBand: rate.sizeBand, basis: rate.basis, standardMinutes: rate.standardMinutes, ratePerMinute: rate.ratePerMinute ?? null, ratePerPiece: rate.ratePerPiece ?? null })),
}

const sheet = (over: Partial<RateSheetModel> = {}): RateSheetModel => ({ allowed: true, company: 'Officina Demo', site: 'Stabilimento Nord', printedAt: '2026-11-02T09:42:00.000Z', sheet: { status: 'ready', value: [TABLE, { ...TABLE, key: 'two', versionNo: 3, provisionalUntil: '2026-11-10' }] }, ...over })

export const designScreen = defineDesignScreen<RateSheetModel>({
  screen: 'SCR-158-rate-sheet',
  title: 'Rate sheet print',
  view: RateSheetView,
  cases: [
    { id: 'sheet', label: 'For the notice board', model: sheet(), note: 'Operations, SMV, the rate per piece, the days. No name. The browser prints it.' },
    { id: 'empty', label: 'Nothing to print', model: sheet({ sheet: { status: 'ready', value: [] } }) },
    { id: 'no-permission', label: 'Without the pay grain', model: sheet({ allowed: false }) },
    { id: 'loading', label: 'Loading', model: sheet({ sheet: { status: 'loading' } }) },
    { id: 'error', label: "The rates couldn't be read", model: sheet({ sheet: { status: 'failed', problem: { key: 'problem.unavailable' } } }) },
  ],
})
