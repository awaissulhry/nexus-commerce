'use client'

/**
 * PES.1 — the studio's header band.
 *
 * `‹ Products · name · SKU · status · autosave · Publish ▾`, on one line. It is the DS
 * `DetailHeader` in its `dense` form — the extension this lane added to that component rather than
 * a fourth hand-rolled detail header beside `CampaignDetailHeader` and the old edit page's.
 *
 * It is a fixed track in a frame that does not scroll, which is what makes it always visible.
 * `position: sticky` would have been the wrong instrument: sticky resolves against the scroll
 * container, and this frame deliberately has none.
 */

import Link from '@/lib/workspaces/Link'
import type { ReactNode } from 'react'

import { Pill } from '@/design-system/primitives'
import { DetailHeader } from '@/design-system/patterns'

import { useStudioFamily, useStudioProduct } from './contracts'
import { PublishMenu } from './PublishMenu'
import { SaveIndicator } from './SaveIndicator'
import styles from './studio.module.css'

/** ACTIVE / DRAFT / INACTIVE are the three `Product.status` values the schema documents. */
function statusTone(status: string | null): 'success' | 'neutral' | 'warning' {
  switch ((status ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'success'
    case 'INACTIVE':
      return 'warning'
    default:
      return 'neutral'
  }
}

function statusLabel(status: string | null): string {
  if (!status) return 'No status'
  return status.charAt(0) + status.slice(1).toLowerCase()
}

export function StudioHeader({ titleMenu }: { titleMenu?: ReactNode }) {
  const product = useStudioProduct()
  const family = useStudioFamily()
  return (
    <DetailHeader
      dense
      // A real anchor, not `router.back()`: ⌘-click, middle-click and "Open in new tab" all work,
      // and the destination is stated rather than being "wherever you came from".
      backAsChild
      backLabel={<Link href="/products">Products</Link>}
      title={product.name ?? product.sku}
      titleMenu={titleMenu}
      meta={
        <>
          <span className={styles.identity} title={product.sku}>
            {product.sku}
          </span>
          {product.asin && (
            <span className={styles.identity} title={`Amazon ASIN ${product.asin}`}>
              {product.asin}
            </span>
          )}
          <Pill tone={product.deletedAt != null ? 'neutral' : statusTone(product.status)} dot title={product.deletedAt != null ? `Moved to the bin at ${product.deletedAt}.` : undefined}>
            {product.deletedAt != null ? 'Binned' : statusLabel(product.status)}
          </Pill>
          {product.isParent && <Pill tone="info">Parent</Pill>}
          {product.parentId &&
            (family ? (
              // The way UP. Siblings are not repeated here — the sheet already renders the whole
              // family as rows, and a second list of them would be the staler one.
              <Link
                className={styles.familyLink}
                href={`/products/${family.parentId}/edit/studio`}
                title={family.parentName ? `${family.parentName} · ${family.parentSku}` : family.parentSku}
              >
                Child of {family.parentSku}
              </Link>
            ) : (
              <Pill tone="neutral">Child</Pill>
            ))}
        </>
      }
      status={<SaveIndicator />}
      /*
       * Autosave state and `Publish ▾`, and nothing else.
       *
       * The `⋯` overflow that briefly held nine link-outs is gone — Owner decision D9, superseding
       * D5. Their reasoning: those links were the old page's approach carried in, and every need
       * they served is already the studio's own model. The flat files ARE the channel scopes; the
       * Datasheet is the sheet; Recover is History; "List on…" is a new coordinate plus this menu.
       * A second way to reach a thing the grid already is makes the page bigger, not more capable.
       *
       * `lib/perf/markNewTabClick` is deliberately left in the tree: it is a library whose other
       * half (`reportFromTarget`) runs on the destination pages, which are untouched.
       */
      actions={<PublishMenu />}
    />
  )
}
