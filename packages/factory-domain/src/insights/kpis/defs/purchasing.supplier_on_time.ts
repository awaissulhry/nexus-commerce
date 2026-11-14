import { defineKpi } from '../catalogue'

/** Supplier on-time (B-W2b-429; ANA-023): purchase lines received by their confirmed date; shortages and cover in its drill. */
export default defineKpi({
  key: 'purchasing.supplier_on_time',
  unit: 'PERCENT',
  grain: null,
  ownerRole: 'buyer',
  sourceRecords: ['PurchaseOrderLine', 'GoodsReceipt'],
  calc: { kind: 'RATIO', numerator: ['purchasing.lines_on_time'], denominator: ['purchasing.lines_received'], scale: 100, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/supply', query: {} },
  words: {
    nameIt: "Puntualità dei fornitori",
    nameEn: "Supplier on-time",
    definitionIt:
      "La quota delle righe d'entrata merce registrate nel periodo contro una riga d'ordine d'acquisto che sono arrivate entro la data confermata dal fornitore (altrimenti la data richiesta). Un'entrata stornata non conta. Per fornitore, con le mancanze aperte per ordine di lavoro e i giorni di copertura delle pelli critiche, nel dettaglio.",
    definitionEn:
      "The share of the goods receipt lines posted in the period against a purchase order line that arrived by the date the supplier confirmed (else the date asked). A reversed receipt does not count. By supplier, with the open shortages per work order and the days of cover of the critical leathers, in the detail.",
    formulaIt: "righe ricevute entro la data confermata ÷ righe ricevute × 100",
    formulaEn: "lines received by the confirmed date ÷ lines received × 100",
  },
})
