import { DEFAULT_LOCALE, INTL_LOCALE, LOCALES, type Locale } from './locales'
// B-W2b-F51: a right in words, never its code (rights.ts).
import { rightOf, wordsOfRight } from './rights'

/**
 * The UI text catalogues (A1 §6.2, PLAN §4.6): one JSON file per area and language, `messages/<locale>/<area>.json`
 * (`shell`, later `sales`, `products` …). They are found by themselves (`import.meta.glob`, which Turbopack and Vitest
 * both read), so an area adds its file without editing this one. `scripts/factory/check-i18n.mjs` requires every key in
 * every language, with the same `{placeholders}`.
 *
 * A file is a tree of objects whose leaves are strings; a key is its path, `nav.admin.users`. A key ending in `_one` /
 * `_other` is a plural form: `t('results', { count })` picks the form `Intl.PluralRules` names for the language.
 */

export type Dictionary = Readonly<Record<string, string>>
/** The catalogues of one language: namespace → its keys. */
export type LocaleMessages = Readonly<Record<string, Dictionary>>
export type Params = Readonly<Record<string, string | number>>
export type Translate = (key: string, params?: Params) => string

// The module of a JSON file: its value is `default` (Turbopack, Vite); some bundlers give the value itself.
const MODULES = import.meta.glob('./*/*.json', { base: '../../../messages', eager: true }) as Record<string, unknown>
const valueOf = (module: unknown): unknown => (typeof module === 'object' && module !== null && 'default' in module ? (module as { default: unknown }).default : module)
const FILES: Record<string, unknown> = Object.fromEntries(Object.entries(MODULES).map(([path, module]) => [path, valueOf(module)]))

