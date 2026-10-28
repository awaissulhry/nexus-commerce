import { DEFAULT_LOCALE, INTL_LOCALE, LOCALES, type Locale } from './locales'

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

/**
 * A translator for one namespace. A missing key answers the key itself (visible on screen, caught by the i18n test);
 * `count` picks a plural form when `<key>_one` / `<key>_other` exist.
 */
export function createTranslator(locale: Locale, dictionary: Dictionary): Translate {
  const plurals = new Intl.PluralRules(INTL_LOCALE[locale])
  return (key, params) => {
    let text = dictionary[key]
    if (text === undefined && params && typeof params.count === 'number') {
      text = dictionary[`${key}_${plurals.select(params.count)}`] ?? dictionary[`${key}_other`]
    }
    return text === undefined ? key : interpolate(text, params)
  }
}

/** A translator over `namespace:key` keys, for code that holds keys of several namespaces (navigation labels). */
export function createScopedTranslator(locale: Locale, messages: LocaleMessages, fallbackNamespace: string): Translate {
  const cache = new Map<string, Translate>()
  const forNamespace = (namespace: string) => {
    let t = cache.get(namespace)
    if (!t) {
      t = createTranslator(locale, messages[namespace] ?? {})
      cache.set(namespace, t)
    }
    return t
  }
  return (key, params) => {
    const colon = key.indexOf(':')
    return colon > 0 ? forNamespace(key.slice(0, colon))(key.slice(colon + 1), params) : forNamespace(fallbackNamespace)(key, params)
  }
}
