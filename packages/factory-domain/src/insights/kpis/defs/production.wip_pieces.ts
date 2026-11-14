import { defineKpi } from '../catalogue'

/** Pieces in work (B-W2b-429; ANA-015): the garments of the work orders in work at the end of the day, by site and line. */
export default defineKpi({
  key: 'production.wip_pieces',
  unit: 'PIECES',
  grain: null,
  ownerRole: 'production_manager',
  sourceRecords: ['WorkOrder', 'WorkOrderSize'],
  calc: { kind: 'BALANCE', measure: 'wip.pieces' },
  period: 'WEEK',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/wip', query: {} },
  words: {
    nameIt: "Capi in lavorazione",
    nameEn: "Pieces in work",
    definitionIt:
      "I capi degli ordini di lavoro in lavorazione alla fine dell'ultimo giorno del periodo: rilasciati e non ancora completati, chiusi o annullati (anche se sospesi), per sito e linea. Le unità per fase e da quanto aspettano sono nel dettaglio.",
    definitionEn:
      "The garments of the work orders in work at the end of the period's last day: released and not yet completed, closed or cancelled (on hold too), by site and line. The units per stage and how long they waited are in the detail.",
    formulaIt: "Σ capi degli ordini di lavoro in lavorazione a fine giornata",
    formulaEn: "Σ garments of the work orders in work at the end of the day",
  },
})