/** A catalogue tree as flat keys. Throws on anything but objects and strings: the files are code. */
export function flattenMessages(tree: unknown, prefix = ''): Record<string, string> {
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) throw new TypeError(`messages: ${prefix || 'the file'} is not an object`)
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${name}` : name
    if (typeof value === 'string') out[key] = value
    else Object.assign(out, flattenMessages(value, key))
  }
  return out
}

function buildCatalogue(): Readonly<Record<Locale, LocaleMessages>> {
  const catalogue = Object.fromEntries(LOCALES.map((locale) => [locale, {} as Record<string, Dictionary>])) as Record<Locale, Record<string, Dictionary>>
  for (const [path, tree] of Object.entries(FILES)) {
    // The key is relative to the calling file (Turbopack) or to `base` (Vite): the last two parts are what count.
    const match = /([^/]+)\/([^/]+)\.json$/.exec(path)
    if (!match) continue
    const [, locale, namespace] = match
    if (!(LOCALES as readonly string[]).includes(locale)) continue
    catalogue[locale as Locale][namespace] = Object.freeze(flattenMessages(tree))
  }
  return catalogue
}

/** Every catalogue, by language and namespace. */
export const CATALOGUE: Readonly<Record<Locale, LocaleMessages>> = buildCatalogue()

// ---- fix-voi-2: the words a reader outside the office reads -------------------------------------------------------

/**
 * Who reads a page: the office's own people (`office`), or someone outside it (`outside`) — a partner in the portal, or
 * whoever holds a link. The portal and the link pages say "voi" (a business writes to a business, #1618), but a few
 * catalogues are read by office screens too and say "tu" there. Their outside words live in ONE catalogue,
 * `messages/<locale>/outside-words.json`, under the namespace they belong to (`ds-words.stepUp.codeHint` is the
 * outside word for `ds-words:stepUp.codeHint`): for an outside reader each one wins over the shared catalogue's text,
 * key by key; the office reads the shared text unchanged. The portal's and the links' route groups say who reads
 * (provider.tsx `ReaderProvider`), the design index by the screen's folder. A key only portal or link pages read is
 * written in voi in its own catalogue: this file holds only what the office says otherwise.
 */
export type Reader = 'office' | 'outside'
export const OUTSIDE_WORDS = 'outside-words'

/** The outside words by language and namespace (`outside-words.json`'s first level names the namespace). */
const OUTSIDE: Readonly<Record<Locale, Readonly<Record<string, Dictionary>>>> = Object.fromEntries(
  LOCALES.map((locale) => {
    const byNamespace: Record<string, Record<string, string>> = {}
    for (const [path, text] of Object.entries(CATALOGUE[locale][OUTSIDE_WORDS] ?? {})) {
      const dot = path.indexOf('.')
      ;(byNamespace[path.slice(0, dot)] ??= {})[path.slice(dot + 1)] = text
    }
    return [locale, Object.freeze(Object.fromEntries(Object.entries(byNamespace).map(([namespace, words]) => [namespace, Object.freeze(words)])))]
  }),
) as Record<Locale, Readonly<Record<string, Dictionary>>>

/** One namespace's outside words in a language (empty when the office and the outside say it the same way). */
export function outsideWordsOf(locale: Locale, namespace: string): Dictionary {
  return OUTSIDE[locale]?.[namespace] ?? {}
}

/** A namespace's dictionary as `reader` reads it: outside, its outside words over the shared ones, key by key. */
export function dictionaryFor(locale: Locale, namespace: string, dictionary: Dictionary, reader: Reader): Dictionary {
  const own = reader === 'outside' ? OUTSIDE[locale]?.[namespace] : undefined
  return own ? { ...dictionary, ...own } : dictionary
}

/** A namespace straight from the catalogue, as `reader` reads it (for parts that need no provider: ds-parts). */
export function catalogueFor(locale: Locale, namespace: string, reader: Reader): Dictionary {
  return dictionaryFor(locale, namespace, (CATALOGUE[locale] ?? CATALOGUE[DEFAULT_LOCALE])[namespace] ?? {}, reader)
}

/** The catalogues a page needs, for one language: the provider passes only these to the browser. */
export function messagesFor(locale: Locale, namespaces: readonly string[]): LocaleMessages {
  const own = CATALOGUE[locale] ?? CATALOGUE[DEFAULT_LOCALE]
  return Object.fromEntries(namespaces.map((namespace) => [namespace, own[namespace] ?? {}]))
}

const PLACEHOLDER = /\{(\w+)\}/g

/** `{name}` → its value. A placeholder with no value is left as it is, so a missing parameter shows. */
export function interpolate(text: string, params?: Params): string {
  if (!params) return text
  return text.replace(PLACEHOLDER, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

/** The placeholders a text uses, sorted: the i18n check compares them across languages. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort()
}

// ---- B-W2b-F51: a right in words, never its code -------------------------------------------------------------------

/** A right's words in a language (the role screens' own words, admin.json `perm.*`, said short: rights.ts headlineOf): never the permission code. */
export function rightWords(locale: Locale, permission: string): string {
  return wordsOfRight(permission, CATALOGUE[locale]?.admin, CATALOGUE[DEFAULT_LOCALE]?.admin)
}

/** The parameters with every `rightRef(permission)` said as the right's words in the language. */
function withRights(locale: Locale, params: Params | undefined): Params | undefined {
  if (!params || !Object.values(params).some((value) => rightOf(value) !== null)) return params
  return Object.fromEntries(Object.entries(params).map(([name, value]) => {
    const permission = rightOf(value)
    return [name, permission === null ? value : rightWords(locale, permission)]
  }))
}

/**
 * A translator for one namespace. A missing key answers the key itself (visible on screen, caught by the i18n test);
 * `count` picks a plural form when `<key>_one` / `<key>_other` exist. A parameter made with `rightRef(permission)`
 * (rights.ts) is said as the right's words in this language (B-W2b-F51).
 */
export function createTranslator(locale: Locale, dictionary: Dictionary): Translate {
  const plurals = new Intl.PluralRules(INTL_LOCALE[locale])
  return (key, params) => {
    let text = dictionary[key]
    if (text === undefined && params && typeof params.count === 'number') {
      text = dictionary[`${key}_${plurals.select(params.count)}`] ?? dictionary[`${key}_other`]
    }
    return text === undefined ? key : interpolate(text, withRights(locale, params))
  }
}

/** A translator over `namespace:key` keys, for code that holds keys of several namespaces (navigation labels); fix-voi-2: as `reader` reads them. */
export function createScopedTranslator(locale: Locale, messages: LocaleMessages, fallbackNamespace: string, reader: Reader = 'office'): Translate {
  const cache = new Map<string, Translate>()
  const forNamespace = (namespace: string) => {
    let t = cache.get(namespace)
    if (!t) {
      t = createTranslator(locale, dictionaryFor(locale, namespace, messages[namespace] ?? {}, reader))
      cache.set(namespace, t)
    }
    return t
  }
  return (key, params) => {
    const colon = key.indexOf(':')
    return colon > 0 ? forNamespace(key.slice(0, colon))(key.slice(colon + 1), params) : forNamespace(fallbackNamespace)(key, params)
  }
}
