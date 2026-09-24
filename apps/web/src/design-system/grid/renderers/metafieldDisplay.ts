/**
 * GDS — a stored value read by its TYPE, for display in a grid cell.
 *
 * The type vocabulary is Shopify's metafield types (`single_line_text_field`, `file_reference`,
 * `list.metaobject_reference`, `color`, `rating`, …). A connected store decides which fields exist,
 * so the cell must decide its look from the type alone: a store with two fields and a store with
 * forty render with the same rules and no per-store code (Owner, 2026-09-24).
 *
 * Pure and tested; `MetafieldValue.tsx` draws the result. The raw value is the stored string —
 * JSON for lists and structured values, the plain value otherwise.
 */

export type MetafieldReferenceKind = 'file' | 'product' | 'variant' | 'collection' | 'page' | 'entry' | 'other'

export interface MetafieldReference {
  id: string
  /** The resolved name, or the kind's word while names load (never a raw ID). */
  label: string
  /** A small picture: a file's image, a video's poster, a product's featured image. */
  src: string | null
  kind: MetafieldReferenceKind
  /** False until a name was resolved for it. */
  named: boolean
}

export type MetafieldDisplay =
  | { kind: 'empty'; text: '' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'boolean'; value: boolean; text: string }
  | { kind: 'colors'; colors: string[]; text: string }
  | { kind: 'rating'; value: number; max: number; text: string }
  | { kind: 'references'; items: MetafieldReference[]; text: string }
  | { kind: 'values'; items: string[]; text: string }
  | { kind: 'invalid'; text: string }

export interface MetafieldDisplayOptions {
  /** Reference id → display name (resolved by the host, e.g. a store's name lookup). */
  labels?: Record<string, string>
  /** Reference id → picture URL. */
  images?: Record<string, string>
}

export const METAFIELD_INVALID_TEXT = 'Stored value needs review'

const REFERENCE_WORD: Record<MetafieldReferenceKind, string> = {
  file: 'File', product: 'Product', variant: 'Variant', collection: 'Collection', page: 'Page', entry: 'Entry', other: 'Reference',
}

/** `gid://shopify/MediaImage/1` → `file`. Unknown resources are `other`, never guessed. */
export function referenceKindOf(id: string): MetafieldReferenceKind {
  const resource = /^gid:\/\/shopify\/([A-Za-z0-9]+)\//.exec(id)?.[1] ?? ''
  if (['MediaImage', 'GenericFile', 'Video', 'ExternalVideo', 'Model3d'].includes(resource)) return 'file'
  if (resource === 'Product') return 'product'
  if (resource === 'ProductVariant') return 'variant'
  if (resource === 'Collection') return 'collection'
  if (resource === 'Page') return 'page'
  if (resource === 'Metaobject') return 'entry'
  return 'other'
}

export const isReferenceType = (type: string) => /_reference$/.test(type.replace(/^list\./, ''))

const parse = (raw: string): unknown => JSON.parse(raw)
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Types stored as a JSON object; every other scalar type is stored as its plain text. */
const STRUCTURED = new Set(['money', 'rating', 'link', 'weight', 'volume', 'dimension', 'rich_text_field', 'json'])
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Rich text is a node tree; its words are what a cell can show. */
function richText(node: unknown): string {
  if (!isRecord(node)) return ''
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : ''
  const children = Array.isArray(node.children) ? node.children.map(richText).filter(Boolean) : []
  return children.join(node.type === 'root' ? ' · ' : '')
}

/** One scalar value (a list's item or a single value) as words. */
function scalarText(base: string, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') {
    if (base === 'boolean') return value === true || value === 'true' ? 'Yes' : value === false || value === 'false' ? 'No' : String(value)
    return String(value)
  }
  if (!isRecord(value)) return JSON.stringify(value)
  if (base === 'money' && value.amount !== undefined) return `${value.amount} ${value.currency_code ?? ''}`.trim()
  if (base === 'rating' && value.value !== undefined) return `${value.value} / ${value.scale_max ?? 5}`
  if (base === 'link' && typeof value.text === 'string') return value.text || String(value.url ?? '')
  if (value.value !== undefined && value.unit !== undefined) return `${value.value} ${String(value.unit).toLowerCase().replace(/_/g, ' ')}`
  if (base === 'rich_text_field') return richText(value)
  return `${Object.keys(value).length} properties`
}

/**
 * The display model for one stored value. Never throws: a value that does not parse for its type is
 * `invalid` and says so, and a type this module does not know shows its stored text.
 */
export function metafieldDisplay(type: string, raw: string | null | undefined, options: MetafieldDisplayOptions = {}): MetafieldDisplay {
  if (raw === null || raw === undefined || raw === '') return { kind: 'empty', text: '' }
  const list = type.startsWith('list.')
  const base = list ? type.slice(5) : type
  try {
    if (isReferenceType(type)) {
      const ids = list ? parse(raw) : [raw]
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return { kind: 'invalid', text: METAFIELD_INVALID_TEXT }
      if (!ids.length) return { kind: 'empty', text: '' }
      const items = (ids as string[]).map(id => {
        const kind = referenceKindOf(id)
        const name = options.labels?.[id]
        return { id, kind, label: name ?? REFERENCE_WORD[kind], src: options.images?.[id] ?? null, named: !!name }
      })
      return { kind: 'references', items, text: items.map(item => item.label).join(', ') }
    }
    const parsed: unknown = list ? parse(raw) : [STRUCTURED.has(base) ? parse(raw) : raw]
    if (!Array.isArray(parsed)) return { kind: 'invalid', text: METAFIELD_INVALID_TEXT }
    const values: unknown[] = parsed
    if (!values.length) return { kind: 'empty', text: '' }
    if (base === 'color') {
      const colors = values.map(String)
      if (colors.some(c => !COLOR.test(c))) return { kind: 'text', text: colors.join(', ') }
      return { kind: 'colors', colors, text: colors.join(', ') }
    }
    if (!list && base === 'boolean') {
      const value = raw === 'true'
      if (raw !== 'true' && raw !== 'false') return { kind: 'text', text: raw }
      return { kind: 'boolean', value, text: value ? 'Yes' : 'No' }
    }
    if (!list && base === 'rating' && isRecord(values[0])) {
      const r = values[0]
      const value = Number(r.value), max = Number(r.scale_max ?? 5)
      if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return { kind: 'invalid', text: METAFIELD_INVALID_TEXT }
      return { kind: 'rating', value, max, text: `${value} / ${max}` }
    }
    const words = values.map(v => scalarText(base, v))
    if (list) return { kind: 'values', items: words, text: words.join(', ') }
    if (['number_integer', 'number_decimal'].includes(base)) return { kind: 'number', text: words[0] }
    if (['date', 'date_time'].includes(base)) {
      const at = new Date(raw)
      return { kind: 'text', text: Number.isNaN(at.getTime()) ? raw : base === 'date' ? raw : at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' }
    }
    // Multi-line text: the first line in the cell, the whole text in the editor.
    return { kind: 'text', text: base === 'multi_line_text_field' ? words[0].split('\n').find(Boolean) ?? '' : words[0] }
  } catch {
    return { kind: 'invalid', text: METAFIELD_INVALID_TEXT }
  }
}
