import type { DefectClass, DispositionFollowUp, DispositionMove, DispositionOutcome, GarmentZone, QualityStage } from './rules'

/**
 * The starter set for leather rider garments (B-W2a-26; QHS-001 "ships with a leather-apparel starter set"; design
 * quality.defects df-library: "Start from the leather-apparel starter set or add the first defect") and the standard
 * disposition codes (QHS-005). Made-up wording, no business data. The codes are the seed's (factory-db seed/holds.ts),
 * so a seeded tenant misses none; icons and colours are the design system's sets (reasons/rules REASON_ICONS and
 * REASON_COLOURS), as the editor offers them.
 */

export interface StarterDefect {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly severity: DefectClass
  readonly zone: GarmentZone | null
  readonly stages: readonly QualityStage[]
  readonly needsDetail?: boolean
}

export interface StarterCategory {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly icon: string
  readonly colour: string
  readonly defects: readonly StarterDefect[]
}

const d = (code: string, labelIt: string, labelEn: string, severity: DefectClass, zone: GarmentZone | null, stages: readonly QualityStage[], needsDetail = false): StarterDefect =>
  Object.freeze({ code, labelIt, labelEn, severity, zone, stages: Object.freeze([...stages]), ...(needsDetail ? { needsDetail } : {}) })

export const STARTER_LIBRARY: readonly StarterCategory[] = Object.freeze([
  {
    code: 'SEAM',
    labelIt: 'Cuciture',
    labelEn: 'Seams',
    icon: 'shirt',
    colour: '#1f6fde',
    defects: [
      d('SEAM-OPEN', 'Cucitura aperta', 'Open seam', 'MAJOR', null, ['IN_LINE', 'FINAL', 'CUSTOMER']),
      d('STITCH-SKIP', 'Punto saltato', 'Skipped stitch', 'MINOR', null, ['IN_LINE', 'FINAL']),
      d('PUCKERING', 'Arricciatura', 'Puckering', 'MINOR', null, ['IN_LINE', 'FINAL']),
      d('NEEDLE-HOLES', 'Fori di ago', 'Needle holes', 'MINOR', null, ['IN_LINE', 'FINAL']),
    ],
  },
  {
    code: 'LEATHER',
    labelIt: 'Pelle',
    labelEn: 'Leather',
    icon: 'leaf',
    colour: '#b87503',
    defects: [
      d('SHADE-DIFF', 'Differenza di tono', 'Shade difference', 'MAJOR', null, ['INCOMING', 'CUTTING', 'FINAL']),
      d('HIDE-SCAR', 'Cicatrice o marchio', 'Scar or brand on the hide', 'MAJOR', null, ['INCOMING', 'CUTTING']),
      d('GRAIN-CRACK', 'Crepa del fiore', 'Grain crack', 'MAJOR', null, ['INCOMING', 'STOCK', 'CUTTING']),
      d('LOOSE-GRAIN', 'Fiore staccato', 'Loose grain', 'MINOR', null, ['INCOMING', 'CUTTING']),
      d('COLOUR-RUB', 'Scolorimento', 'Colour rub-off', 'MINOR', null, ['FINAL', 'CUSTOMER']),
    ],
  },
  { code: 'FITTING', labelIt: 'Accessori', labelEn: 'Fittings', icon: 'package', colour: '#5b6573', defects: [d('ZIP-MISALIGNED', 'Cerniera storta', 'Misaligned zip', 'MINOR', 'FRONT', ['FINAL'])] },
  { code: 'PROTECTION', labelIt: 'Protezioni', labelEn: 'Protection', icon: 'shield', colour: '#e5484d', defects: [d('ARMOUR-POCKET-MISSING', 'Tasca protezione mancante', 'Missing armour pocket', 'CRITICAL', 'SHOULDER', ['IN_LINE', 'FINAL'])] },
  { code: 'LABEL', labelIt: 'Etichette', labelEn: 'Labels', icon: 'bookmark', colour: '#8b5cf6', defects: [d('LABEL-WRONG', 'Etichetta errata o mancante', 'Wrong or missing label', 'CRITICAL', 'LABEL', ['FINAL', 'PACKING'])] },
  {
    code: 'FINISH',
    labelIt: 'Finitura',
    labelEn: 'Finish',
    icon: 'sparkles',
    colour: '#15a34a',
    defects: [
      d('STAIN', 'Macchia', 'Stain', 'MINOR', null, ['FINAL', 'CUSTOMER']),
      d('THREAD-END', 'Filo non tagliato', 'Thread end left', 'MINOR', null, ['FINAL']),
      d('OTHER', 'Altro', 'Other', 'MINOR', null, [], true),
    ],
  },
])

