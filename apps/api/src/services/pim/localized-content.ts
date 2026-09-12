import { contentSlots } from './content-locale.js'
import { coerceForShape, type ShapeWriteFacts } from './sheet-values.js'

export const isContentLocale = (key: string) => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(key)
const CORE: Record<string, ShapeWriteFacts> = {
  title: { kind: 'text' }, description: { kind: 'text' },
  bulletPoints: { shape: 'list', cardinality: { min: 0, max: null } },
  keywords: { shape: 'list', cardinality: { min: 0, max: null } },
}

/** Locale edits and numbered list edits share one lossless merge. */
export function mergeLocalizedContent(current: unknown, patch: Record<string, unknown> | undefined, custom: Record<string, ShapeWriteFacts> = {}, reset: Record<string, string[]> = {}): Record<string, Record<string, unknown>> {
  const merged = contentSlots({ localizedContent: current && typeof current === 'object' && !Array.isArray(current) ? current : {} })
  for (const [tag, raw] of Object.entries(patch ?? {})) {
    const locale = tag.toLowerCase()
    if (!isContentLocale(locale) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const next = { ...merged[locale] }
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue
      const slot = /^(bulletPoints|keywords)\[(\d+)\]$/.exec(key)
      if (slot) {
        const list = Array.isArray(next[slot[1]]) ? [...next[slot[1]] as unknown[]] : []
        const index = Number(slot[2]) - 1
        while (list.length <= index) list.push('')
        list[index] = value ?? ''
        while (list.length && list[list.length - 1] === '') list.pop()
        next[slot[1]] = list
      } else {
        const coerced = custom[key] ? coerceForShape(custom[key], value) : null
        next[key] = coerced?.ok ? coerced.value : value
      }
    }
    merged[locale] = next
  }
  for (const [tag, keys] of Object.entries(reset)) {
    const locale = tag.toLowerCase()
    const next = { ...merged[locale] }
    const metadata = { ...(next._meta as Record<string, unknown> ?? {}) }
    for (const key of keys) { delete next[key]; delete metadata[key] }
    if (next._meta) next._meta = metadata
    merged[locale] = next
  }
  return merged
}

export function validateLocalizedPatch(patch: Record<string, unknown>, custom: Record<string, ShapeWriteFacts> = {}): string[] {
  const errors: string[] = []
  for (const [locale, raw] of Object.entries(patch)) {
    if (['identifiers', 'physical', 'technical'].includes(locale)) continue
    if (!isContentLocale(locale)) { errors.push(`Unsupported content locale: ${locale}`); continue }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`patch.${locale} must be an object`); continue }
    for (const [key, value] of Object.entries(raw)) {
      const slot = /^(bulletPoints|keywords)\[(\d+)\]$/.exec(key)
      const facts = slot ? Number(slot[2]) >= 1 && Number(slot[2]) <= 1000 ? { kind: 'text' } : undefined : CORE[key] ?? custom[key]
      if (!facts) { errors.push(`Unknown localized attribute: ${key}`); continue }
      if ((slot || ['title', 'description'].includes(key)) && value !== null && value !== undefined && typeof value !== 'string') {
        errors.push(`patch.${locale}.${key} must be text or null`); continue
      }
      if (['bulletPoints', 'keywords'].includes(key) && value !== null && value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
        errors.push(`patch.${locale}.${key} must be an array of text or null`); continue
      }
      const result = coerceForShape({ ...facts, label: key }, value)
      if (result.ok === false) errors.push(`patch.${locale}.${key}: ${result.error}`)
    }
  }
  return errors
}
