/**
 * The starter set of machine classes and of the symptoms a station reports (B-W2a-35; QHS-162, QHS-178; design
 * plant.machines "Type", floor.machine "What is wrong?", plant.settings "Symptoms on the floor"): what a leather-apparel
 * factory's floor needs on day one. `POST /plant/starter` adds the codes a tenant lacks (never changes one it has); the
 * factory-db seed (seed/plant.ts) writes the same first codes with the same words. Icons are design-system icon ids;
 * colours the swatches of a tile.
 */

export interface StarterClass {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly icon: string
}

export interface StarterSymptom {
  readonly code: string
  /** The class it is for (its code); null: every class. */
  readonly classCode: string | null
  readonly labelIt: string
  readonly labelEn: string
  readonly icon: string | null
  readonly colour: string | null
  /** Reporting it marks the machine unsafe at once (H1). */
  readonly unsafe: boolean
  readonly needsDetail: boolean
}

export const STARTER_CLASSES: readonly StarterClass[] = Object.freeze([
  { code: 'LOCKSTITCH', labelIt: 'Lineare', labelEn: 'Lockstitch', icon: 'needle' },
  { code: 'POST_BED', labelIt: 'Colonna', labelEn: 'Post-bed', icon: 'needle' },
  { code: 'WALKING_FOOT', labelIt: 'Triplo trasporto', labelEn: 'Walking-foot', icon: 'needle' },
  { code: 'CUTTING_TABLE', labelIt: 'Tavolo di taglio', labelEn: 'Cutting table', icon: 'scissors' },
  { code: 'CLICKING_PRESS', labelIt: 'Trancia', labelEn: 'Clicking press', icon: 'stamp' },
  { code: 'HEAT_PRESS', labelIt: 'Pressa a caldo', labelEn: 'Heat press', icon: 'flame' },
  { code: 'BAR_TACK', labelIt: 'Travettatrice', labelEn: 'Bar-tack', icon: 'needle' },
  { code: 'ZIG_ZAG', labelIt: 'Zig-zag', labelEn: 'Zig-zag', icon: 'needle' },
  { code: 'CNC_CUTTER', labelIt: 'Taglio automatico', labelEn: 'CNC cutter', icon: 'scissors' },
  { code: 'SKIVING', labelIt: 'Scarnitrice', labelEn: 'Skiving machine', icon: 'layers' },
  { code: 'SPLITTING', labelIt: 'Spaccatrice', labelEn: 'Splitting machine', icon: 'layers' },
  { code: 'COMPRESSOR', labelIt: 'Compressore', labelEn: 'Compressor', icon: 'wind' },
  { code: 'STEAM_IRON', labelIt: 'Ferro da stiro a vapore', labelEn: 'Steam iron', icon: 'flame' },
  { code: 'LABEL_PRINTER', labelIt: 'Stampante etichette', labelEn: 'Label printer', icon: 'printer' },
])

const AMBER = '#d97706'
const RED = '#dc2626'
const SLATE = '#475569'

export const STARTER_SYMPTOMS: readonly StarterSymptom[] = Object.freeze([
  { code: 'WONT_START', classCode: null, labelIt: 'Non parte', labelEn: "Won't start", icon: 'power', colour: SLATE, unsafe: false, needsDetail: false },
  { code: 'NOISE', classCode: null, labelIt: 'Rumore', labelEn: 'Noise', icon: 'volume', colour: SLATE, unsafe: false, needsDetail: false },
  { code: 'OIL_LEAK', classCode: null, labelIt: 'Perdita d’olio', labelEn: 'Oil leak', icon: 'droplet', colour: AMBER, unsafe: false, needsDetail: false },
  { code: 'GUARD_MISSING', classCode: null, labelIt: 'Protezione mancante', labelEn: 'Guard missing', icon: 'shield-off', colour: RED, unsafe: true, needsDetail: false },
  { code: 'OTHER', classCode: null, labelIt: 'Altro', labelEn: 'Other', icon: null, colour: null, unsafe: false, needsDetail: true },
  { code: 'THREAD_BREAKS', classCode: 'LOCKSTITCH', labelIt: 'Il filo si rompe', labelEn: 'Thread breaks', icon: 'scissors', colour: AMBER, unsafe: false, needsDetail: false },
  { code: 'SKIPPED_STITCHES', classCode: 'LOCKSTITCH', labelIt: 'Salta i punti', labelEn: 'Skipped stitches', icon: 'needle', colour: AMBER, unsafe: false, needsDetail: false },
  { code: 'TWO_HAND_CONTROL', classCode: 'CLICKING_PRESS', labelIt: 'Comando a due mani guasto', labelEn: 'Two-hand control fails', icon: 'hand', colour: RED, unsafe: true, needsDetail: false },
  { code: 'ELECTRICAL_FAULT', classCode: null, labelIt: 'Guasto elettrico', labelEn: 'Electrical fault', icon: 'zap', colour: RED, unsafe: true, needsDetail: false },
])

/** The starter codes a tenant lacks (classes and symptoms by their own codes), in the starter's order. */
export function missingStarter(classCodes: ReadonlySet<string>, symptomCodes: ReadonlySet<string>): { readonly classes: readonly StarterClass[]; readonly symptoms: readonly StarterSymptom[] } {
  return { classes: STARTER_CLASSES.filter((entry) => !classCodes.has(entry.code)), symptoms: STARTER_SYMPTOMS.filter((entry) => !symptomCodes.has(entry.code)) }
}
