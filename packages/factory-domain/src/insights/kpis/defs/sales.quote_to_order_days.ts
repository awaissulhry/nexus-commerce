import { defineKpi } from '../catalogue'

/** Quote to order (B-W2b-429; ANA-014): the average days from a quote's first sending to its order. */
export default defineKpi({
  key: 'sales.quote_to_order_days',
  unit: 'DAYS',
  grain: null,
  ownerRole: 'sales',
  sourceRecords: ['QuoteVersion', 'SalesOrder'],
  calc: { kind: 'RATIO', numerator: ['leadtimes.quote_to_order_days'], denominator: ['leadtimes.quote_to_order_orders'], scale: 1, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/lead-times', query: { kind: 'QUOTE_TO_ORDER' } },
  words: {
    nameIt: "Dal preventivo all’ordine",
    nameEn: "Quote to order",
    definitionIt:
      "I giorni in media dal primo invio del preventivo (qualsiasi sua versione) alla data dell'ordine che ne è nato, per gli ordini con data nel periodo. Gli ordini senza preventivo e quelli annullati sono esclusi. Mediana e dispersione per famiglia di prodotto nel dettaglio.",
    definitionEn:
      "The average days from the first sending of the quote (any version of it) to the date of the order made from it, for the orders dated in the period. Orders without a quote and cancelled ones are left out. The median and spread by product family are in the detail.",
    formulaIt: "Σ giorni dal primo invio alla data dell'ordine ÷ ordini",
    formulaEn: "Σ days from the first sending to the order date ÷ orders",
  },
})
