import type { CheckDraft, PlanStage, SamplingDraft } from './rules'

/**
 * The leather-apparel starter set (B-W2b-92; QHS-008; design quality.plans "No plans yet - New plan, or start from the
 * leather-apparel starter set", New plan "start from: blank / starter set / copy"): one plan per stage for a maker of
 * leather motorcycle garments (PPE, Reg. (EU) 2016/425; EN 17092 garments, EN 1621 protectors). Each is added as a DRAFT
 * version 1 written by the person who adds it: a second person approves it before any record runs on it (QHS-016). The
 * numbers (thickness, stitches) are examples the office sets to its own articles before approval.
 *
 * The final plan carries W1's fixed final checklist (factory-domain quality/final CHECKLIST_ITEMS, QHS-050) as checks with
 * the SAME codes, so a final inspection on a plan answers what W1's checklist asked (B-W2b-97 writes the checklist from
 * the results), and adds the chest measurement from the style's size chart.
 */

export interface StarterPlan {
  readonly code: string
  readonly stage: PlanStage
  readonly name: Readonly<{ it: string; en: string }>
  readonly sampling: SamplingDraft
  readonly checks: readonly CheckDraft[]
}

const pass = (code: string, labelIt: string, labelEn: string, checkClass: CheckDraft['checkClass'], extra: Partial<CheckDraft> = {}): CheckDraft => ({ code, labelIt, labelEn, type: 'PASS_FAIL', checkClass, ...extra })

