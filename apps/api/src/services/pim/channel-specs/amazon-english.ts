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
 * Pure: no prisma. Nothing reads the English names yet (the sheet's display is W3 PR-B).
 */
import type { ChannelFieldSpec, ChannelSpec } from './types.js'

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
