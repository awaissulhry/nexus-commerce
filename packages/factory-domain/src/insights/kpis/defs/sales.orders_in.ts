import { defineKpi } from '../catalogue'

/** Orders in (B-W2b-428): the net value of the sales orders taken; Today's "Orders in this week" reads it. */
export default defineKpi({
  key: 'sales.orders_in',
  unit: 'MONEY',
  grain: 'PRICE',
  ownerRole: 'sales',
  sourceRecords: ['SalesOrder'],
  calc: { kind: 'SUM', measure: 'orders.value' },
  period: 'WEEK',
  drill: { kind: 'REPORT', key: 'sales.orders-in', filters: {} },
  words: {
    nameIt: 'Ordini acquisiti',
    nameEn: 'Orders in',
    definitionIt:
      "Il valore netto (IVA esclusa) degli ordini di vendita con data d'ordine nel periodo, nella valuta della società; gli ordini in un'altra valuta al cambio del loro giorno. Esclusi gli ordini annullati.",
    definitionEn:
      "The net value (before VAT) of the sales orders dated in the period, in the company's currency; orders in another currency at the rate of their day. Cancelled orders are left out.",
    formulaIt: 'Σ imponibile degli ordini con data nel periodo (annullati esclusi)',
    formulaEn: 'Σ net amount of the orders dated in the period (cancelled left out)',
  },
})
