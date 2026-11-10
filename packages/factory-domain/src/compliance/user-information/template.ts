/**
 * The generated user information's template (B-W2b-258; PRD-350, PRD-353, PRD-354; Reg. (EU) 2016/425 art. 8(7), Annex II
 * 1.4 and 1.3.1), pure: the sections of the leaflet in their order, and the fixed words of each as phrases of the library
 * (compliance/phrases, kind USER_INFO), with their placeholders. The phrase library wins: a phrase with the key, in the
 * leaflet's language (its source words, or an approved translation of its current revision), is what prints. When the
 * library has none, Italian and English fall back to the built-in words below; any other language needs the library (a
 * missing phrase is named, and a translation keeps the original's words for a translator to type).
 *
 * Each section's words name what they are about ("Storage: …"), so the leaflet needs no headings of its own.
 *
 * GATE-PPE-TEXTS (Owner 11-09): a PPE consultant checks the template and the first translations once; until that yes is
 * recorded per template, every generated leaflet is a draft. `TEMPLATE_ID` names this template on each generated leaflet
 * (`sections.template`), so the yes can be recorded against it later.
 */

export const TEMPLATE_ID = 'annex-ii-1.4.1'

/**
 * The sections in the order the leaflet prints them, each with the Annex II point it answers: the product, the
 * manufacturer (1.4, first paragraph), storage, use and cleaning (1.4(a)), performance and class (1.4(b)), the protectors'
 * position and fit (1.3.1, PRD-353), compatible spare protectors (1.4(c), PRD-354), limits of use (1.4(d)), obsolescence
 * (1.4(e)), the meaning of the markings (1.4(g)), the risks covered (1.4(h)), the Regulation (1.4(i)), the notified body
 * (1.4(j)), the standards (1.4(k)) and the address of the DoC (1.4(l)).
 */
export const SECTION_KEYS = [
  'product',
  'maker',
  'storage',
  'use',
  'cleaning',
  'performance',
  'protectors',
  'spares',
  'limits',
  'obsolescence',
  'markings',
  'risks',
  'regulation',
  'notifiedBody',
  'standards',
  'docAddress',
] as const
export type SectionKey = (typeof SECTION_KEYS)[number]

/** Where each section stands in Annex II (the screen's LawRef). */
export const SECTION_LAW: Readonly<Record<SectionKey, string>> = Object.freeze({
  product: 'Reg. (EU) 2016/425 art. 8(7)',
  maker: 'Annex II 1.4',
  storage: 'Annex II 1.4(a)',
  use: 'Annex II 1.4(a)',
  cleaning: 'Annex II 1.4(a)',
  performance: 'Annex II 1.4(b)',
  protectors: 'Annex II 1.3.1, 1.4(b)',
  spares: 'Annex II 1.4(c)',
  limits: 'Annex II 1.4(d)',
  obsolescence: 'Annex II 1.4(e)',
  markings: 'Annex II 1.4(g)',
  risks: 'Annex II 1.4(h)',
  regulation: 'Annex II 1.4(i)',
  notifiedBody: 'Annex II 1.4(j)',
  standards: 'Annex II 1.4(k)',
  docAddress: 'Annex II 1.4(l)',
})

/** The languages the built-in words exist in (the factory's own two). */
export const BUILT_IN_LANGUAGES = ['it', 'en'] as const

export interface TemplateEntry {
  /** The phrase key ("userinfo.storage"). */
  readonly key: string
  /** Every `{name}` the words must hold (a translation that drops one is not used). */
  readonly placeholders: readonly string[]
  readonly it: string
  readonly en: string
}

const entry = (key: string, placeholders: readonly string[], it: string, en: string): TemplateEntry => Object.freeze({ key, placeholders: Object.freeze([...placeholders]), it, en })

