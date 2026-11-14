import { defineKpi } from '../catalogue'

/** Margin quoted on what shipped (B-W2b-429; ANA-021): the margin at order of the garments that left; only with the margin grain. */
export default defineKpi({
  key: 'sales.margin_quoted',
  unit: 'PERCENT',
  grain: 'MARGIN',
  ownerRole: 'finance',
  sourceRecords: ['CostOfSalesEntry', 'ShipmentLine', 'SalesOrderLine'],
  calc: { kind: 'RATIO', numerator: ['margin.quoted'], denominator: ['margin.shipped_value'], scale: 100, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/margin', query: {} },
  words: {
    nameIt: "Margine preventivato sullo spedito",
    nameEn: "Quoted margin on shipments",
    definitionIt:
      "Il margine all'ordine (imponibile meno costo all'ordine) dei capi partiti nel periodo, sul loro imponibile. Contano i capi con il costo del venduto registrato alla spedizione e un costo all'ordine, gli stessi del margine effettivo: i due si confrontano. Per ordine, cliente e modello nel dettaglio.",
    definitionEn:
      "The margin at order (net amount less the cost at order) of the garments that left in the period, over their net amount. Garments count with their cost of goods sold posted at shipment and a cost at order, the same as the actual margin's: the two compare. By order, customer and style in the detail.",
    formulaIt: "Σ (imponibile − costo all'ordine) ÷ Σ imponibile dei capi partiti × 100",
    formulaEn: "Σ (net − cost at order) ÷ Σ net of the garments that left × 100",
  },
})
