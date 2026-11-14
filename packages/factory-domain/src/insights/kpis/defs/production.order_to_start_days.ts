import { defineKpi } from '../catalogue'

/** Order to start (B-W2b-429; ANA-014): the average days from the order date to its first work order's start. */
export default defineKpi({
  key: 'production.order_to_start_days',
  unit: 'DAYS',
  grain: null,
  ownerRole: 'production_manager',
  sourceRecords: ['SalesOrder', 'WorkOrder', 'WorkOrderSize'],
  calc: { kind: 'RATIO', numerator: ['leadtimes.order_to_start_days'], denominator: ['leadtimes.order_to_start_orders'], scale: 1, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/lead-times', query: { kind: 'ORDER_TO_START' } },
  words: {
    nameIt: "Dall’ordine all’avvio",
    nameEn: "Order to start",
    definitionIt:
      "I giorni in media dalla data dell'ordine al giorno in cui è partito il primo ordine di lavoro che ne fa una riga, per gli ordini avviati nel periodo. Mediana e dispersione per famiglia di prodotto nel dettaglio.",
    definitionEn:
      "The average days from the order date to the day the first work order making one of its lines started, for the orders started in the period. The median and spread by product family are in the detail.",
    formulaIt: "Σ giorni dalla data dell'ordine al primo avvio ÷ ordini avviati",
    formulaEn: "Σ days from the order date to the first start ÷ orders started",
  },
})
