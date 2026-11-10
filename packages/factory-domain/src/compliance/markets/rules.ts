import type { Issue } from '../../core/errors'

/**
 * Market profiles (B-W2b-249; PRD-275; design compliance.settings › rm-markets), pure. The table is B-W2b-216's
 * MarketProfile: one row per destination code in the tenant ("IT", "UK", "US-CA"), its languages for the garment label,
 * the DoC and the user information (ISO 639 codes), its marks ("CE", "UKCA"), national rules in words (display data: a
 * rule that must stop something is a requirement of that market, B-W2b-254), whether an importer or authorised
 * representative and a GPSR contact are needed, and the switch: ON, or OFF with the reason in words (the Owner question it
 * waits for). Every later compliance step names a market by its code; W1 types the destination language into each label.
 *
 * The LanguageMatrix (design rm-markets "preview of what each market will need", compliance.labels › Languages) is
 * `languageMatrix`: which language each market needs for which document.
 */

export const MARKET_CODE = /^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$/
export const MARKET_CODE_MAX = 40
export const LANGUAGE_CODE = /^[a-z]{2,3}$/
export const MARK_CODE = /^[A-Z][A-Z0-9_-]{1,19}$/
export const LIST_MAX = 20
export const NAME_MAX = 200
export const NOTE_MAX = 2000
export const RULES_MAX = 50
export const RULE_KEY = /^[^\s\p{Cc}]{1,60}$/u
export const REASON_MIN = 3
export const REASON_MAX = 500
export const DOCUMENTS = ['LABEL', 'DOC', 'USER_INFO'] as const
export type MarketDocument = (typeof DOCUMENTS)[number]

const HTTPS = /^https:\/\/[^\s\p{Cc}]+$/u
const WORDS_LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

export interface NationalRule {
  readonly key: string
  readonly words: Readonly<Record<string, string>>
  readonly law?: string | undefined
  readonly href?: string | undefined
}

export interface MarketDraft {
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly labelLanguages?: readonly string[] | undefined
  readonly docLanguages?: readonly string[] | undefined
  readonly userInfoLanguages?: readonly string[] | undefined
  readonly markings?: readonly string[] | undefined
  readonly nationalRules?: readonly NationalRule[] | undefined
  readonly seq?: number | undefined
  readonly note?: string | null | undefined
}

const once = (list: readonly string[]): boolean => new Set(list).size === list.length

/** What is wrong with a market's fields, in words (paths under `body/`). Only the fields given are checked. */
export function marketProblems(draft: MarketDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.code !== undefined && (draft.code.length > MARKET_CODE_MAX || !MARKET_CODE.test(draft.code))) {
    problems.push({ path: 'body/code', message: 'Two capitals for the country ("DE", "UK"), optionally parts of it ("US-CA").' })
  }
  if (draft.name !== undefined && (draft.name.trim() === '' || draft.name.length > NAME_MAX)) problems.push({ path: 'body/name', message: `A name of 1 to ${NAME_MAX} characters.` })
  if (draft.nameI18n) {
    for (const [language, words] of Object.entries(draft.nameI18n)) {
      if (!WORDS_LANGUAGE.test(language) || words.trim() === '' || words.length > NAME_MAX) problems.push({ path: `body/nameI18n/${language}`, message: `A name per language ("it", "en"): 1 to ${NAME_MAX} characters.` })
    }
  }
  for (const field of ['labelLanguages', 'docLanguages', 'userInfoLanguages'] as const) {
    const list = draft[field]
    if (list === undefined) continue
    if (list.length > LIST_MAX || !once(list) || list.some((code) => !LANGUAGE_CODE.test(code))) {
      problems.push({ path: `body/${field}`, message: `ISO 639 language codes ("de", "fr"), each once, at most ${LIST_MAX}.` })
    }
  }
  if (draft.markings !== undefined && (draft.markings.length > LIST_MAX || !once(draft.markings) || draft.markings.some((code) => !MARK_CODE.test(code)))) {
    problems.push({ path: 'body/markings', message: `Marks as codes of 2 to 20 capitals ("CE", "UKCA"), each once, at most ${LIST_MAX}.` })
  }
  if (draft.nationalRules !== undefined) {
    if (draft.nationalRules.length > RULES_MAX) problems.push({ path: 'body/nationalRules', message: `At most ${RULES_MAX} national rules.` })
    const keys = new Set<string>()
    draft.nationalRules.forEach((rule, index) => {
      const at = `body/nationalRules/${index}`
      if (!RULE_KEY.test(rule.key) || keys.has(rule.key)) problems.push({ path: `${at}/key`, message: 'Each rule its own key of 1 to 60 characters without spaces ("fr-pfas").' })
      keys.add(rule.key)
      const words = Object.entries(rule.words)
      if (words.length === 0 || words.some(([language, text]) => !WORDS_LANGUAGE.test(language) || text.trim() === '' || text.length > 2000)) {
        problems.push({ path: `${at}/words`, message: 'The rule in words per language ({ "it": "…", "en": "…" }).' })
      }
      if (rule.law !== undefined && (rule.law.trim() === '' || rule.law.length > 300)) problems.push({ path: `${at}/law`, message: 'The law it rests on in 1 to 300 characters, or none.' })
      if (rule.href !== undefined && (rule.href.length > 2000 || !HTTPS.test(rule.href))) problems.push({ path: `${at}/href`, message: 'An https address, or none.' })
    })
  }
  if (draft.seq !== undefined && (!Number.isInteger(draft.seq) || draft.seq < 0)) problems.push({ path: 'body/seq', message: 'A place of 0 or more.' })
  if (draft.note !== undefined && draft.note !== null && (draft.note.trim() === '' || draft.note.length > NOTE_MAX)) problems.push({ path: 'body/note', message: `A note of 1 to ${NOTE_MAX} characters, or none.` })
  return problems
}

