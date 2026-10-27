/**
 * Reviews — a review's language guessed from its own words, for the rows the AI never read (`Review.language` is filled
 * by the sentiment read at ingest or by "Translate"; older rows, eBay's included, have none). Only to say "Italian (from
 * the text)" and to offer "Translate to English" only for text that is not English — never stored, never sent anywhere.
 *
 * The guess counts common short words of English, Italian, German, French and Spanish; it answers only when one
 * language clearly leads (at least two of its words and more than any other), else null ("not known"). Pure; tested in
 * review-language.vitest.test.ts.
 */

const WORDS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'with', 'very', 'good', 'great', 'item', 'order', 'delivered', 'on', 'time', 'no', 'issues', 'seller', 'fast', 'was', 'is', 'it', 'as', 'described', 'thanks', 'thank', 'you', 'product', 'quality', 'recommend', 'excellent', 'perfect', 'nice', 'of', 'to', 'for', 'my'],
  it: ['il', 'lo', 'la', 'e', 'di', 'che', 'con', 'per', 'molto', 'ottimo', 'ottima', 'venditore', 'prodotto', 'come', 'da', 'descrizione', 'tutto', 'arrivato', 'consigliato', 'grazie', 'non', 'perfetto', 'veloce', 'serio', 'una', 'un', 'del', 'della', 'sono', 'è', 'taglia', 'ma', 'anche', 'bello', 'qualità'],
  de: ['der', 'die', 'das', 'und', 'ist', 'sehr', 'gut', 'mit', 'nicht', 'ich', 'ein', 'eine', 'schnell', 'alles', 'artikel', 'verkäufer', 'danke', 'top', 'wie', 'beschrieben', 'zu', 'auch', 'für', 'lieferung', 'gerne', 'wieder'],
  fr: ['le', 'la', 'les', 'et', 'est', 'très', 'bien', 'avec', 'pas', 'je', 'un', 'une', 'vendeur', 'produit', 'merci', 'conforme', 'rapide', 'qualité', 'prix', 'rapport', 'bon', 'parfait', 'des', 'du', 'pour', 'au'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'muy', 'bien', 'con', 'no', 'un', 'una', 'vendedor', 'producto', 'gracias', 'todo', 'rápido', 'perfecto', 'calidad', 'como', 'descrito', 'para', 'del', 'llegó', 'bueno'],
}

/** The language a text is most likely in ('en', 'it', 'de', 'fr', 'es'), or null when the words do not say. Pure. */
export function guessLanguage(text: string | null | undefined): string | null {
  const tokens = (text ?? '').toLowerCase().match(/[\p{L}]+/gu) ?? []
  if (tokens.length === 0) return null
  const scores = Object.entries(WORDS).map(([lang, words]) => {
    const set = new Set(words)
    return { lang, score: tokens.filter((t) => set.has(t)).length }
  }).sort((a, b) => b.score - a.score)
  const [best, next] = scores
  if (!best || best.score < 2 || best.score <= (next?.score ?? 0)) return null
  return best.lang
}
