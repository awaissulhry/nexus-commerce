import { PRODUCT_ROLE_LABELS, productRoleOf } from '@nexus/shared/master-sheet'
import { IdentityChip } from '@/design-system/grid/renderers/cells'

/** The existing identity badge uses the same product relationship on every scope and alias. */
export function ProductRoleChip({ product }: { product: { parentId: string | null; isParent: boolean; childCount: number; parentSku?: string | null } }) {
  const role = productRoleOf(product)
  const detail = role === 'parent' ? ` · ${product.childCount} ${product.childCount === 1 ? 'child' : 'children'}`
    : role === 'child' && product.parentSku ? ` · Parent SKU: ${product.parentSku}` : ''
  return <IdentityChip label={role === 'parent' ? 'P' : role === 'child' ? 'C' : 'S'}
    tone={role === 'parent' ? 'accent' : 'neutral'} tip={`${PRODUCT_ROLE_LABELS[role]}${detail}`} />
}
