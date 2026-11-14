import { defineKpi } from '../catalogue'

/** Leather yield (B-W2b-429; ANA-020): the net area of the pieces cut over the hide area they were cut from. */
export default defineKpi({
  key: 'production.leather_yield',
  unit: 'PERCENT',
  grain: null,
  ownerRole: 'production_manager',
  sourceRecords: ['CutLog', 'CutLogPiece', 'Hide'],
  calc: { kind: 'RATIO', numerator: ['leather.area_pattern'], denominator: ['leather.area_cut'], scale: 100, decimals: 1 },
  period: 'MONTH',
  drill: { kind: 'LIST', api: '/insights/kpis/drills/leather-yield', query: {} },
  words: {
    nameIt: "Resa della pelle",
    nameEn: "Leather yield",
    definitionIt:
      "L'area netta dei pezzi tagliati nel periodo sull'area di pelle consumata per tagliarli, in metri quadrati. Contano i tagli di set interi di pezzi (di un taglio di parti singole non si conosce il modello); lo scarto è il resto. Per scelta, lotto del fornitore e modello nel dettaglio; mai per tagliatore.",
    definitionEn:
      "The net area of the pieces cut in the period over the hide area consumed to cut them, in square metres. Cuts of whole sets of pieces count (a cut of single parts has no known pattern); the waste is the rest. By grade, supplier lot and style in the detail; never by cutter.",
    formulaIt: "Σ area netta dei pezzi ÷ Σ area di pelle consumata × 100",
    formulaEn: "Σ net area of the pieces ÷ Σ hide area consumed × 100",
  },
})
