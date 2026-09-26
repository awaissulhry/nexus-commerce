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

function fieldLabel(field: string): string {
  if (field.startsWith('aspect:')) return field.slice('aspect:'.length)
  const at = field.indexOf('@')
  if (at > 0) { const [market, language] = field.slice(at + 1).split('/'); return `${field.slice(0, at)} (${[market, language].filter(Boolean).join(', ')})` }
  return /^[a-z]+$/.test(field) ? field[0].toUpperCase() + field.slice(1) : field
}

/** Where the sheet keeps a publish-review field when its key is not the field id itself. */
const SHEET_KEYS: Record<string, string> = { title: 'name', pictures: 'imageUrls' }

/** The sheet's value for a live field: same key, then the root (`aspect:<key>`, Amazon `root@market/lang`), then the sheet's own name for it, then the folded key. */
function sheetValue(field: string, nexus: Record<string, unknown>): unknown {
  const root = field.startsWith('aspect:') ? field.slice('aspect:'.length) : field.includes('@') ? field.slice(0, field.indexOf('@')) : field
  for (const key of [field, root, SHEET_KEYS[root]]) if (key && key in nexus) return nexus[key]
  const folded = Object.keys(nexus).find(key => fold(key) === fold(root))
  return folded === undefined ? undefined : nexus[folded]
}

/** How a value is shown: a list of picture links as a count, since the drawer has no room for URLs (the comparison still uses every link). */
const shown = (field: string, value: unknown) => field === 'pictures' && Array.isArray(value) ? `${value.length} ${value.length === 1 ? 'picture' : 'pictures'}` : text(value)

/** Every live content field, compared with the sheet's value for it. */
export function contentRows(live: LiveRead, nexus: Record<string, unknown>): LiveContentRow[] {
  return Object.keys(live.content).sort().map(field => {
    const value = live.content[field]
    const mine = sheetValue(field, nexus)
    const state: LiveContentRow['state'] = value.state === 'unread' ? 'unread' : value.state === 'absent' ? 'absent'
      : mine === undefined ? 'not-compared' : text(value.value).trim() === text(mine).trim() ? 'same' : 'differs'
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
