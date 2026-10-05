/**
 * W3 PR-A — Amazon's English names beside the market's own (docs/product-sheet-consistency/wave3/plan-W3-amazon.md).
 *
 * Amazon gives option names (`enumNames`) and help text only in the language of the download, so an IT or DE market
 * row has no English names. `CategorySchemaService.refreshEnglishCopy` keeps a second download of the same
 * marketplace and product type in English (`CategorySchema` channel `AMAZON_EN`); this joins the two specs:
 *  - the MARKET row decides everything Amazon accepts — fields, options, mode, requirement, caps. The English copy only
 *    adds `optionLabelsEnglish` (for codes in the market's option list) and `helpTextEnglish`;
 *  - joined by spec key and option code. A field or code the English copy lacks keeps the market name (nothing is
 *    added for it); a field or code only the English copy has is ignored;
 *  - a market whose own download is English needs no copy: `english` names the market row itself.
 * `spec.english` says where English names come from, or null when none is downloaded yet.
 *
 * W3-2 (PR-B) — what the operator sees (`amazonInEnglish`): every option named in English where Amazon gave an English
 * name, the market's name kept as an accepted spelling (`optionAliases`), help in English; before the English copy
 * exists, the market's words with one line saying so. The code stored and sent never changes.
 *
 * Pure: no prisma.
 */
import type { ChannelFieldSpec, ChannelSpec } from './types.js'
import { AMAZON_FULFILMENT_KEY } from './amazon.js'
import { MARKET_CATALOGUE } from '../market-catalogue.js'

/** The locale a cached Amazon definition was downloaded in (`__schemaProvenance.locale`), or null when unrecorded. */
export function schemaLocale(spec: Pick<ChannelSpec, 'validationSchema'> | null | undefined): string | null {
  const provenance = (spec?.validationSchema as { __schemaProvenance?: { locale?: unknown } } | undefined)?.__schemaProvenance
  return typeof provenance?.locale === 'string' && provenance.locale ? provenance.locale : null
}

/** `en_GB`, `en_US`, `en-IE`, `en` — English; anything else (or nothing) is not. */
export function isEnglishLocale(locale: unknown): boolean {
  return typeof locale === 'string' && /^en(?:[_-]|$)/i.test(locale.trim())
}

/** The market spec with Amazon's English names joined in from the English copy (`englishSpec`, null when none). */
export function withEnglish(spec: ChannelSpec, englishSpec: ChannelSpec | null): ChannelSpec {
  const marketLocale = schemaLocale(spec)
  if (marketLocale && isEnglishLocale(marketLocale)) return { ...spec, english: { locale: marketLocale, fetchedAt: spec.fetchedAt } }
  const englishLocale = schemaLocale(englishSpec)
  if (!englishSpec || !englishLocale || !isEnglishLocale(englishLocale)) return { ...spec, english: null }
  const byKey = new Map(englishSpec.fields.map(field => [field.key, field]))
  return {
    ...spec,
    fields: spec.fields.map(field => joinField(field, byKey.get(field.key))),
    english: { locale: englishLocale, fetchedAt: englishSpec.fetchedAt },
  }
}

function joinField(field: ChannelFieldSpec, english: ChannelFieldSpec | undefined): ChannelFieldSpec {
  if (!english) return field
  let out = field
  if (field.options?.length && english.optionLabels) {
    const names: Record<string, string> = {}
    for (const code of field.options) {
      const name = english.optionLabels[code]
      if (typeof name === 'string' && name.trim()) names[code] = name
    }
    if (Object.keys(names).length) out = { ...out, optionLabelsEnglish: names }
  }
  if (typeof english.helpText === 'string' && english.helpText.trim()) out = { ...out, helpTextEnglish: english.helpText }
  return out
}

/** The language of a market's own download: its recorded locale, else the market catalogue's first language. */
function marketLanguage(spec: Pick<ChannelSpec, 'validationSchema' | 'marketplace'>): string | null {
  const locale = schemaLocale(spec)
  if (locale) return locale.split(/[_-]/)[0].toLowerCase()
  return MARKET_CATALOGUE.find(m => m.channel === 'AMAZON' && m.code === String(spec.marketplace).toUpperCase())?.language ?? null
}

function languageName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code } catch { return code }
}

/**
 * W3-2 (Owner decisions 1 and 3) — the line a non-English Amazon market shows before its English copy is downloaded:
 * "Amazon's English names are not downloaded yet. This shows Amazon's Italian words." Null when English names are
 * there (`spec.english` set), when the market itself is English, or when the spec was never joined (`english`
 * undefined: not an Amazon market spec).
 */
export function englishMissingLine(spec: ChannelSpec): string | null {
  if (spec.channel !== 'AMAZON' || spec.english !== null) return null
  const language = marketLanguage(spec)
  if (!language || language === 'en') return null
  return `Amazon's English names are not downloaded yet. This shows Amazon's ${languageName(language)} words.`
}

const fold = (text: string) => text.trim().toLocaleLowerCase()

/**
 * One field as the operator sees it (W3-2): options named in English where the English copy names them, the market's
 * name kept as an accepted spelling; help text in English. `line` (`englishMissingLine`) leads the help of a field that
 * shows Amazon's market words. Options, mode, requirement and caps are untouched.
 */
export function amazonFieldInEnglish(field: ChannelFieldSpec, line: string | null = null, ownWords = true): ChannelFieldSpec {
  let out = field
  const english = field.optionLabelsEnglish
  if (english && Object.keys(english).length) {
    const aliases: Record<string, string[]> = Object.fromEntries(Object.entries(field.optionAliases ?? {}).map(([code, names]) => [code, [...names]]))
    for (const [code, name] of Object.entries(english)) {
      const market = field.optionLabels?.[code]
      if (market && fold(market) !== fold(name) && !(aliases[code] ?? []).some(alias => fold(alias) === fold(market))) aliases[code] = [...(aliases[code] ?? []), market]
    }
    out = { ...out, optionLabels: { ...(field.optionLabels ?? {}), ...english }, ...(Object.keys(aliases).length ? { optionAliases: aliases } : {}) }
  }
  const marketWords = ownWords && (!!field.helpText || Object.keys(field.optionLabels ?? {}).length > 0)
  const helpText = line && marketWords ? [line, field.helpText].filter(Boolean).join(' ') : field.helpTextEnglish ?? field.helpText
  if (helpText !== field.helpText) out = { ...out, helpText }
  return out
}

/**
 * W3-2 — an Amazon spec as the operator sees it (`amazonFieldInEnglish` on every field). A spec that was never joined
 * (`english` undefined) and every other channel come back as they are. Nexus's own wording (the fulfilment choice, a
 * shape the walker does not recognise) is not Amazon's and takes no line.
 */
export function amazonInEnglish(spec: ChannelSpec): ChannelSpec {
  if (spec.channel !== 'AMAZON' || spec.english === undefined) return spec
  const line = englishMissingLine(spec)
  const nexusWords = new Set([AMAZON_FULFILMENT_KEY, ...spec.unrecognised.map(entry => entry.split(':')[0])])
  return { ...spec, fields: spec.fields.map(field => amazonFieldInEnglish(field, line, !nexusWords.has(field.key))) }
}
