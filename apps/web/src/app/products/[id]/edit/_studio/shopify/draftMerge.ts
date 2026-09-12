import { fieldAddress, sheetValueAddress, type ShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { nativeEditAddress } from '@nexus/shared/shopify-information'
export type DraftConflict = { key: string; label: string; local: unknown; saved: unknown }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Three-way merge of Nexus intent only. Shopify baselines remain attached to each command and
 * are checked again during review; this never silently rebases a remote Shopify conflict. */
export function mergeInformationDraft(base: ShopifyLinkedDraft, local: ShopifyLinkedDraft, saved: ShopifyLinkedDraft, choices: Record<string, 'local' | 'saved'> = {}) {
  const merged = structuredClone(saved), conflicts: DraftConflict[] = []
  const choose = (key: string, label: string, original: unknown, ours: unknown, theirs: unknown) => {
    if (equal(ours, original)) return theirs
    if (equal(theirs, original) || equal(ours, theirs)) return ours
    if (!choices[key]) conflicts.push({ key, label, local: ours, saved: theirs })
    return choices[key] === 'local' ? ours : theirs
  }
  for (const key of ['members', 'relationship', 'baselineLinks', 'sharedFields', 'informationOnly'] as const) {
    const value = choose(key, key, base[key], local[key], saved[key])
    if (value === undefined) delete (merged as any)[key]; else (merged as any)[key] = value
  }
  for (const [section, address] of [['edits', fieldAddress], ['nativeEdits', nativeEditAddress], ['mediaEdits', (e: any) => e.productId], ['sheetValues', sheetValueAddress]] as const) {
    const entries = (draft: ShopifyLinkedDraft) => new Map((draft[section] ?? []).map((e: any) => [address(e), e]))
    const original = entries(base), ours = entries(local), theirs = entries(saved)
    ;(merged as any)[section] = [...new Set([...original.keys(), ...ours.keys(), ...theirs.keys()])].flatMap(key => {
      const e = ours.get(key) ?? theirs.get(key) ?? original.get(key)
      const value = choose(`${section}:${key}`, `${e.ownerLabel ?? e.productId} · ${e.translation?.fieldId ?? e.field ?? e.key ?? 'Product media'}${e.translation?.locale ? ` · ${e.translation.locale}` : ''}`, original.get(key), ours.get(key), theirs.get(key))
      return value === undefined ? [] : [value]
    })
  }
  return { merged, conflicts }
}
