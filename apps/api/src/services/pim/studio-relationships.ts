import { PARENT_SKU_COLUMN, PRODUCT_ROLE_COLUMN, PRODUCT_ROLE_LABELS, productRoleOf } from '@nexus/shared/master-sheet'
import type { SheetColumn } from './sheet-columns.service.js'
import type { StudioCellValue } from './studio-sheet.service.js'

export const RELATIONSHIP_GROUP = { key: 'master:relationships', label: 'Product relationships', channelLabel: null, order: -1 }

/** Display-only metadata. It must never enter attribute completeness or marketplace validation. */
export const relationshipColumns: SheetColumn[] = [
  { key: PRODUCT_ROLE_COLUMN, label: 'Product role', width: 135,
    helpText: 'Calculated from the shared product relationship: Standalone, Parent or Child. The percentage measures attribute completeness separately.' },
  { key: PARENT_SKU_COLUMN, label: 'Parent SKU', width: 220,
    helpText: 'The shared parent of this child, used by every listing alias. Change relationships with Parent SKU in Catalog import & export; preview before applying.' },
].map(col => ({ ...col, writeField: col.key, group: RELATIONSHIP_GROUP.label, groupKey: RELATIONSHIP_GROUP.key,
  kind: 'text', storage: 'column', scope: 'global', requiredBy: [], editable: false, defaultVisible: true }))

export function relationshipValues(product: { parentId?: string | null; isParent?: boolean; childCount?: number }, parentSku: string | null): Record<string, StudioCellValue> {
  const role = productRoleOf(product)
  return Object.fromEntries(relationshipColumns.map(col => [col.key, {
    value: col.key === PRODUCT_ROLE_COLUMN ? PRODUCT_ROLE_LABELS[role] : role === 'child' ? parentSku : null,
    source: 'masterColumn', inheritedFrom: null, inherited: false,
    layer: 'master', pinned: false, follows: null, editable: false, linkGroupId: null,
    writeField: col.key, writeTarget: 'master', writeVerb: 'master', affectsAllChannels: false,
    writable: false, writeBlockedReason: col.helpText,
  } as StudioCellValue]))
}
