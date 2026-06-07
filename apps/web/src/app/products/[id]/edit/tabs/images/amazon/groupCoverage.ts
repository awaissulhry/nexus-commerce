// MM.6 — slot-group completion. Clusters the Amazon slots into meaningful
// groups (Main / Gallery / Safety / Swatch) and reports how many slots in each
// are filled, so the operator sees progress at a glance ("Safety 6/6 ✓") and
// can hide a finished group in one click. Pure → unit-tested.

import type { AmazonSlot } from './useAmazonImages'

export type SlotGroupKey = 'MAIN' | 'PT' | 'PS' | 'SWCH' | 'OTHER'

export interface SlotGroupInfo {
  key: SlotGroupKey
  label: string
  slots: AmazonSlot[]
  filledSlots: number
  totalSlots: number
  complete: boolean
}

const GROUP_LABEL: Record<SlotGroupKey, string> = {
  MAIN: 'Main',
  PT: 'Gallery',
  PS: 'Safety',
  SWCH: 'Swatch',
  OTHER: 'Other',
}
const ORDER: SlotGroupKey[] = ['MAIN', 'PT', 'PS', 'SWCH', 'OTHER']

export function groupOf(slot: string): SlotGroupKey {
  if (slot === 'MAIN') return 'MAIN'
  if (slot.startsWith('PT')) return 'PT'
  if (slot.startsWith('PS')) return 'PS'
  if (slot === 'SWCH') return 'SWCH'
  return 'OTHER'
}

export function computeSlotGroups(
  slots: readonly AmazonSlot[],
  isSlotFilled: (slot: AmazonSlot) => boolean,
): SlotGroupInfo[] {
  const byKey = new Map<SlotGroupKey, AmazonSlot[]>()
  for (const s of slots) {
    const k = groupOf(s)
    const arr = byKey.get(k) ?? []
    arr.push(s)
    byKey.set(k, arr)
  }
  const out: SlotGroupInfo[] = []
  for (const key of ORDER) {
    const gslots = byKey.get(key)
    if (!gslots || gslots.length === 0) continue
    const filledSlots = gslots.filter(isSlotFilled).length
    out.push({
      key,
      label: GROUP_LABEL[key],
      slots: gslots,
      filledSlots,
      totalSlots: gslots.length,
      complete: filledSlots === gslots.length,
    })
  }
  return out
}
