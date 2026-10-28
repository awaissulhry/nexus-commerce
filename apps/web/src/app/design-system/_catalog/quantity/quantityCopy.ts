/**
 * The words the floor count examples pass in — fake, Italian and English, as the factory app will. The design-system
 * parts hold none. Every name, code and number here is made up.
 */
export type CountLang = 'it' | 'en'

export interface CountCopy {
  good: string
  area: string
  pieces: string
  expected: (n: number) => string
  all: string
  less: string
  more: string
  clear: string
  back: string
  comma: string
  empty: string
  range: (min: number | undefined, max: number | undefined) => string
  confirm: string
  saved: (n: string) => string
  size: string
  toCut: (n: number) => string
  done: string
  notInOrder: string
  cut: string
  aqlPlan: string
  inspected: string
  sample: (i: number, n: number) => string
  threshold: (ac: number, re: number) => string
  verdict: { open: string; accept: string; reject: string }
  classState: { limit: string; reject: string }
  classes: { critical: string; major: string; minor: string }
  onePiece: string
  removePiece: string
  addDefect: (c: string) => string
  removeDefect: (c: string) => string
  sampleDone: string
  atZero: string
}

/** A number with the Italian decimal comma. */
const comma = (n: number | undefined) => String(n).replace('.', ',')

export const COUNT_COPY: { readonly [L in CountLang]: CountCopy } = {
  it: {
    good: 'Buoni',
    area: 'Area della pelle',
    pieces: 'pezzi',
    expected: (n) => `Attesi ${n}`,
    all: 'Tutti',
    less: 'Meno',
    more: 'Più',
    clear: 'Cancella',
    back: 'Indietro',
    comma: 'Virgola',
    empty: 'Scrivi una quantità',
    range: (min, max) => (min != null && max != null ? `Da ${comma(min)} a ${comma(max)}` : max != null ? `Al massimo ${comma(max)}` : `Almeno ${comma(min)}`),
    confirm: 'Conferma',
    saved: (n) => `Salvato: ${n}`,
    size: 'Taglia',
    toCut: (n) => (n === 1 ? '1 da tagliare' : `${n} da tagliare`),
    done: 'Fatto',
    notInOrder: 'Non in questo ordine',
    cut: 'Tagliati',
    aqlPlan: 'AQL 2,5 · livello II · campione 50',
    inspected: 'Ispezionati',
    sample: (i, n) => `${i} di ${n} ispezionati`,
    threshold: (ac, re) => `Accetta fino a ${ac} · rifiuta da ${re}`,
    verdict: { open: 'In corso', accept: 'Accettato', reject: 'Rifiutato' },
    classState: { limit: 'Al limite', reject: 'Oltre' },
    classes: { critical: 'Critici', major: 'Maggiori', minor: 'Minori' },
    onePiece: 'Pezzo controllato',
    removePiece: 'Togli un pezzo',
    addDefect: (c) => `Un difetto in più: ${c}`,
    removeDefect: (c) => `Un difetto in meno: ${c}`,
    sampleDone: 'Campione completo',
    atZero: 'Già a zero',
  },
  en: {
    good: 'Good',
    area: 'Hide area',
    pieces: 'pieces',
    expected: (n) => `Expected ${n}`,
    all: 'All',
    less: 'Less',
    more: 'More',
    clear: 'Clear',
    back: 'Back',
    comma: 'Decimal point',
    empty: 'Type a quantity',
    range: (min, max) => (min != null && max != null ? `From ${min} to ${max}` : max != null ? `At most ${max}` : `At least ${min}`),
    confirm: 'Confirm',
    saved: (n) => `Saved: ${n}`,
    size: 'Size',
    toCut: (n) => `${n} to cut`,
    done: 'Done',
    notInOrder: 'Not in this order',
    cut: 'Cut',
    aqlPlan: 'AQL 2.5 · level II · sample 50',
    inspected: 'Inspected',
    sample: (i, n) => `${i} of ${n} inspected`,
    threshold: (ac, re) => `Accept up to ${ac} · reject from ${re}`,
    verdict: { open: 'In progress', accept: 'Accepted', reject: 'Rejected' },
    classState: { limit: 'At the limit', reject: 'Over' },
    classes: { critical: 'Critical', major: 'Major', minor: 'Minor' },
    onePiece: 'Piece checked',
    removePiece: 'Remove a piece',
    addDefect: (c) => `One more defect: ${c}`,
    removeDefect: (c) => `One less defect: ${c}`,
    sampleDone: 'Sample complete',
    atZero: 'Already zero',
  },
}
