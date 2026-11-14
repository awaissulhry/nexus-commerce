import { defineKpi } from '../catalogue'

/** On-time in full (B-W2b-429; ANA-013): garment order lines shipped complete by their FIRST promised date. */
export default defineKpi({
  key: 'delivery.otif',
  unit: 'PERCENT',
  grain: null,
  ownerRole: 'planner',
  sourceRecords: ['SalesOrderLine', 'Shipment'],
  calc: { kind: 'RATIO', numerator: ['orders.lines_shipped_on_time'], denominator: ['orders.lines_due'], scale: 100, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/otif', query: { promise: 'FIRST' } },
  words: {
    nameIt: "Consegne puntuali e complete",
    nameEn: "On-time in full",
    definitionIt:
      "La quota delle righe d'ordine di capi dovute nel periodo alla loro PRIMA data promessa (mai cambiata) che sono partite complete entro quel giorno: tutti i capi ordinati, meno quelli chiusi in difetto. Escluse le righe di addebito e gli ordini annullati; una riga non ancora completa è in ritardo dal giorno promesso. Il giorno è quello della società.",
    definitionEn:
      "The share of the garment order lines due in the period on their FIRST promised date (never changed) that left complete by that day: every garment ordered, less those closed short. Fee lines and cancelled orders are left out; a line not complete yet is late from its promised day. The day is the company's.",
    formulaIt: "righe partite complete entro la prima data promessa ÷ righe dovute alla prima data promessa × 100",
    formulaEn: "lines shipped complete by the first promised date ÷ lines due on their first promised date × 100",
  },
})