/** The template's phrases, by key. */
export const TEMPLATE: Readonly<Record<string, TemplateEntry>> = Object.freeze({
  'userinfo.product': entry(
    'userinfo.product',
    ['product', 'code', 'revision', 'category', 'sizes', 'colourways'],
    'Nota informativa del fabbricante: {product}, modello {code} (revisione {revision}), dispositivo di protezione individuale di categoria {category}. Taglie: {sizes}. Colori: {colourways}. Leggere queste informazioni prima dell’uso e conservarle.',
    'Information from the manufacturer: {product}, model {code} (revision {revision}), personal protective equipment of category {category}. Sizes: {sizes}. Colours: {colourways}. Read this information before use and keep it.',
  ),
  'userinfo.maker': entry('userinfo.maker', ['maker', 'makerAddress'], 'Fabbricante: {maker}, {makerAddress}.', 'Manufacturer: {maker}, {makerAddress}.'),
  'userinfo.maker-representative': entry(
    'userinfo.maker-representative',
    ['representative', 'representativeAddress'],
    'Mandatario: {representative}, {representativeAddress}.',
    'Authorised representative: {representative}, {representativeAddress}.',
  ),
  'userinfo.maker-importer': entry('userinfo.maker-importer', ['importer', 'importerAddress'], 'Importatore: {importer}, {importerAddress}.', 'Importer: {importer}, {importerAddress}.'),
  'userinfo.storage': entry(
    'userinfo.storage',
    [],
    'Conservazione: conservare il capo in luogo asciutto e ventilato, lontano dalla luce diretta del sole e da fonti di calore, appeso o piegato senza schiacciare le protezioni.',
    'Storage: keep the garment in a dry, ventilated place away from direct sunlight and heat, hung up or folded without crushing the protectors.',
  ),
  'userinfo.use': entry(
    'userinfo.use',
    [],
    'Uso: prima di ogni uso controllare il capo, le chiusure e le protezioni; non usarlo se è danneggiato. Indossarlo chiuso e allacciato, con ogni protezione nella sua tasca come descritto alla voce Protezioni.',
    'Use: before each use, check the garment, its closures and its protectors; do not use it if it is damaged. Wear it closed and fastened, with every protector in its pocket as described under Protectors.',
  ),
  'userinfo.cleaning': entry(
    'userinfo.cleaning',
    [],
    'Pulizia e manutenzione: estrarre le protezioni prima della pulizia; pulire come indicato sull’etichetta di manutenzione, senza solventi; lasciare asciugare lontano da fonti di calore. Le riparazioni spettano al fabbricante o a chi esso indica.',
    'Cleaning and care: take the protectors out before cleaning; clean as the care label says, without solvents; let the garment dry away from heat. Repairs are for the manufacturer or whoever it names.',
  ),
  'userinfo.performance': entry('userinfo.performance', ['standards', 'ppeClass'], 'Prestazioni: provato secondo {standards}; classe {ppeClass}.', 'Performance: tested to {standards}; class {ppeClass}.'),
  'userinfo.performance-no-class': entry('userinfo.performance-no-class', ['standards'], 'Prestazioni: provato secondo {standards}.', 'Performance: tested to {standards}.'),
  'userinfo.protectors': entry(
    'userinfo.protectors',
    ['positions'],
    'Protezioni: il capo porta queste protezioni contro gli urti, ciascuna nella sua tasca: {positions}.',
    'Protectors: the garment holds these impact protectors, each in its own pocket: {positions}.',
  ),
  'userinfo.protector-line': entry('userinfo.protector-line', ['zone', 'standard', 'level', 'sizes'], '{zone} ({standard}, livello {level}; {sizes})', '{zone} ({standard}, level {level}; {sizes})'),
  'userinfo.protectors-none': entry('userinfo.protectors-none', [], 'Protezioni: questo capo non porta protezioni contro gli urti.', 'Protectors: this garment holds no impact protectors.'),
  'userinfo.protectors-fit': entry(
    'userinfo.protectors-fit',
    ['sizes'],
    'Vestibilità: scegliere la taglia ({sizes}) secondo la tabella taglie. Ogni protezione deve stare sulla sua articolazione: regolare cinghie e chiusure finché le protezioni non si spostano nel movimento.',
    'Fit: choose the size ({sizes}) from the size chart. Each protector must sit on its joint: adjust the straps and closures until the protectors stay in place when you move.',
  ),
  'userinfo.sizes-every': entry('userinfo.sizes-every', [], 'tutte le taglie', 'every size'),
  'userinfo.sizes-some': entry('userinfo.sizes-some', ['sizes'], 'taglie {sizes}', 'sizes {sizes}'),
  'userinfo.zone-shoulder': entry('userinfo.zone-shoulder', [], 'spalle', 'shoulders'),
  'userinfo.zone-elbow': entry('userinfo.zone-elbow', [], 'gomiti', 'elbows'),
  'userinfo.zone-back': entry('userinfo.zone-back', [], 'schiena', 'back'),
  'userinfo.zone-chest': entry('userinfo.zone-chest', [], 'torace', 'chest'),
  'userinfo.zone-hip': entry('userinfo.zone-hip', [], 'fianchi', 'hips'),
  'userinfo.zone-knee': entry('userinfo.zone-knee', [], 'ginocchia', 'knees'),
  'userinfo.spares': entry(
    'userinfo.spares',
    ['spares'],
    'Ricambi: sostituire una protezione solo con una di queste, certificata per la stessa zona e almeno per lo stesso livello: {spares}.',
    'Spare protectors: replace a protector only with one of these, certified for the same zone and at least the same level: {spares}.',
  ),
  'userinfo.spare-line': entry('userinfo.spare-line', ['zone', 'name', 'standard', 'level', 'certificate'], '{zone}: {name} ({standard}, livello {level}, certificato {certificate})', '{zone}: {name} ({standard}, level {level}, certificate {certificate})'),
  'userinfo.spares-none': entry('userinfo.spares-none', [], 'Ricambi: chiedere al fabbricante le protezioni di ricambio adatte.', 'Spare protectors: ask the manufacturer for suitable spare protectors.'),
  'userinfo.limits': entry(
    'userinfo.limits',
    [],
    'Limiti d’uso: nessun capo protettivo protegge da ogni lesione. Questo capo protegge solo le parti del corpo che copre e solo come indica la sua classe; non sostituisce una guida prudente.',
    'Limits of use: no protective garment protects against every injury. This garment protects only the parts of the body it covers, and only as its class says; it does not replace careful riding.',
  ),
  'userinfo.obsolescence': entry(
    'userinfo.obsolescence',
    [],
    'Durata: la protezione diminuisce con l’usura, l’invecchiamento e i danni. Dopo una caduta o un urto far controllare il capo e le protezioni e sostituire ogni parte danneggiata. Il mese e l’anno di fabbricazione sono sull’etichetta.',
    'Obsolescence: the protection decreases with wear, ageing and damage. After a fall or an impact, have the garment and its protectors checked and replace any damaged part. The month and year of manufacture are on the label.',
  ),
  'userinfo.markings': entry(
    'userinfo.markings',
    ['markings', 'standard', 'ppeClass'],
    'Marcature: {markings}: la conformità alle norme dell’Unione; il pittogramma con {standard} e la classe {ppeClass}; la taglia; il libro aperto: leggere queste informazioni prima dell’uso.',
    'Markings: {markings}: conformity with the Union’s rules; the pictogram with {standard} and the class {ppeClass}; the size; the open book: read this information before use.',
  ),
  'userinfo.risks': entry(
    'userinfo.risks',
    ['standards'],
    'Rischi coperti: abrasione, lacerazione e apertura delle cuciture in caso di caduta, come provato secondo {standards}.',
    'Risks covered: abrasion, tearing and seams bursting in a fall, as tested to {standards}.',
  ),
  'userinfo.risks-impact': entry('userinfo.risks-impact', [], 'Con le protezioni al loro posto: gli urti sulle zone indicate alla voce Protezioni.', 'With the protectors in place: impacts on the zones listed under Protectors.'),
  'userinfo.regulation': entry('userinfo.regulation', ['legislation'], 'Normativa: questo DPI è conforme a {legislation}.', 'Legislation: this PPE complies with {legislation}.'),
  'userinfo.notified-body': entry(
    'userinfo.notified-body',
    ['body', 'bodyAddress', 'bodyNumber', 'certificate'],
    'Organismo notificato: {body}, {bodyAddress}, numero {bodyNumber}; certificato di esame UE del tipo {certificate}.',
    'Notified body: {body}, {bodyAddress}, number {bodyNumber}; EU type-examination certificate {certificate}.',
  ),
  'userinfo.notified-body-no-address': entry(
    'userinfo.notified-body-no-address',
    ['body', 'bodyNumber', 'certificate'],
    'Organismo notificato: {body}, numero {bodyNumber}; certificato di esame UE del tipo {certificate}.',
    'Notified body: {body}, number {bodyNumber}; EU type-examination certificate {certificate}.',
  ),
  'userinfo.notified-body-category-one': entry(
    'userinfo.notified-body-category-one',
    [],
    'Organismo notificato: nessuno; DPI di categoria I, la cui conformità è valutata mediante il controllo interno della produzione (modulo A).',
    'Notified body: none; category I PPE, whose conformity is assessed by internal production control (Module A).',
  ),
  'userinfo.standards': entry('userinfo.standards', ['standards'], 'Norme armonizzate applicate, con la loro data: {standards}.', 'Harmonised standards applied, with their dates: {standards}.'),
  'userinfo.doc-address': entry(
    'userinfo.doc-address',
    ['address'],
    'Dichiarazione di conformità UE: disponibile all’indirizzo {address}.',
    'EU declaration of conformity: available at {address}.',
  ),
})

