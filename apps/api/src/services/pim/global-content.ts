import type { ProductLike } from './attribute-resolver.js'
import { resolveContentAttributes, contentLanguages } from './content-read.js'
import { normalizeLanguage } from './content-language.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'

export interface GlobalLocaleSlot {
  title: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
}

/** Step 1 projection: the existing resolver consumes table rows and native source
 * columns. Legacy JSON is excluded from this read and is never copied to a table.
 * Configured marketplace languages and the source language remain visible;
 * an absent translation retains its existing source fallback until LX.7.
 */
export function globalContentLocales(product: ProductLike, parent: ProductLike | null, configuredLanguages: readonly string[] = []): Record<string, GlobalLocaleSlot> {
  const languages = new Set([...contentLanguages(product, parent), ...configuredLanguages.map(normalizeLanguage)])
  return Object.fromEntries([...languages].sort().map(language => {
    const resolved = resolveContentAttributes({ product, parent, requested: language })
    return [language, {
      title: (resolved.title?.value as string) ?? null,
      description: (resolved.description?.value as string) ?? null,
      bulletPoints: (resolved.bulletPoints?.value as string[]) ?? [],
      keywords: (resolved.keywords?.value as string[]) ?? [],
    }]
  }))
}
