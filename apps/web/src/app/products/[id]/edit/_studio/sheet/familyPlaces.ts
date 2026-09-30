/**
 * P1 (issue #15, #14; report 6 I-8/I-9) — which of the product's FAMILY attributes have no column on the sheet in view,
 * and where each one lives. The family page counts every attribute of the family; a sheet shows one scope's columns.
 * Customise lists the difference, so an attribute placed on a channel without an account, or archived, is never
 * simply missing. Pure: tested beside this file.
 */
import { channelLabel } from '../scopes'

export interface FamilyAttributePlace {
  code: string
  label: string
  placement: 'shared' | 'channel'
  channels: string[]
  archived: boolean
}

export interface FamilyAttributePlaces {
  family: { id: string; label: string } | null
  attributes: FamilyAttributePlace[]
  channelsWithAccount: string[]
}

export interface ElsewhereGroup {
  /** Where they live, in the operator's words. */
  where: string
  labels: string[]
}

export interface FamilyElsewhere {
  family: string | null
  total: number
  here: number
  groups: ElsewhereGroup[]
}

const list = (channels: string[]) => channels.map(c => channelLabel(c)).join(', ')

/** Where one attribute lives, seen from the sheet in view (`channel` null = the Shared product sheet). */
export function placeOf(attribute: FamilyAttributePlace, channel: string | null, withAccount: ReadonlySet<string>): string {
  if (attribute.archived) return 'Archived — restore it in Settings → Attributes to edit it'
  if (attribute.placement === 'channel') {
    const channels = attribute.channels
    if (channel && channels.includes(channel)) return `Placed on ${channelLabel(channel)}, but this product’s ${channelLabel(channel)} category does not use it`
    const missing = channels.filter(c => !withAccount.has(c))
    if (channels.length && missing.length === channels.length) return `Placed on ${list(channels)} — no ${list(channels)} account`
    return `Placed on ${list(channels.filter(c => withAccount.has(c)))} — open that channel’s sheet`
  }
  return channel ? 'On the Shared product sheet (a channel reads it through its field mapping)' : 'Shared, but not part of this product’s type'
}

/**
 * The family attributes with no column on this sheet, grouped by where they live, in the family's order. An attribute has
 * a column here when a column's key is its code or the column writes it (`attr_<code>`).
 */
export function familyAttributesElsewhere(places: FamilyAttributePlaces, columns: ReadonlyArray<{ key: string; writeField?: string }>, channel: string | null): FamilyElsewhere {
  const keys = new Set(columns.flatMap(c => [c.key, c.writeField?.replace(/^attr_/, '') ?? c.key]))
  const withAccount = new Set(places.channelsWithAccount.map(c => c.toUpperCase()))
  const groups = new Map<string, string[]>()
  let here = 0
  for (const attribute of places.attributes) {
    if (keys.has(attribute.code)) { here++; continue }
    const where = placeOf(attribute, channel, withAccount)
    groups.set(where, [...(groups.get(where) ?? []), attribute.label])
  }
  return { family: places.family?.label ?? null, total: places.attributes.length, here, groups: [...groups].map(([where, labels]) => ({ where, labels })) }
}