/** Every template key. */
export const TEMPLATE_KEYS: readonly string[] = Object.freeze(Object.keys(TEMPLATE))

/** The pocket's zone word key ("SHOULDER" → "userinfo.zone-shoulder"). */
export const zoneKey = (pocket: string): string => `userinfo.zone-${pocket.toLowerCase()}`

/** The built-in words of a key in a language (Italian or English), or null. */
export function builtInWords(key: string, language: string): string | null {
  const found = TEMPLATE[key]
  if (!found) return null
  return language === 'it' ? found.it : language === 'en' ? found.en : null
}

/** The placeholders of the key the words lack (empty: usable). */
export function missingPlaceholders(key: string, words: string): string[] {
  const held = new Set([...words.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]!))
  return (TEMPLATE[key]?.placeholders ?? []).filter((name) => !held.has(name))
}

/** The draft words a generated leaflet's PDF prints across each page (the factory's two languages; another: English). */
export const DRAFT_BANNER: Readonly<Record<'it' | 'en', string>> = Object.freeze({
  it: 'BOZZA generata dai dati: da non usare finché un consulente DPI non ha verificato i testi (GATE-PPE-TEXTS). La nota informativa approvata resta il documento valido.',
  en: 'DRAFT generated from the records: not for use until a PPE consultant has checked the texts (GATE-PPE-TEXTS). The approved leaflet stays the live document.',
})
