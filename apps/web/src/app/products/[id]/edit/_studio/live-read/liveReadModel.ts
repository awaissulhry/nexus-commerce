/**
 * Read live (Owner, 2026-09-26: "the ability to read whatever is currently live on the channel") — what the drawer compares.
 *
 * Pure. A live read (`@nexus/shared/live-read`, the same shape the publish review uses) beside what the Information sheet holds
 * for the same destination. Nothing here is stored and nothing is sent: a live read never changes what Publish sends.
 * A value that could not be read says so; it is never shown as a blank that looks like "no change".
 */
import type { LiveRead, LiveReadError, LiveValue } from '@nexus/shared/live-read'

export function formatLiveValue(value: LiveValue): string {
  if (value.state === 'absent') return 'Not on the channel'
  if (value.state === 'unread') return `Could not read: ${value.reason}`
  return text(value.value)
}

function text(value: unknown): string {
  if (value == null) return 'Empty'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(text).join(', ')
  if (typeof value === 'object') {
    const bag = value as Record<string, unknown>
    if ('amount' in bag) return `${text(bag.amount)} ${typeof bag.currency === 'string' ? bag.currency : ''}`.trim()
    return JSON.stringify(value)
  }
  return String(value)
}

const fold = (key: string) => key.toLowerCase().replace(/[\s_-]/g, '')

/** A channel axis ("Colore") linked to the family axis the sheet stores it under, from the variation theme cell. */
export interface AxisLink { channelName: string; familyKey: string; axisKey: string }
/** One variant as the sheet holds it: its SKU and its axis values under the stored keys. */
export interface NexusVariant { sku: string; values: Record<string, string> }

export interface LiveVariantRow {
  sku: string
  state: 'live' | 'missing' | 'extra'
  cells: Array<{ axis: string; live: string | null; nexus: string | null; differs: boolean }>
  price: string
  stock: string
  differs: boolean
}

export function variationRows(live: LiveRead, links: readonly AxisLink[], nexus: readonly NexusVariant[]): LiveVariantRow[] {
  if (!live.variations) return []
  const axes = live.variations.axes
  return live.variations.variants.map(variant => {
    const mine = variant.state === 'extra' ? undefined : nexus.find(n => n.sku === variant.sku)
    const cells = axes.map(axis => {
      const link = links.find(l => l.channelName === axis)
      const keys = link ? new Set([fold(link.familyKey), fold(link.axisKey)]) : new Set([fold(axis)])
      const nexusValue = mine ? Object.entries(mine.values).find(([key]) => keys.has(fold(key)))?.[1] ?? null : null
      const liveValue = variant.state === 'missing' ? null : variant.values[axis] ?? null
      return { axis, live: liveValue, nexus: nexusValue, differs: liveValue != null && nexusValue != null && liveValue.trim() !== nexusValue.trim() }
    })
    return { sku: variant.sku, state: variant.state, cells, price: formatLiveValue(variant.price), stock: formatLiveValue(variant.stock),
      differs: variant.state !== 'live' || cells.some(c => c.differs) }
  })
}

export interface LiveContentRow {
  field: string
  label: string
  live: string
  nexus: string | null
  /** same / differs: compared with the sheet · not-compared: the sheet holds no field under this key · absent / unread: see `live`. */
  state: 'same' | 'differs' | 'not-compared' | 'absent' | 'unread'
}

/** A field id as the publish review writes it: `aspect:<key>`, Amazon `<root>:["<marketplaceId>","<language>"]`, or a plain key. */
function parseField(field: string): { root: string; language: string | null; aspect: boolean } {
  if (field.startsWith('aspect:')) return { root: field.slice('aspect:'.length), language: null, aspect: true }
  const amazon = /^([^:[\]]+):(\[.*\])$/.exec(field)
  if (amazon) {
    try {
      const [, language] = JSON.parse(amazon[2]) as unknown[]
      return { root: amazon[1], language: typeof language === 'string' ? language : null, aspect: false }
    } catch { /* not an Amazon id: fall through to a plain key */ }
  }
  return { root: field, language: null, aspect: false }
}

function fieldLabel(field: string): string {
  const { root, language, aspect } = parseField(field)
  if (aspect) return root
  if (language) return `${root} (${language})`
  return /^[a-z]+$/.test(root) ? root[0].toUpperCase() + root.slice(1) : root
}

/** Where the sheet keeps a publish-review field when its key is not the field id itself. */
const SHEET_KEYS: Record<string, string> = { title: 'name', pictures: 'imageUrls' }
/**
 * E5 — the Etsy sheet keys these columns by their Shared name (`channel-specs/etsy.ts` masterKey; `sheet-columns.service.ts`
 * keys a column by it), so without this Etsy's Tags were never compared with the sheet's Search keywords.
 */
