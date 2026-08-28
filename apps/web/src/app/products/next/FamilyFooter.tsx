'use client'

/**
 * The full-width row beneath an expanded family. Count on the left; on the right a real DS
 * Button wrapping a real <a target="_blank"> — the live page's footer, reproduced rather than
 * re-imagined. Shown for EVERY family: the button's value is a page scoped to one family, worth
 * reaching whether the family has three variations or forty. The two cases are different actions
 * and do not share a label: capped, the click GETS YOU THE REST and the count belongs in the
 * button; complete, the click only FOCUSES them. The parent's own "N variations" link is the
 * same page one click earlier, and the Owner keeps both.
 */
import { ExternalLink } from 'lucide-react'

import { Button } from '@/design-system/primitives'
import type { ICellRendererParams } from '@/design-system/patterns/workspace-grid/engine/NexusGrid'
import type { FamilyFooterRow } from '@/design-system/patterns/workspace-grid/engine/productsDatasource'

import styles from './styles.module.css'
import { familyHref } from './columns'

export function FamilyFooter({ data }: ICellRendererParams<FamilyFooterRow>) {
  if (!data) return null
  const capped = data.total > data.shown
  return (
    <div className={styles.famFoot}>
      <span className={styles.famFootCount}>
        {capped ? (
          <>Showing <b>{data.shown}</b> of <b>{data.total}</b> variations</>
        ) : (
          <><b>{data.total}</b> {data.total === 1 ? 'variation' : 'variations'}</>
        )}
      </span>
      <Button asChild size="sm" variant="secondary">
        <a href={familyHref(data.parentId)} target="_blank" rel="noopener noreferrer">
          {capped ? `View all ${data.total}` : 'Open family'} <ExternalLink size={13} />
        </a>
      </Button>
    </div>
  )
}
