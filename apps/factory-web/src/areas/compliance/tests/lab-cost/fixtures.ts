import type { Lot } from '../../../quality/_shared/lots'
import type { RoleCase } from '../../../quality/_shared/fixtures'
import { ready } from '../../../quality/_shared/model'
import type { LabResult, LotDetail } from '../api'
import type { LotRecordModel, LotsListModel, ResultDraft } from '../model'

/**
 * Tests & substances › the lab's price (B-W2b-288, FU2:03; money.cost): the design cases `w2b-288-lab-cost-*`, spread into
 * SCR-054 (the Lot tests list's Lab cost column) and SCR-054-lot (the price typed with a result, read back on the result). Made-up
 * prices only. The owner holds the cost grain; the quality inspector does not: the API drops the field, so no column and no
 * price field.
 */


/** Made-up lab prices: the first lots' results cost 85,00 € (and one lot a second test in CHF). */
export function withLabCost(lots: readonly Lot[]): Lot[] {
  return lots.map((lot, index) => ({ ...lot, labCost: index === 0 ? [{ currency: 'CHF', cents: 12000, results: 1 }, { currency: 'EUR', cents: 8500, results: 1 }] : index < 4 && lot.crVi.status !== 'PENDING' ? [{ currency: 'EUR', cents: 8500, results: 1 }] : [] }))
}

type ListModel = (over?: Partial<LotsListModel>, role?: RoleCase) => { readonly model: LotsListModel; readonly role: RoleCase }

/** SCR-054: the Lot tests list with the Lab cost column (cost grain) and without it. */
export function labCostListCases(listModel: ListModel, lots: readonly Lot[]) {
  return [
    { id: 'w2b-288-lab-cost', label: 'Owner (cost grain): the Lab cost column — the lab prices of each lot, per currency', model: listModel({ rows: ready(withLabCost(lots)) }), note: 'Hidden without the cost grain (the API sends no price).' },
    { id: 'w2b-288-lab-cost-no-grain', label: 'Quality inspector (no cost grain): no Lab cost column', model: listModel({ rows: ready([...lots]) }, 'inspector') },
  ]
}

type LotCase = (lot: Lot, over?: Partial<LotRecordModel>, role?: RoleCase) => { readonly model: LotRecordModel; readonly role: RoleCase; readonly panels: boolean }

/** SCR-054-lot: the price typed with a result, refused when it is not an amount, and read back on the result. */
export function labCostLotCases(lotCase: LotCase, lot: Lot, detail: LotDetail, draft: ResultDraft, priced: LotDetail) {
  const result = priced.results[0]
  const pricedDetail: LotDetail = result ? { ...priced, results: [{ ...result, cost: { cents: 8500, currency: 'EUR' } } as LabResult, ...priced.results.slice(1)] } : priced
  return [
    { id: 'w2b-288-lab-cost-result', label: 'Record result with the lab’s price (cost grain): 85,50 EUR', model: lotCase(lot, { detail: ready(detail), dialog: { kind: 'result' }, resultDraft: { ...draft, labCost: { text: '85,50', currency: 'EUR' } }, costGrain: true }) },
    { id: 'w2b-288-lab-cost-refused', label: 'Record result: a price that is not an amount holds Save, said in the field', model: lotCase(lot, { detail: ready(detail), dialog: { kind: 'result' }, resultDraft: { ...draft, labCost: { text: 'ottanta', currency: 'EUR' } }, costGrain: true }) },
    { id: 'w2b-288-lab-cost-no-grain', label: 'Record result without the cost grain: no price field', model: lotCase(lot, { detail: ready(detail), dialog: { kind: 'result' }, resultDraft: draft, costGrain: false }, 'inspector') },
    { id: 'w2b-288-lab-cost-results', label: 'A result with the lab’s price (cost grain)', model: lotCase(lot, { detail: ready(pricedDetail), costGrain: true }) },
  ]
}
