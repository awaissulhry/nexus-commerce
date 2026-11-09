import { CARE_SYMBOLS, type CareCategory, type CareEntry } from '../labels/rules'

/**
 * The care label builder's words (B-W2b-208; PRD-342; ISO 3758): what each care symbol of the W1 label builder
 * (compliance/labels/rules.ts CARE_SYMBOLS) says, in Italian and English, so a label prints the words beside the symbols;
 * and which of the five groups of symbols a care label shows (washing, bleaching, drying, ironing, professional care: the
 * order of ISO 3758). The symbols' artwork needs a GINETEX licence (W1 draws stand-ins).
 *
 * Whether a care label is mandatory in Italy is not verified (no law found that asks one of every garment): the check of
 * the five groups is a switch, OFF until a market or a brand asks for it (./rules.ts). The words are always offered.
 *
 * Pure: no I/O.
 */

/** The Italian words of each symbol (the English ones are CARE_SYMBOLS' own). */
const IT: Readonly<Record<string, string>> = Object.freeze({
  'wash-95': 'Lavare a 95 °C',
  'wash-70': 'Lavare a 70 °C',
  'wash-60': 'Lavare a 60 °C',
  'wash-60-mild': 'Lavare a 60 °C, ciclo delicato',
  'wash-50': 'Lavare a 50 °C',
  'wash-50-mild': 'Lavare a 50 °C, ciclo delicato',
  'wash-40': 'Lavare a 40 °C',
  'wash-40-mild': 'Lavare a 40 °C, ciclo delicato',
  'wash-40-very-mild': 'Lavare a 40 °C, ciclo molto delicato',
  'wash-30': 'Lavare a 30 °C',
  'wash-30-mild': 'Lavare a 30 °C, ciclo delicato',
  'wash-30-very-mild': 'Lavare a 30 °C, ciclo molto delicato',
  'wash-hand': 'Lavare a mano',
  'wash-not': 'Non lavare',
  'bleach-any': 'Candeggio consentito',
  'bleach-oxygen': 'Solo candeggio con ossigeno',
  'bleach-not': 'Non candeggiare',
  'tumble-normal': 'Asciugatura in tamburo a temperatura normale',
  'tumble-low': 'Asciugatura in tamburo a bassa temperatura',
  'tumble-not': 'Non asciugare in tamburo',
  'dry-line': 'Asciugare appeso',
  'dry-line-shade': "Asciugare appeso all'ombra",
  'dry-drip': 'Asciugare appeso senza strizzare',
  'dry-drip-shade': "Asciugare appeso senza strizzare, all'ombra",
  'dry-flat': 'Asciugare in piano',
  'dry-flat-shade': "Asciugare in piano all'ombra",
  'iron-200': 'Stirare a 200 °C al massimo',
  'iron-150': 'Stirare a 150 °C al massimo',
  'iron-110': 'Stirare a 110 °C al massimo',
  'iron-110-no-steam': 'Stirare a 110 °C al massimo, senza vapore',
  'iron-not': 'Non stirare',
  'dryclean-professional': 'Lavaggio a secco professionale con tetracloroetilene (P)',
  'dryclean-p-mild': 'Lavaggio a secco professionale (P), ciclo delicato',
  'dryclean-f': 'Lavaggio a secco professionale con idrocarburi (F)',
  'dryclean-f-mild': 'Lavaggio a secco professionale (F), ciclo delicato',
  'dryclean-not': 'Non lavare a secco',
  'wetclean-w': 'Lavaggio ad acqua professionale (W)',
  'wetclean-w-mild': 'Lavaggio ad acqua professionale (W), ciclo delicato',
  'wetclean-w-very-mild': 'Lavaggio ad acqua professionale (W), ciclo molto delicato',
  'wetclean-not': 'Non lavare ad acqua professionalmente',
})

/** The languages the builder has words in. */
export const CARE_LANGUAGES = ['it', 'en'] as const

/** What a symbol says in a language: the builder's words, else null (a person types them on the label). */
export function careWords(symbol: string, language: string): string | null {
  const known = CARE_SYMBOLS[symbol]
  if (!known) return null
  if (language === 'en') return known.words
  if (language === 'it') return IT[symbol] ?? null
  return null
}

/** The five groups of a care label in ISO 3758's order; drying and professional care each have two kinds of symbol. */
export const CARE_GROUPS = ['WASHING', 'BLEACHING', 'DRYING', 'IRONING', 'PROFESSIONAL'] as const
export type CareGroup = (typeof CARE_GROUPS)[number]

const GROUP_OF: Readonly<Record<CareCategory, CareGroup>> = Object.freeze({
  WASH: 'WASHING',
  BLEACH: 'BLEACHING',
  TUMBLE_DRY: 'DRYING',
  NATURAL_DRY: 'DRYING',
  IRON: 'IRONING',
  DRY_CLEAN: 'PROFESSIONAL',
  WET_CLEAN: 'PROFESSIONAL',
})

export const CARE_GROUP_WORDS: Readonly<Record<CareGroup, string>> = Object.freeze({
  WASHING: 'washing',
  BLEACHING: 'bleaching',
  DRYING: 'drying',
  IRONING: 'ironing',
  PROFESSIONAL: 'professional care',
})

export interface CareWordsOfEntry {
  readonly symbol: string
  readonly group: CareGroup | null
  /** Per printed language: the label's typed text, else the builder's words, else null (missing). */
  readonly words: readonly { readonly language: string; readonly text: string | null; readonly typed: boolean }[]
}

/** The label's care entries with their words in every language it prints. */
export function careWordsOf(care: readonly CareEntry[], languages: readonly string[]): CareWordsOfEntry[] {
  return care.map((entry) => {
    const symbol = CARE_SYMBOLS[entry.symbol]
    return {
      symbol: entry.symbol,
      group: symbol ? GROUP_OF[symbol.category] : null,
      words: languages.map((language) => {
        const typed = entry.text?.[language]?.trim()
        if (typed) return { language, text: typed, typed: true }
        return { language, text: careWords(entry.symbol, language), typed: false }
      }),
    }
  })
}

/** The groups the label shows no symbol of, in ISO 3758's order. */
export function missingCareGroups(care: readonly CareEntry[]): CareGroup[] {
  const shown = new Set(care.flatMap((entry) => (CARE_SYMBOLS[entry.symbol] ? [GROUP_OF[CARE_SYMBOLS[entry.symbol]!.category]] : [])))
  return CARE_GROUPS.filter((group) => !shown.has(group))
}

/** Every symbol of the builder with its group and words, for the label builder's picker. */
export function careVocabulary(): { symbol: string; group: CareGroup; words: Record<string, string> }[] {
  return Object.entries(CARE_SYMBOLS).map(([symbol, entry]) => ({
    symbol,
    group: GROUP_OF[entry.category],
    words: Object.fromEntries(CARE_LANGUAGES.flatMap((language) => {
      const text = careWords(symbol, language)
      return text === null ? [] : [[language, text]]
    })),
  }))
}
