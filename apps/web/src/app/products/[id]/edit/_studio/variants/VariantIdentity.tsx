'use client'

import { IdentityBand, ProvenanceMark } from '@/design-system/grid'
import { ProductRoleChip } from '../sheet/ProductRoleChip'
import type { MenuItemDef } from '@/design-system/components'

/**
 * One identity composition for the shared family, every channel projection and the Matrix.
 *
 * No completeness bar here (2026-09-27): as on the Information sheet, the bar lives in a progress COLUMN beside
 * the Product cell (`sheet/progressColumns.ts`), in colour rule A, with the card that lists what is empty.
 */
export function VariantIdentity({ sku, isParent, parentId, childCount, image, inherited, axes, suspect = [], menuItems }: {
  sku: string; isParent: boolean; parentId?: string | null; childCount: number
  image?: string | null; inherited?: boolean; axes: string[]
  suspect?: Array<{ reason: string }>; menuItems?: MenuItemDef[]
}) {
  const secondary = isParent ? `Parent · ${childCount} variants` : axes.join(' · ')
  return <IdentityBand
    role={<ProductRoleChip product={{ isParent, parentId: parentId ?? null, childCount }} />}
    image={image}
    imageMark={inherited ? <ProvenanceMark provenance="inherited" tooltip="Inherited from the family's picture — this variation has none of its own" /> : null}
    sku={sku}
    secondary={<>{secondary}{suspect.length > 0 && <span className="nds-cell-warning" aria-label="Shared axis values need review"> ⚠</span>}</>}
    secondaryTitle={suspect.map(entry => entry.reason).join(' ') || secondary}
    menuItems={menuItems}
    menuLabel={`Actions for ${sku}`}
  />
}
