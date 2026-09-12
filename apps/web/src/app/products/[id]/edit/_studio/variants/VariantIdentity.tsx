'use client'

import { CompletenessPill, IdentityBand, ProvenanceMark } from '@/design-system/grid'
import { ProductRoleChip } from '../sheet/ProductRoleChip'
import type { MenuItemDef } from '@/design-system/components'
import type { RowReadinessState } from '@/design-system/grid/renderers/readiness'

/** One identity composition for the shared family and every channel projection. */
export function VariantIdentity({ sku, isParent, parentId, childCount, image, inherited, axes, suspect = [], pct, readiness, completenessTip, menuItems }: {
  sku: string; isParent: boolean; parentId?: string | null; childCount: number
  image?: string | null; inherited?: boolean; axes: string[]
  suspect?: Array<{ reason: string }>; pct: number | null; menuItems?: MenuItemDef[]
  readiness?: RowReadinessState | null; completenessTip?: string
}) {
  const secondary = isParent ? `Parent · ${childCount} variants` : axes.join(' · ')
  return <IdentityBand
    role={<ProductRoleChip product={{ isParent, parentId: parentId ?? null, childCount }} />}
    image={image}
    imageMark={inherited ? <ProvenanceMark provenance="inherited" from="the family's picture — this variation has none of its own" /> : null}
    sku={sku}
    secondary={<>{secondary}{suspect.length > 0 && <span className="nds-cell-warning" aria-label="Shared axis values need review"> ⚠</span>}</>}
    secondaryTitle={suspect.map(entry => entry.reason).join(' ') || secondary}
    trailing={<CompletenessPill pct={pct} state={readiness} tip={completenessTip ?? `${pct}% — filled ÷ applicable master attributes`} />}
    menuItems={menuItems}
    menuLabel={`Actions for ${sku}`}
  />
}
