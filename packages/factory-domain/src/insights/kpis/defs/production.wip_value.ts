import { defineKpi } from '../catalogue'

/** WIP value (B-W2b-428): the cost sitting on the work orders at the end of the day, by site; only with the cost grain. */
export default defineKpi({
  key: 'production.wip_value',
  unit: 'MONEY',
  grain: 'COST',
  ownerRole: 'finance',
  sourceRecords: ['WorkOrder', 'WorkOrderCostEntry'],
  calc: { kind: 'BALANCE', measure: 'wip.cost' },
  period: 'WEEK',
  drill: { kind: 'REPORT', key: 'production.wip-by-stage', filters: {} },
  words: {
    nameIt: 'Valore del semilavorato',
    nameEn: 'WIP value',
    definitionIt:
      "Il saldo del registro dei costi degli ordini di lavoro del sito alla fine dell'ultimo giorno del periodo: quanto è stato caricato sugli ordini meno quanto è uscito verso i prodotti finiti, gli scostamenti e le chiusure, nella valuta della società.",
    definitionEn:
      "The balance of the site's work-order cost ledger at the end of the period's last day: what was put on the work orders less what left them to finished goods, variances and closes, in the company's currency.",
    formulaIt: 'Σ importi del registro dei costi fino a fine giornata',
    formulaEn: 'Σ cost ledger amounts up to the end of the day',
  },
})
