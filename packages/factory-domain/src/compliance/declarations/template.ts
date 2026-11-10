/**
 * The generated DoC's template (B-W2b-257; PRD-292; Reg. (EU) 2016/425 art. 15, Annex IX), pure: the fixed words of each
 * Annex IX point as phrases of the library (compliance/phrases, kind DOC), with their placeholders. The phrase library
 * wins: a phrase with the key, in the document's language (its source words, or an approved translation of its current
 * revision), is what prints. When the library has none, Italian and English fall back to the built-in words below (the
 * Regulation's own Annex IX wording, written as sentences); any other language needs the library (a missing phrase is
 * named, and a translation keeps the original's words for a translator to type).
 *
 * GATE-PPE-TEXTS (Owner 11-09): a PPE consultant checks the template and the first translations once; until that yes is
 * recorded per template, every generated DoC is a draft. `TEMPLATE_ID` names this template on each generated content
 * (`content.template`), so the yes can be recorded against it later.
 */

export const TEMPLATE_ID = 'annex-ix.1'

/** The languages the built-in words exist in (the factory's own two). */
export const BUILT_IN_LANGUAGES = ['it', 'en'] as const

export interface TemplateEntry {
  /** The phrase key ("doc.point1"). */
  readonly key: string
  /** Every `{name}` the words must hold (a translation that drops one is not used). */
  readonly placeholders: readonly string[]
  readonly it: string
  readonly en: string
}

const entry = (key: string, placeholders: readonly string[], it: string, en: string): TemplateEntry => Object.freeze({ key, placeholders: Object.freeze([...placeholders]), it, en })

/** The template's phrases, by key. */
export const TEMPLATE: Readonly<Record<string, TemplateEntry>> = Object.freeze({
  'doc.title': entry('doc.title', [], 'Dichiarazione di conformità UE', 'EU declaration of conformity'),
  'doc.number': entry('doc.number', ['number'], 'N. {number}', 'No. {number}'),
  'doc.point1': entry(
    'doc.point1',
    ['product', 'code'],
    'DPI: {product}, modello {code}; lotto o numero di serie: come riportato sull’etichetta di ogni capo.',
    'PPE: {product}, model {code}; batch or serial number: as printed on the label of each item.',
  ),
  'doc.point2': entry('doc.point2', ['maker', 'makerAddress'], 'Fabbricante: {maker}, {makerAddress}.', 'Manufacturer: {maker}, {makerAddress}.'),
  'doc.point2-representative': entry(
    'doc.point2-representative',
    ['representative', 'representativeAddress'],
    'Mandatario: {representative}, {representativeAddress}.',
    'Authorised representative: {representative}, {representativeAddress}.',
  ),
  'doc.sole-responsibility': entry(
    'doc.sole-responsibility',
    [],
    'La presente dichiarazione di conformità è rilasciata sotto la responsabilità esclusiva del fabbricante.',
    'This declaration of conformity is issued under the sole responsibility of the manufacturer.',
  ),
  'doc.point4': entry(
    'doc.point4',
    ['product', 'code', 'revision', 'colourways', 'sizes'],
    'Oggetto della dichiarazione: {product}, modello {code}, revisione {revision}; colori: {colourways}; taglie: {sizes}.',
    'Object of the declaration: {product}, model {code}, revision {revision}; colours: {colourways}; sizes: {sizes}.',
  ),
  'doc.point5': entry(
    'doc.point5',
    ['legislation'],
    'L’oggetto della dichiarazione di cui al punto 4 è conforme alla pertinente normativa di armonizzazione dell’Unione: {legislation}.',
    'The object of the declaration described in point 4 is in conformity with the relevant Union harmonisation legislation: {legislation}.',
  ),
  'doc.point6': entry(
    'doc.point6',
    ['standards'],
    'Riferimenti alle pertinenti norme armonizzate utilizzate, compresa la data della norma: {standards}.',
    'References to the relevant harmonised standards used, including the date of the standard: {standards}.',
  ),
  'doc.point7': entry(
    'doc.point7',
    ['body', 'bodyNumber', 'certificate'],
    'L’organismo notificato {body}, numero {bodyNumber}, ha effettuato l’esame UE del tipo (modulo B) e ha rilasciato il certificato di esame UE del tipo {certificate}.',
    'The notified body {body}, number {bodyNumber}, performed the EU type-examination (Module B) and issued the EU type-examination certificate {certificate}.',
  ),
  'doc.point7-category-one': entry(
    'doc.point7-category-one',
    [],
    'Non applicabile: DPI di categoria I, la cui conformità è valutata mediante il controllo interno della produzione (modulo A).',
    'Not applicable: category I PPE, whose conformity is assessed by internal production control (Module A).',
  ),
  'doc.point8-not-applicable': entry('doc.point8-not-applicable', [], 'Non applicabile: il DPI non è di categoria III.', 'Not applicable: the PPE is not of category III.'),
  'doc.point8-to-type': entry(
    'doc.point8-to-type',
    [],
    'Da completare: la procedura di valutazione della conformità (modulo C2 o modulo D) e l’organismo notificato (nome, numero) sotto la cui sorveglianza si trova il DPI.',
    'To complete: the conformity assessment procedure (Module C2 or Module D) and the notified body (name, number) under whose surveillance the PPE is.',
  ),
  'doc.point9': entry('doc.point9', ['maker'], 'Informazioni supplementari. Firmato a nome e per conto di: {maker}.', 'Additional information. Signed for and on behalf of: {maker}.'),
  'doc.point9-to-sign': entry(
    'doc.point9-to-sign',
    [],
    'Luogo e data del rilascio, nome e funzione, firma: da completare alla firma.',
    'Place and date of issue, name and function, signature: to complete when signed.',
  ),
})

/** Every template key, in the order the points use them. */
export const TEMPLATE_KEYS: readonly string[] = Object.freeze(Object.keys(TEMPLATE))

/** The built-in words of a key in a language (Italian or English), or null. */
export function builtInWords(key: string, language: string): string | null {
  const found = TEMPLATE[key]
  if (!found) return null
  return language === 'it' ? found.it : language === 'en' ? found.en : null
}

/** The placeholders the words hold. */
export const placeholdersIn = (words: string): string[] => [...words.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]!)

/** The placeholders of the key the words lack (empty: usable). */
export function missingPlaceholders(key: string, words: string): string[] {
  const held = new Set(placeholdersIn(words))
  return (TEMPLATE[key]?.placeholders ?? []).filter((name) => !held.has(name))
}

/**
 * The words with every `{name}` replaced by its value (a name without a value stays as written); a value that ends the
 * sentence with its own full stop ("S.r.l.") takes the template's: never "S.r.l..".
 */
export function fillWords(words: string, values: Readonly<Record<string, string>>): string {
  return words.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => values[name] ?? whole).replace(/(?<!\.)\.\.(?=\s|$)/g, '.')
}

/** The draft words a generated DoC's PDF prints across each page (the factory's two languages; another: English). */
export const DRAFT_BANNER: Readonly<Record<'it' | 'en', string>> = Object.freeze({
  it: 'BOZZA generata dai dati: da non usare finché un consulente DPI non ha verificato i testi (GATE-PPE-TEXTS). La dichiarazione firmata resta il documento valido.',
  en: 'DRAFT generated from the records: not for use until a PPE consultant has checked the texts (GATE-PPE-TEXTS). The signed declaration stays the live document.',
})
