import { defineKpi } from '../catalogue'

/** WIP age (B-W2b-429; ANA-015): the average days a garment in work has been in work, by site and line. */
export default defineKpi({
  key: 'production.wip_age_days',
  unit: 'DAYS',
  grain: null,
  ownerRole: 'production_manager',
  sourceRecords: ['WorkOrder', 'WorkOrderSize'],
  calc: { kind: 'RATIO', numerator: ['wip.piece_days'], denominator: ['wip.pieces'], scale: 1, decimals: 1 },
  period: 'WEEK',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/wip', query: {} },
  words: {
    nameIt: "Età del semilavorato",
    nameEn: "WIP age",
    definitionIt:
      "I giorni in media da cui un capo in lavorazione è in lavorazione (dal rilascio del suo ordine di lavoro), alla fine dell'ultimo giorno del periodo, pesati sui capi, per sito e linea.",
    definitionEn:
      "The average days a garment in work has been in work (since its work order's release), at the end of the period's last day, weighted by garments, by site and line.",
    formulaIt: "Σ (capi × giorni dal rilascio) ÷ Σ capi in lavorazione",
    formulaEn: "Σ (garments × days since release) ÷ Σ garments in work",
  },
})