export const STARTER_PLANS: readonly StarterPlan[] = Object.freeze([
  {
    code: 'INC-LEATHER',
    stage: 'INCOMING',
    name: { it: 'Pelli in arrivo, pelle per pelle', en: 'Incoming leather, hide by hide' },
    sampling: { samplingMethod: 'AQL_PROFILE', frequency: 'EVERY_LOT' },
    checks: [
      { code: 'SHADE', labelIt: 'Gruppo di tono contro il campione', labelEn: 'Shade group against the swatch', type: 'CHOICE', checkClass: 'MAJOR', choices: ['A', 'B', 'C'] },
      { code: 'THICKNESS', labelIt: 'Spessore', labelEn: 'Thickness', type: 'MEASUREMENT', checkClass: 'MINOR', nominal: '1.200', tolerance: '0.200', uom: 'MM' },
      pass('GRAIN', 'Fiore senza difetti nelle zone utili', 'Grain free of defects in the usable zones', 'MAJOR'),
      pass('CRVI_REPORT', 'Rapporto cromo VI del lotto presente', "The lot's chromium VI report is on file", 'CRITICAL'),
      { code: 'DEFECT_PHOTO', labelIt: 'Foto dei difetti trovati', labelEn: 'Photo of the defects found', type: 'PHOTO', checkClass: null, mandatory: false },
    ],
  },
  {
    code: 'CUT-PANELS',
    stage: 'CUTTING',
    name: { it: 'Controllo al taglio', en: 'Cutting inspection' },
    sampling: { samplingMethod: 'FIXED', fixedSampleSize: 5, frequency: 'EVERY_LOT' },
    checks: [
      pass('PATTERN_MATCH', 'Pezzi conformi al cartamodello', 'Pieces match the pattern', 'MAJOR'),
      pass('GRAIN_DIRECTION', 'Verso del fiore e linea di schiena rispettati', 'Grain and backbone direction respected', 'MAJOR'),
      pass('IMPACT_ZONES', 'Nessun difetto nelle zone di impatto (spalle, gomiti, ginocchia)', 'No defect in the impact zones (shoulders, elbows, knees)', 'CRITICAL'),
      pass('ONE_SHADE', 'Stesso tono per i pezzi di un capo', "One shade across a garment's pieces", 'MAJOR'),
      pass('NOTCHES', 'Tacche e segni di montaggio presenti', 'Notches and assembly marks present', 'MINOR'),
    ],
  },
  {
    code: 'INL-FIRST',
    stage: 'IN_LINE',
    name: { it: 'Primo capo in linea', en: 'First piece in line' },
    sampling: { samplingMethod: 'FIXED', fixedSampleSize: 1, frequency: 'FIRST_PIECE' },
    checks: [
      { code: 'READ_SHEET', labelIt: 'Leggere la scheda tecnica del modello', labelEn: "Read the style's technical sheet", type: 'INSTRUCTION' },
      pass('SAFETY_SEAMS', 'Cuciture di sicurezza (doppie o triple) nelle zone di impatto', 'Safety seams (double or triple) in the impact zones', 'CRITICAL'),
      { code: 'STITCHES_3CM', labelIt: 'Punti contati su 3 cm', labelEn: 'Stitches counted over 3 cm', type: 'COUNT', checkClass: 'MAJOR' },
      pass('PROTECTOR_POCKETS', 'Tasche delle protezioni nella posizione giusta', 'Protector pockets in the right place', 'MAJOR'),
      pass('THREAD', 'Filo e colore come da scheda', 'Thread and colour as on the sheet', 'MINOR'),
    ],
  },
  {
    code: 'EOL-GARMENT',
    stage: 'END_OF_LINE',
    name: { it: 'Fine linea, capo per capo', en: 'End of line, garment by garment' },
    sampling: { samplingMethod: 'FIXED', fixedSampleSize: 1 },
    checks: [
      pass('SEAMS', 'Cuciture senza salti né arricciature', 'Seams without skipped stitches or puckering', 'MAJOR'),
      pass('ZIPS', 'Cerniere scorrono e chiudono', 'Zips run and close', 'MAJOR'),
      pass('TRIMMED', 'Fili tagliati', 'Threads trimmed', 'MINOR'),
      { code: 'DEFECT_PHOTO', labelIt: 'Foto del difetto', labelEn: 'Photo of the defect', type: 'PHOTO', checkClass: null, mandatory: false },
    ],
  },
  {
    code: 'FIN-JACKET',
    stage: 'FINAL',
    name: { it: 'Controllo finale, giacche', en: 'Final inspection, jackets' },
    sampling: { samplingMethod: 'AQL_PROFILE' },
    checks: [
      pass('EN17092_CLASS_LABEL', "Etichetta classe EN 17092 uguale alla classe del certificato", 'EN 17092 class label matches the certificate class', 'CRITICAL'),
      pass('SIZE_LABEL', 'Etichetta taglia', 'Size label', 'MAJOR'),
      pass('CE_MARK', 'Marcatura CE', 'CE marking', 'CRITICAL'),
      pass('CARE_LABEL', 'Etichetta di manutenzione', 'Care label', 'MAJOR'),
      pass('FIBRE_COMPOSITION', 'Composizione fibrosa (Reg. 1007/2011 art. 12)', 'Fibre composition (Reg. 1007/2011 art. 12)', 'CRITICAL'),
      pass('ANIMAL_ORIGIN_PHRASE', "'Contiene parti non tessili di origine animale'", "'Contains non-textile parts of animal origin'", 'CRITICAL'),
      pass('ZIPS', 'Cerniere', 'Zips', 'MAJOR'),
      pass('REFLECTIVES', 'Rifrangenti', 'Reflectives', 'MAJOR'),
      pass('ARMOUR_FITTED', 'Protezioni montate, taglia giusta, marcate EN 1621', 'Armour fitted, right size, EN 1621 marked', 'CRITICAL'),
      pass('HANGTAGS', 'Cartellini', 'Hangtags', 'MINOR'),
      pass('USER_INFORMATION', 'Nota informativa nelle lingue del mercato', "User information in the market's languages", 'CRITICAL'),
      pass('PACKAGING', 'Imballo', 'Packaging', 'MINOR'),
      { code: 'CHEST', labelIt: 'Mezzo torace', labelEn: 'Chest half', type: 'MEASUREMENT', checkClass: 'MAJOR' },
    ],
  },
  {
    code: 'RET-GARMENT',
    stage: 'RETURN',
    name: { it: 'Capo reso', en: 'Returned garment' },
    sampling: { samplingMethod: 'FIXED', fixedSampleSize: 1 },
    checks: [
      pass('LABELS_PRESENT', 'Etichette presenti e leggibili', 'Labels present and readable', 'MAJOR'),
      pass('PROTECTORS_PRESENT', 'Protezioni presenti e integre', 'Protectors present and undamaged', 'CRITICAL'),
      { code: 'CONDITION', labelIt: 'Stato del capo', labelEn: 'Condition of the garment', type: 'CHOICE', checkClass: 'MAJOR', choices: ['Nuovo / New', 'Provato / Tried on', 'Usato / Used', 'Danneggiato / Damaged'] },
      { code: 'NOTE', labelIt: 'Cosa dice il cliente', labelEn: 'What the customer says', type: 'FREE_TEXT', checkClass: null, mandatory: false },
    ],
  },
] satisfies readonly StarterPlan[])

export const STARTER_CODES: readonly string[] = Object.freeze(STARTER_PLANS.map((plan) => plan.code))

export const starterPlan = (code: string): StarterPlan | undefined => STARTER_PLANS.find((plan) => plan.code === code)

/** The starter plans a company does not have yet (by code), in the set's order. */
export const missingStarterPlans = (taken: ReadonlySet<string>): StarterPlan[] => STARTER_PLANS.filter((plan) => !taken.has(plan.code))
