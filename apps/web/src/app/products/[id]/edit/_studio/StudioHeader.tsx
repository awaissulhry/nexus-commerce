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
import { useMemo, type ReactNode } from 'react'

import { Pill } from '@/design-system/primitives'
import { DetailHeader } from '@/design-system/patterns'

import { useStudioFamily, useStudioProduct } from './contracts'
import { PublishMenu } from './PublishMenu'
import { SaveIndicator } from './SaveIndicator'
import { SellingSummaryPill, headerSellingOf } from './SellingSummary'
import { usePublishActions } from './sheet/usePublishActions'
import styles from './studio.module.css'

/** Build shape v2, P9 — the header reads the waiting Status and Action values of every market of the family. */
const EVERY_DESTINATION = {}

export function StudioHeader({ titleMenu }: { titleMenu?: ReactNode }) {
  const product = useStudioProduct()
  const family = useStudioFamily()
  /*
   * Build shape v2, P9 (Owner 2026-10-04) — the old status pill showed the Nexus product status (ACTIVE / DRAFT /
   * INACTIVE), which left the studio: it is "Catalog status" in the Products list. In its place, where this product
   * SELLS: "Active on 5 of 7" / "Not listed", danger when an End or a Delete waits for Publish in the family; it opens
   * the list of markets. "Binned" stays. The same read gives the Publish button its waiting count.
   */
  const selling = usePublishActions(product.id, EVERY_DESTINATION, { familyId: family?.parentId ?? product.id })
  const cells = useMemo(() => selling.rows.filter(cell => cell.productId === product.id), [selling.rows, product.id])
  const head = headerSellingOf(cells, selling.waiting)
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
          {product.deletedAt != null && (
            <Pill tone="neutral" dot title={`Moved to the bin at ${product.deletedAt}.`}>
              Binned
            </Pill>
          )}
          <SellingSummaryPill
            status={selling.status}
            error={selling.error}
            onRetry={() => void selling.reload()}
            sku={product.sku}
            cells={cells}
            familyWaiting={selling.waiting}
            label={head.label}
            tone={head.tone}
            ariaLabel={head.ariaLabel}
          />
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
      actions={<PublishMenu waiting={selling.waiting} />}
    />
  )
}