/** Why a switch is refused, in words (null: fine). OFF names its reason; a switch to the state it is in is refused. */
export function switchRefusal(input: { readonly code: string; readonly on: boolean; readonly switchedOn: boolean; readonly reason: string | null | undefined }): { code: string; message: string } | null {
  if (input.on === input.switchedOn) return { code: input.on ? 'ALREADY_ON' : 'ALREADY_OFF', message: `Market ${input.code} is already ${input.on ? 'on' : 'off'}.` }
  if (!input.on) {
    const reason = input.reason?.trim() ?? ''
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) return { code: 'REASON_NEEDED', message: `Say why market ${input.code} is off in ${REASON_MIN} to ${REASON_MAX} characters (the Owner question it waits for).` }
  }
  return null
}

export interface MarketLanguages {
  readonly code: string
  readonly name: string
  readonly switchedOn: boolean
  readonly labelLanguages: readonly string[]
  readonly docLanguages: readonly string[]
  readonly userInfoLanguages: readonly string[]
}

export interface LanguageMatrix {
  /** Every language some market needs, the switched-on markets' first, then alphabetical. */
  readonly languages: string[]
  readonly markets: { code: string; name: string; switchedOn: boolean; needs: { language: string; documents: MarketDocument[] }[] }[]
}

/** Which language each market needs for which document (the markets in their order). */
export function languageMatrix(markets: readonly MarketLanguages[]): LanguageMatrix {
  const onLanguages = new Set<string>()
  const all = new Set<string>()
  const rows = markets.map((market) => {
    const byLanguage = new Map<string, MarketDocument[]>()
    const add = (languages: readonly string[], document: MarketDocument) => {
      for (const language of languages) {
        byLanguage.set(language, [...(byLanguage.get(language) ?? []), document])
        all.add(language)
        if (market.switchedOn) onLanguages.add(language)
      }
    }
    add(market.labelLanguages, 'LABEL')
    add(market.docLanguages, 'DOC')
    add(market.userInfoLanguages, 'USER_INFO')
    return {
      code: market.code,
      name: market.name,
      switchedOn: market.switchedOn,
      needs: [...byLanguage.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([language, documents]) => ({ language, documents })),
    }
  })
  const sorted = (set: Iterable<string>) => [...set].sort()
  return { languages: [...sorted(onLanguages), ...sorted([...all].filter((language) => !onLanguages.has(language)))], markets: rows }
}
