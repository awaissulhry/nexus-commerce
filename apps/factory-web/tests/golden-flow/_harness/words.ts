import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The screens' own words, read from the app's catalogues (apps/factory-web/messages/en/<namespace>.json), so a stage
 * names a button or a field by its message key, as the screen does: a reworded label changes here by itself, a removed
 * key fails loudly. The flow runs in English (every person, worker and context speaks `en`).
 */

const MESSAGES = fileURLToPath(new URL('../../../messages/en/', import.meta.url))
const cache = new Map<string, Record<string, string>>()

function flat(tree: Record<string, unknown>, prefix = '', into: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') into[path] = value
    else if (value && typeof value === 'object') flat(value as Record<string, unknown>, path, into)
  }
  return into
}

function catalogue(namespace: string): Record<string, string> {
  let found = cache.get(namespace)
  if (!found) {
    found = flat(JSON.parse(readFileSync(`${MESSAGES}${namespace}.json`, 'utf8')) as Record<string, unknown>)
    cache.set(namespace, found)
  }
  return found
}

/** `t('orders')('record.send', { n: 2 })`: the English text of a key, placeholders filled; plurals take `_other`. */
export function words(namespace: string) {
  const dict = catalogue(namespace)
  return (key: string, params: Record<string, string | number> = {}): string => {
    const count = typeof params.count === 'number' ? params.count : undefined
    let text = (count === 1 ? dict[`${key}_one`] : undefined) ?? dict[key] ?? dict[`${key}_other`]
    if (text === undefined) throw new Error(`no message ${namespace}:${key}`)
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

/** A text as a regular expression that matches it exactly (for accessible names), placeholders left as `.*`. */
export function exactly(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[a-zA-Z]+\\\}/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** The start of a text (a label followed by a count or an icon's name). */
export function startsWith(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
}
