/**
 * The textile fibre names of Reg. (EU) 1007/2011 Annex I (B-W2b-208; PRD-338, PRD-341): only these names may describe
 * the fibres of a textile product on its label, in catalogues and online (arts. 5, 9, 16). Each fibre has its key (the
 * English official name, lower case), its official names in the languages the factory prints first, and the words people
 * type for it (old names, trade marks, the other language).
 *
 * Languages: Italian and English (Owner answer Q23, recommended: documents in Italian and English). A name is listed only
 * where its official wording is certain; a fibre without an official name in a language the label prints is typed on the
 * label by a person, and the check says so (the phrase library of B-W2b-249 brings the other languages). A typed name that
 * is not in this list is a warning, never a refusal: the list holds the fibres garments use, not every line of Annex I.
 *
 * Pure: no I/O.
 */

export interface AnnexFibre {
  /** The English official name in lower case ("polyamide"): the key the factory stores and compares. */
  readonly key: string
  /** The official name per language (ISO 639-1); a language left out has no name on file here. */
  readonly names: Readonly<Record<string, string>>
  /** Other words people type for it (normalised: lower case, no accents). A trade mark is listed with `brand`. */
  readonly aliases: readonly string[]
  /** Trade marks typed for it ("Cordura", "Kevlar"): the label prints the official name, never the mark alone (art. 5). */
  readonly brands?: readonly string[]
}

const fibre = (key: string, it: string | null, aliases: readonly string[] = [], brands: readonly string[] = []): AnnexFibre => {
  const names: Record<string, string> = { en: key }
  if (it !== null) names.it = it
  return Object.freeze({ key, names: Object.freeze(names), aliases: Object.freeze([...aliases]), brands: Object.freeze([...brands]) })
}

/** The Annex I fibres garments use, in the Annex's order. */
export const ANNEX_I_FIBRES: readonly AnnexFibre[] = Object.freeze([
  fibre('wool', 'lana', ['virgin wool', 'lana vergine', 'merino', 'merino wool']),
  fibre('alpaca', 'alpaca'),
  fibre('llama', 'lama'),
  fibre('camel', 'cammello', ['camel hair']),
  fibre('cashmere', 'cashmere', ['cachemire']),
  fibre('mohair', 'mohair'),
  fibre('angora', 'angora'),
  fibre('vicuna', 'vigogna', ['vicuña']),
  fibre('yak', 'yak'),
  fibre('guanaco', 'guanaco'),
  fibre('beaver', 'castoro'),
  fibre('otter', 'lontra'),
  fibre('silk', 'seta'),
  fibre('cotton', 'cotone', ['organic cotton', 'cotone biologico']),
  fibre('flax', 'lino', ['linen']),
  fibre('true hemp', 'canapa', ['hemp']),
  fibre('jute', 'iuta', ['juta']),
  fibre('ramie', 'ramiè', ['ramie']),
  fibre('sisal', 'sisal'),
  fibre('acetate', 'acetato'),
  fibre('cupro', 'cupro'),
  fibre('modal', 'modal'),
  fibre('triacetate', 'triacetato'),
  fibre('viscose', 'viscosa', ['rayon', 'viscose rayon']),
  fibre('acrylic', 'acrilica', ['acrilico', 'polyacrylic', 'acrylic fibre']),
  fibre('chlorofibre', 'clorofibra', ['chlorofiber']),
  fibre('fluorofibre', 'fluorofibra', ['fluorofiber', 'ptfe'], ['gore-tex']),
  fibre('modacrylic', 'modacrilica', ['modacrilico']),
  fibre('polyamide', 'poliammide', ['nylon', 'polyamide or nylon', 'poliammide o nylon', 'pa', 'pa6', 'pa66', 'nylon 6', 'nylon 6.6'], ['cordura']),
  fibre('aramid', 'aramide', ['para-aramid', 'meta-aramid', 'aramide'], ['kevlar', 'twaron', 'nomex']),
  fibre('lyocell', 'lyocell', [], ['tencel']),
  fibre('polyester', 'poliestere', ['pes', 'pet', 'recycled polyester', 'poliestere riciclato'], ['coolmax', 'thermolite']),
  fibre('polyethylene', null, ['uhmwpe', 'hppe', 'polietilene'], ['dyneema', 'spectra']),
  fibre('polypropylene', null, ['pp', 'polipropilene']),
  fibre('polyurethane', null, ['pu', 'poliuretano']),
  fibre('elastane', 'elastan', ['spandex', 'elastan', 'elastam', 'elasthane'], ['lycra', 'elaspan']),
  fibre('glass fibre', 'fibra di vetro', ['glass fiber', 'fiberglass', 'fibreglass']),
])

/** Lower case, accents dropped, one space between words: how typed names are compared. */
export function normalisedWords(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/[^a-z0-9.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const INDEX: ReadonlyMap<string, { readonly fibre: AnnexFibre; readonly brand: boolean }> = (() => {
  const index = new Map<string, { fibre: AnnexFibre; brand: boolean }>()
  for (const entry of ANNEX_I_FIBRES) {
    for (const name of [...Object.values(entry.names), ...entry.aliases]) index.set(normalisedWords(name), { fibre: entry, brand: false })
    for (const name of entry.brands ?? []) index.set(normalisedWords(name), { fibre: entry, brand: true })
  }
  return index
})()

/** Words that name leather or fur, never a textile fibre (they belong to the art. 12 phrase, not to the composition). */
const NOT_FIBRES = /^(leather|pelle|cuoio|fur|pelliccia|suede|scamosciato|nubuck|nabuk)\b/

export type FibreReading =
  | { readonly kind: 'ANNEX'; readonly fibre: AnnexFibre; readonly brand: boolean }
  | { readonly kind: 'NOT_TEXTILE' }
  | { readonly kind: 'UNKNOWN' }

/** What a typed fibre name is: an Annex I fibre (maybe through a trade mark), leather or fur (no fibre), or not known here. */
export function readFibre(typed: string): FibreReading {
  const words = normalisedWords(typed)
  const found = INDEX.get(words)
  if (found) return { kind: 'ANNEX', fibre: found.fibre, brand: found.brand }
  if (NOT_FIBRES.test(words)) return { kind: 'NOT_TEXTILE' }
  return { kind: 'UNKNOWN' }
}

/** The fibre's official name in a language; null when none is on file here. */
export const officialName = (fibre: AnnexFibre, language: string): string | null => fibre.names[language] ?? null

/** The languages this list holds official names in (Italian is missing for the few fibres whose wording is not certain). */
export const FIBRE_LANGUAGES = ['it', 'en'] as const
