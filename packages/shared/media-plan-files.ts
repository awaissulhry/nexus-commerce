import type { MediaSetRef } from './media-plan.js'

/**
 * File-name rules for "Upload photos" (PLAN.md §4.6): read the set, the position and the language from a file name,
 * so 18 files land in the right places in one step. The dialog shows every guess and each one can be changed; unknown
 * files go to Common, never nowhere. Pure and deterministic — the same name always gives the same answer.
 */

export interface FileNameContext {
  /** Values of the picture axis: the label shown, and every name they go by (code, labels per language, synonyms). */
  values: Array<{ key: string; label: string; names: string[] }>
  skus: Array<{ productId: string; sku: string }>
}
export interface ParsedFileName {
  set: MediaSetRef
  /** 1-based; null = the end of the set. */
  position: number | null
  /** `zxx` when no language is named. */
  language: string
  swatch: boolean
  /** The name without its language, so `size-chart-it` and `size-chart-de` are versions of one photo. */
  base: string
  /** What decided the set, in words ("Nero in the name"), or why nothing did. */
  reason: string
}

const LANGUAGE_WORDS: Record<string, string> = {
  it: 'it', ita: 'it', italiano: 'it', italian: 'it',
  de: 'de', deu: 'de', ger: 'de', deutsch: 'de', german: 'de',
  fr: 'fr', fra: 'fr', fre: 'fr', francais: 'fr', french: 'fr',
  es: 'es', esp: 'es', spa: 'es', espanol: 'es', spanish: 'es',
  en: 'en', eng: 'en', english: 'en', uk: 'en',
  nl: 'nl', nld: 'nl', dutch: 'nl', nederlands: 'nl',
  pl: 'pl', pol: 'pl', polski: 'pl', polish: 'pl',
  sv: 'sv', swe: 'sv', svenska: 'sv', swedish: 'sv',
  mul: 'mul', multi: 'mul', multilingual: 'mul',
}
const COMMON_WORDS = new Set(['common', 'comune', 'comuni', 'shared', 'size', 'sizechart', 'sizeguide', 'taglie', 'guida', 'tabella', 'detail', 'details', 'dettaglio', 'lifestyle', 'infographic', 'infografica'])
const SWATCH_WORDS = new Set(['swatch', 'swch', 'campione'])

const fold = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
const tokens = (text: string) => fold(text).split(/[\s_\-.#()[\]+,]+/).filter(Boolean)
const squash = (parts: string[]) => parts.join('')

/** The longest run of name tokens that equals `target` (both folded, separators removed). */
function containsRun(parts: string[], target: string): boolean {
  if (!target) return false
  for (let i = 0; i < parts.length; i++) {
    let joined = ''
    for (let j = i; j < parts.length && joined.length < target.length; j++) {
      joined += parts[j]
      if (joined === target) return true
    }
  }
  return false
}

export function parseMediaFileName(fileName: string, ctx: FileNameContext): ParsedFileName {
  const stem = fileName.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,5}$/i, '')
  const parts = tokens(stem)
  const languageIndex = parts.findIndex((part, i) => part in LANGUAGE_WORDS && (i > 0 || parts.length === 1))
  const language = languageIndex >= 0 ? LANGUAGE_WORDS[parts[languageIndex]] : 'zxx'
  const rest = languageIndex >= 0 ? parts.filter((_, i) => i !== languageIndex) : parts
  const base = rest.join('-') || stem.toLowerCase()

  let position: number | null = null
  const pt = rest.find(p => /^pt0?[1-8]$/.test(p))
  if (rest.includes('main')) position = 1
  else if (pt) position = Number(pt.replace(/\D/g, '')) + 1
  else { const n = [...rest].reverse().find(p => /^\d{1,2}$/.test(p)); if (n && Number(n) > 0) position = Number(n) }

  const safety = rest.find(p => /^ps0?[1-6]$/.test(p))
  if (safety) return { set: 'safety', position: Number(safety.replace(/\D/g, '')), language, swatch: false, base, reason: `${safety.toUpperCase()} in the name` }

  const sku = [...ctx.skus].sort((a, b) => b.sku.length - a.sku.length).find(s => containsRun(rest, squash(tokens(s.sku))))
  if (sku) return { set: `sku:${sku.productId}`, position, language, swatch: false, base, reason: `SKU ${sku.sku} in the name` }

  const hits = ctx.values.filter(v => [v.label, ...v.names].some(name => containsRun(rest, squash(tokens(name)))))
  const swatch = rest.some(p => SWATCH_WORDS.has(p))
  if (hits.length === 1) return { set: `value:${hits[0].key}`, position: swatch ? null : position, language, swatch, base, reason: `${hits[0].label} in the name` }
  if (hits.length > 1) return { set: 'common', position, language, swatch: false, base, reason: `Names more than one value (${hits.map(h => h.label).join(', ')}) — choose one` }
  return { set: 'common', position, language, swatch: false, base,
    reason: rest.some(p => COMMON_WORDS.has(p)) ? 'Common photo' : 'No value or SKU in the name — check it' }
}

/** Files whose names differ only by language become versions of one photo: base → files, when 2+ languages. */
export function versionGroups(parsed: ReadonlyArray<{ id: string; parsed: ParsedFileName }>): Map<string, string[]> {
  const byBase = new Map<string, Array<{ id: string; language: string }>>()
  for (const { id, parsed: p } of parsed) byBase.set(`${p.set}|${p.base}`, [...(byBase.get(`${p.set}|${p.base}`) ?? []), { id, language: p.language }])
  const groups = new Map<string, string[]>()
  for (const [base, files] of byBase) {
    const languages = new Set(files.map(f => f.language))
    if (files.length > 1 && languages.size === files.length && !languages.has('zxx')) groups.set(base, files.map(f => f.id))
  }
  return groups
}