export interface StandardDisposition {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly outcome: DispositionOutcome
  readonly stockMoveReason: DispositionMove | null
  readonly followUp: DispositionFollowUp | null
  readonly reinspection: boolean
  readonly approvalSeverity: DefectClass | null
  /** Minor units of the company's currency (the cost grain). */
  readonly approvalAmount: number | null
  readonly icon: string
  readonly colour: string
}

const s = (code: string, labelIt: string, labelEn: string, outcome: DispositionOutcome, stockMoveReason: DispositionMove | null, followUp: DispositionFollowUp | null, reinspection: boolean, approvalSeverity: DefectClass | null, approvalAmount: number | null, icon: string, colour: string): StandardDisposition =>
  Object.freeze({ code, labelIt, labelEn, outcome, stockMoveReason, followUp, reinspection, approvalSeverity, approvalAmount, icon, colour })

/** The seven of the design (df-dispositions), SCRAP first; a scrap above 500.00 or of a critical NCR needs approval. */
export const STANDARD_DISPOSITIONS: readonly StandardDisposition[] = Object.freeze([
  s('SCRAP', 'Scarto', 'Scrap', 'SCRAP', 'SCRAP', null, false, 'CRITICAL', 50_000, 'alert', '#e5484d'),
  s('USE_AS_IS', 'Usa così', 'Use as is', 'USE_AS_IS', null, null, false, null, null, 'star', '#15a34a'),
  s('REWORK', 'Rilavorazione', 'Rework', 'REWORK', null, 'REWORK_ORDER', true, null, null, 'zap', '#1f6fde'),
  s('REPAIR', 'Riparazione', 'Repair', 'REPAIR', null, 'REPAIR_ORDER', true, null, null, 'shirt', '#1f6fde'),
  s('REGRADE', 'Seconda scelta', 'Regrade (second quality)', 'REGRADE', 'TRANSFER', null, false, null, 50_000, 'percent', '#b87503'),
  s('RETURN_TO_SUPPLIER', 'Reso al fornitore', 'Return to supplier', 'RETURN_TO_SUPPLIER', null, 'SUPPLIER_CLAIM', false, null, null, 'truck', '#8b5cf6'),
  s('QUARANTINE', 'Quarantena', 'Quarantine', 'QUARANTINE', 'TRANSFER', null, false, null, null, 'shield', '#5b6573'),
])

/** The starter codes a library does not have yet (categories and defects), in the starter set's order. */
export function missingStarter(existing: ReadonlySet<string>): { readonly categories: StarterCategory[]; readonly defects: { readonly category: string; readonly defect: StarterDefect }[] } {
  const categories = STARTER_LIBRARY.filter((category) => !existing.has(category.code))
  const defects = STARTER_LIBRARY.flatMap((category) => category.defects.filter((defect) => !existing.has(defect.code)).map((defect) => ({ category: category.code, defect })))
  return { categories, defects }
}

/** The standard disposition codes a tenant does not have yet. */
export const missingDispositions = (existing: ReadonlySet<string>): StandardDisposition[] => STANDARD_DISPOSITIONS.filter((code) => !existing.has(code.code))