const ETSY_SHEET_KEYS: Record<string, string> = { tags: 'keywords', materials: 'material', styles: 'style' }
/** E5 — the Etsy review's equality (`studio-publication-etsy-changes.ts` `etsySame`): these lists are sets, case ignored. */
const ETSY_SET_FIELDS = new Set(['tags', 'materials', 'styles'])
/** Etsy's value + unit objects: the sheet holds the number and the unit in separate columns, so a plain comparison would lie. */
const ETSY_NOT_COMPARED = new Set(['item_weight', 'item_dimensions'])

/** The sheet's value for a live field: same key, then its root, then the sheet's own name for it, then the folded root. */
function sheetValue(field: string, nexus: Record<string, unknown>, etsy = false): unknown {
  const { root } = parseField(field)
  for (const key of [field, root, SHEET_KEYS[root], etsy ? ETSY_SHEET_KEYS[root] : undefined]) if (key && key in nexus) return nexus[key]
  const folded = Object.keys(nexus).find(key => fold(key) === fold(root))
  return folded === undefined ? undefined : nexus[folded]
}

/** A list as the Etsy review compares it: each item trimmed and lower-cased, once, sorted (a single value is a list of one). */
const foldedSet = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value : value == null ? [] : [value])
  .map(item => String(item ?? '').trim().toLocaleLowerCase()).filter(Boolean))].sort()
/** Etsy may store a description with Windows line ends and trailing space (the review's own `plain`). */
const plainText = (value: unknown): string => text(value).replace(/\r\n/g, '\n').trim()

/** Same or different, by the channel's own rule where it has one (Etsy: the review's), else the shown text. */
function sameValue(field: string, live: unknown, mine: unknown, etsy: boolean): boolean {
  if (etsy && ETSY_SET_FIELDS.has(field)) return JSON.stringify(foldedSet(live)) === JSON.stringify(foldedSet(mine))
  if (etsy && field === 'description') return plainText(live) === plainText(mine)
  return text(live).trim() === text(mine).trim()
}

/** How a value is shown: a list of picture links as a count, since the drawer has no room for URLs (the comparison still uses every link). */
const shown = (field: string, value: unknown) => field === 'pictures' && Array.isArray(value) ? `${value.length} ${value.length === 1 ? 'picture' : 'pictures'}` : text(value)

/** Every live content field, compared with the sheet's value for it. */
export function contentRows(live: LiveRead, nexus: Record<string, unknown>): LiveContentRow[] {
  const etsy = live.source === 'etsy-listing'
  return Object.keys(live.content).sort().map(field => {
    const value = live.content[field]
    const mine = sheetValue(field, nexus, etsy)
    const state: LiveContentRow['state'] = value.state === 'unread' ? 'unread' : value.state === 'absent' ? 'absent'
      : mine === undefined || (etsy && ETSY_NOT_COMPARED.has(field)) ? 'not-compared' : sameValue(field, value.value, mine, etsy) ? 'same' : 'differs'
    return { field, label: fieldLabel(field), live: value.state === 'value' ? shown(field, value.value) : formatLiveValue(value),
      nexus: mine === undefined ? null : shown(field, mine), state }
  })
}

/** One line over the whole comparison. It counts only what was really compared, so an empty comparison never reads "no differences". */
export function comparisonSummary(variants: readonly LiveVariantRow[], content: readonly LiveContentRow[]): string {
  const comparedVariants = variants.filter(v => v.state !== 'live' || v.cells.some(c => c.live != null && c.nexus != null))
  const comparedContent = content.filter(c => c.state === 'same' || c.state === 'differs')
  const compared = comparedVariants.length + comparedContent.length
  if (compared === 0) return 'Nothing could be compared with Nexus.'
  const differing = comparedVariants.filter(v => v.differs).length + comparedContent.filter(c => c.state === 'differs').length
  const parts = `${compared} ${compared === 1 ? 'part' : 'parts'} compared`
  return differing ? `${differing} ${differing === 1 ? 'difference' : 'differences'} from Nexus, in ${parts}.` : `No differences from Nexus, in ${parts}.`
}

/** Failed reads, one line per reason: many SKUs that failed the same way read as one line that still names them. */
export function errorGroups(errors: readonly LiveReadError[]): Array<{ label: string; reason: string; names: string[] }> {
  const groups = new Map<string, LiveReadError[]>()
  for (const error of errors) groups.set(`${error.scope}\u0000${error.reason}`, [...(groups.get(`${error.scope}\u0000${error.reason}`) ?? []), error])
  return [...groups.values()].map(group => {
    const [first] = group
    const names = group.map(e => e.sku ?? e.field).filter((n): n is string => !!n)
    if (group.length === 1) return { label: first.sku ?? first.field ?? 'Listing', reason: first.reason, names: [] }
    const noun = first.scope === 'sku' ? 'variants' : first.scope === 'field' ? 'fields' : 'parts'
    return { label: `${group.length} ${noun}`, reason: first.reason, names }
  })
}
