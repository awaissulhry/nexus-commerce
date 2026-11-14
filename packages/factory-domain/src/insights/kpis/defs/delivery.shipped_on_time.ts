import { defineKpi } from '../catalogue'

/** Shipped on time (B-W2b-428): the share of shipments that left by their order's promise date; Today's "Shipped on time". */
export default defineKpi({
  key: 'delivery.shipped_on_time',
  unit: 'PERCENT',
  grain: null,
  ownerRole: 'planner',
  sourceRecords: ['Shipment', 'SalesOrder'],
  calc: { kind: 'RATIO', numerator: ['shipments.on_time'], denominator: ['shipments.shipped'], scale: 100, decimals: 1 },
  period: 'WEEK',
  drill: { kind: 'REPORT', key: 'sales.shipments-on-time', filters: {} },
  words: {
    nameIt: 'Spedito in tempo',
    nameEn: 'Shipped on time',
    definitionIt:
      "La quota delle spedizioni partite nel periodo entro la data promessa del loro ordine, sul totale delle spedizioni partite di ordini con una data promessa. Il giorno di partenza è quello della società.",
    definitionEn:
      "The share of the shipments that left in the period on or before their order's promise date, over every shipment that left of an order with a promise date. The day it left is the company's.",
    formulaIt: 'spedizioni partite entro la data promessa ÷ spedizioni partite × 100',
    formulaEn: 'shipments that left by the promise date ÷ shipments that left × 100',
  },
})
