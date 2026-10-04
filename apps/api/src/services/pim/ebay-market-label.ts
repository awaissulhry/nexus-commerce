/**
 * E1b (product sheet consistency, 2026-10-05) — the word eBay receives for a dictionary value, in the market's language.
 *
 * A colour or size is stored in two forms that name the SAME dictionary option: the sheet stores the option code (`black`,
 * `xs`), the Variations writer stores the dictionary spelling (`Nero`). eBay is sent neither as such: it gets the option's
 * word in the market's language, first of
 *   1. the option's own label for that language (`metadata.labels.it` → `Nero`);
 *   2. the concept's label for the value (`valueLabels.black.de` → `Schwarz`, for an option seeded before it had labels);
 *   3. the dictionary's spelling of the name the text matched (`matchValue`: `xs` → `XS`, `XXXL` stays `XXXL`);
 *   4. otherwise the stored text as it is (an attribute or value the dictionary does not know).
 * Pure: the stored value is never rewritten. Amazon, Shopify and Etsy never call it.
 */
import { conceptByKey, conceptValueCode, type ValueLanguage } from '@nexus/shared/attribute-concepts'
import { attributeForAxis, matchValue, optionForValue, type DictionaryAttribute, type DictionaryOption } from './family-variations-core.js'

/** The market language as a label key (`it`, `de-DE` → `de`). */
const labelLanguage = (language: string) => language.trim().toLowerCase().split(/[-_]/)[0]

function ownLabel(option: DictionaryOption, language: string): string | null {
  const metadata = option.metadata && typeof option.metadata === 'object' && !Array.isArray(option.metadata) ? option.metadata as Record<string, unknown> : null
  const labels = metadata?.labels && typeof metadata.labels === 'object' && !Array.isArray(metadata.labels) ? metadata.labels as Record<string, unknown> : null
  const label = labels?.[language]
  return typeof label === 'string' && label.trim() ? label.trim() : null
}

/**
 * The market word for `value` of the dictionary attribute `attribute` names (its code, concept or label — `color`,
 * `Colore`), or `value` unchanged when the dictionary cannot say.
 */
export function ebayMarketLabel(dictionary: readonly DictionaryAttribute[], attribute: string, value: string, language: string): string {
  if (typeof value !== 'string' || !value.trim() || !attribute?.trim()) return value
  const found = attributeForAxis(attribute, dictionary).attribute
  if (!found) return value
  const option = optionForValue(value, found)
  if (!option) return value
  const lang = labelLanguage(language ?? '')
  const own = lang ? ownLabel(option, lang) : null
  if (own) return own
  const concept = conceptByKey(found.semanticKey)
  const valueCode = concept ? conceptValueCode(concept, option.code) : undefined
  const conceptLabel = valueCode && lang ? concept?.valueLabels?.[valueCode]?.[lang as ValueLanguage] : undefined
  if (conceptLabel) return conceptLabel
  return matchValue(value, found)?.spelled ?? value
}

/**
 * The eBay market word for one market: `(attribute, value) → word`. A value the dictionary leaves as it is comes back
 * unchanged. One dictionary read serves every value of a batch.
 */
export function ebayMarketWords(dictionary: readonly DictionaryAttribute[], language: string): (attribute: string, value: string) => string {
  return (attribute, value) => ebayMarketLabel(dictionary, attribute, value, language)
}
