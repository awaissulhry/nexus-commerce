import { defineKpi } from '../catalogue'

/** Actual margin on what shipped (B-W2b-429; ANA-021): net less the cost of goods sold of the garments that left; only with the margin grain. */
export default defineKpi({
  key: 'sales.margin_actual',
  unit: 'PERCENT',
  grain: 'MARGIN',
  ownerRole: 'finance',
  sourceRecords: ['CostOfSalesEntry', 'ShipmentLine', 'SalesOrderLine'],
  calc: { kind: 'RATIO', numerator: ['margin.actual'], denominator: ['margin.shipped_value'], scale: 100, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/margin', query: {} },
  words: {
    nameIt: "Margine effettivo sullo spedito",
    nameEn: "Actual margin on shipments",
    definitionIt:
      "L'imponibile dei capi partiti nel periodo meno il loro costo del venduto registrato alla spedizione, sull'imponibile. Contano gli stessi capi del margine preventivato (con un costo all'ordine): la differenza è quanto si è guadagnato o perso dal preventivo. Per ordine, cliente e modello nel dettaglio.",
    definitionEn:
      "The net amount of the garments that left in the period less their cost of goods sold posted at shipment, over the net amount. The same garments as the quoted margin's count (with a cost at order): the difference is what was gained or lost since the quote. By order, customer and style in the detail.",
    formulaIt: "Σ (imponibile − costo del venduto) ÷ Σ imponibile dei capi partiti × 100",
    formulaEn: "Σ (net − cost of goods sold) ÷ Σ net of the garments that left × 100",
  },
})
