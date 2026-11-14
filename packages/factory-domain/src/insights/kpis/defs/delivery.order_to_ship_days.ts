import { defineKpi } from '../catalogue'

/** Order to ship (B-W2b-429; ANA-014): the average days from the order date to the day its last garment left. */
export default defineKpi({
  key: 'delivery.order_to_ship_days',
  unit: 'DAYS',
  grain: null,
  ownerRole: 'planner',
  sourceRecords: ['SalesOrder', 'Shipment'],
  calc: { kind: 'RATIO', numerator: ['leadtimes.order_to_ship_days'], denominator: ['leadtimes.order_to_ship_orders'], scale: 1, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/lead-times', query: { kind: 'ORDER_TO_SHIP' } },
  words: {
    nameIt: "Dall’ordine alla spedizione",
    nameEn: "Order to ship",
    definitionIt:
      "I giorni in media dalla data dell'ordine al giorno in cui è partito il suo ultimo capo (ogni riga di capi spedita completa, meno i capi chiusi in difetto), per gli ordini completati nel periodo. Mediana e dispersione per famiglia di prodotto nel dettaglio.",
    definitionEn:
      "The average days from the order date to the day its last garment left (every garment line shipped complete, less the garments closed short), for the orders completed in the period. The median and spread by product family are in the detail.",
    formulaIt: "Σ giorni dalla data dell'ordine all'ultima spedizione ÷ ordini completati",
    formulaEn: "Σ days from the order date to the last shipment ÷ orders completed",
  },
})
