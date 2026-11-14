import { defineKpi } from '../catalogue'

/** Order margin (B-W2b-428): the margin at order of the orders taken, over their value; shown only with the margin grain. */
export default defineKpi({
  key: 'sales.order_margin',
  unit: 'PERCENT',
  grain: 'MARGIN',
  ownerRole: 'sales',
  sourceRecords: ['SalesOrder', 'SalesOrderLine'],
  calc: { kind: 'RATIO', numerator: ['orders.margin'], denominator: ['orders.value_costed'], scale: 100, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'REPORT', key: 'sales.margin-by-order', filters: {} },
  words: {
    nameIt: 'Margine per ordine',
    nameEn: 'Order margin',
    definitionIt:
      "Il margine all'ordine (imponibile meno costo all'ordine) delle righe degli ordini con data nel periodo, sul loro imponibile. Contano solo le righe con un costo all'ordine; esclusi gli ordini annullati. Non è il margine a consuntivo.",
    definitionEn:
      'The margin at order (net amount less the cost at order) of the lines of the orders dated in the period, over their net amount. Only lines with a cost at order count; cancelled orders are left out. It is not the actual margin.',
    formulaIt: 'Σ (imponibile − costo all’ordine) ÷ Σ imponibile delle righe con costo × 100',
    formulaEn: 'Σ (net − cost at order) ÷ Σ net of the lines with a cost × 100',
  },
})
