/**
 * Read live (Owner, 2026-09-26: "the ability to read whatever is currently live on the channel") — what the drawer compares.
 *
 * Pure. A live read (`@nexus/shared/live-read`, the same shape the publish review uses) beside what the Information sheet holds
 * for the same destination. Nothing here is stored and nothing is sent: a live read never changes what Publish sends.
 * A value that could not be read says so; it is never shown as a blank that looks like "no change".
 */
import type { LiveRead, LiveValue } from '@nexus/shared/live-read'

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

/** Every live content field, compared with the sheet's value under the same key (an Amazon `root@market/lang` by its root). */
export function contentRows(live: LiveRead, nexus: Record<string, unknown>): LiveContentRow[] {
  return Object.keys(live.content).sort().map(field => {
    const value = live.content[field]
    const mine = field in nexus ? nexus[field] : field.includes('@') && field.split('@')[0] in nexus ? nexus[field.split('@')[0]] : undefined
    const nexusText = mine === undefined ? null : text(mine)
    const state: LiveContentRow['state'] = value.state === 'unread' ? 'unread' : value.state === 'absent' ? 'absent'
      : nexusText === null ? 'not-compared' : text(value.value).trim() === nexusText.trim() ? 'same' : 'differs'
    return { field, label: fieldLabel(field), live: formatLiveValue(value), nexus: nexusText, state }
  })
}
