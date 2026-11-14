import { defineKpi } from '../catalogue'

/** Pieces made (B-W2b-428): the good pieces of the floor, by site and line; Today's "Good pieces, last working day". */
export default defineKpi({
  key: 'production.output',
  unit: 'PIECES',
  grain: null,
  ownerRole: 'production_manager',
  sourceRecords: ['OperationScan', 'ReworkOrder'],
  calc: { kind: 'SUM', measure: 'production.output_pieces' },
  period: 'DAY',
  drill: { kind: 'REPORT', key: 'production.daily', filters: {} },
  words: {
    nameIt: 'Pezzi prodotti',
    nameEn: 'Pieces made',
    definitionIt:
      "I pezzi buoni dichiarati all'ultima operazione di ogni linea o centro, come li conta il rapporto giornaliero di produzione, nel giorno del sito. Per sito, linea e turno; mai per persona.",
    definitionEn:
      "The good pieces reported at each line's or work centre's last operation, as the daily production report counts them, on the site's day. By site, line and shift; never per person.",
    formulaIt: 'Σ pezzi buoni all’ultima operazione della linea',
    formulaEn: 'Σ good pieces at the line’s last operation',
  },
})
