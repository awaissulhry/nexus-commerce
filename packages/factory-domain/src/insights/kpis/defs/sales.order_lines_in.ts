import { defineKpi } from '../catalogue'

/** Order lines in (B-W2b-428): how many sales order lines were taken. */
export default defineKpi({
  key: 'sales.order_lines_in',
  unit: 'COUNT',
  grain: null,
  ownerRole: 'sales',
  sourceRecords: ['SalesOrder', 'SalesOrderLine'],
  calc: { kind: 'SUM', measure: 'orders.lines_in' },
  period: 'WEEK',
  drill: { kind: 'REPORT', key: 'sales.orders-in', filters: {} },
  words: {
    nameIt: "Righe d'ordine acquisite",
    nameEn: 'Order lines in',
    definitionIt: "Il numero di righe degli ordini di vendita con data d'ordine nel periodo. Esclusi gli ordini annullati.",
    definitionEn: 'The number of lines of the sales orders dated in the period. Cancelled orders are left out.',
    formulaIt: 'conteggio delle righe degli ordini con data nel periodo (annullati esclusi)',
    formulaEn: 'count of the lines of the orders dated in the period (cancelled left out)',
  },
})
