import { defineKpi } from '../catalogue'

/** On-time in full on the promise of now (B-W2b-429; ANA-013): the same lines, on their CURRENT promised date. */
export default defineKpi({
  key: 'delivery.otif_current',
  unit: 'PERCENT',
  grain: null,
  ownerRole: 'planner',
  sourceRecords: ['SalesOrderLine', 'PromiseRecord', 'Shipment'],
  calc: { kind: 'RATIO', numerator: ['orders.lines_on_time_current'], denominator: ['orders.lines_due_current'], scale: 100, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/otif', query: { promise: 'CURRENT' } },
  words: {
    nameIt: "Consegne puntuali e complete (data attuale)",
    nameEn: "On-time in full (current promise)",
    definitionIt:
      "La quota delle righe d'ordine di capi dovute nel periodo alla data promessa di adesso (dopo ogni nuova promessa) che sono partite complete entro quel giorno. Accanto alla prima data promessa dice quanto pesano le nuove promesse. Escluse le righe di addebito e gli ordini annullati.",
    definitionEn:
      "The share of the garment order lines due in the period on their promised date of now (after every new promise) that left complete by that day. Beside the first promised date it shows what the new promises hide. Fee lines and cancelled orders are left out.",
    formulaIt: "righe partite complete entro la data promessa attuale ÷ righe dovute alla data promessa attuale × 100",
    formulaEn: "lines shipped complete by the current promised date ÷ lines due on their current promised date × 100",
  },
})
