import { defineKpi } from '../catalogue'

/** Scrap rate (B-W2b-428): the pieces scrapped over the pieces made and scrapped, by site and line. */
export default defineKpi({
  key: 'production.scrap_rate',
  unit: 'PERCENT',
  grain: null,
  ownerRole: 'production_manager',
  sourceRecords: ['OperationScan', 'ReworkOrder'],
  calc: { kind: 'RATIO', numerator: ['production.scrap_pieces'], denominator: ['production.output_pieces', 'production.scrap_pieces'], scale: 100, decimals: 1 },
  period: 'WEEK',
  drill: { kind: 'REPORT', key: 'production.scrap-by-reason', filters: {} },
  words: {
    nameIt: 'Tasso di scarto',
    nameEn: 'Scrap rate',
    definitionIt:
      'I pezzi scartati sul totale dei pezzi buoni e scartati, come li conta il rapporto giornaliero di produzione, per sito, linea e turno; mai per persona.',
    definitionEn: 'The pieces scrapped over the good and scrapped pieces, as the daily production report counts them, by site, line and shift; never per person.',
    formulaIt: 'pezzi scartati ÷ (pezzi buoni + pezzi scartati) × 100',
    formulaEn: 'pieces scrapped ÷ (good pieces + pieces scrapped) × 100',
  },
})
