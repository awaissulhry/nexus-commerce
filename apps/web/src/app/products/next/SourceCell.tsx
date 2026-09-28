'use client'

import { Pill } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import type { ProductRow } from '../_types'
import styles from './styles.module.css'

/**
 * Sharing studio step 2 — the Source column: the business this product follows, and the businesses that follow it.
 * An own product that nobody follows shows nothing. Each mark opens the product studio's "Other businesses" page.
 */
export function sourceWords(sharing: ProductRow['sharing']): { following: string | null; shared: string | null } {
  const shared = sharing?.sharedWith ?? []
  return {
    following: sharing?.following ? `Follows ${sharing.following.businessName}` : null,
    shared: shared.length === 0 ? null : shared.length === 1 ? `Shared with ${shared[0]}` : `Shared with ${shared.length} businesses`,
  }
}

/** The CSV value: what the cell says, or "Own". */
export function sourceExport(sharing: ProductRow['sharing']): string {
  const words = sourceWords(sharing)
  return [words.following, words.shared].filter(Boolean).join(' · ') || 'Own'
}

export function SourceCell({ row }: { row: ProductRow }) {
  const words = sourceWords(row.sharing)
  if (!words.following && !words.shared) return null
  return (
    <Link href={`/products/${row.id}/edit/studio?tab=sharing`} className={styles.sourceLink}
      aria-label={`${[words.following, words.shared].filter(Boolean).join('. ')}. Open how ${row.sku} is shared`}>
      {words.following && <Pill tone="info">{words.following}</Pill>}
      {words.shared && <Pill tone="neutral">{words.shared}</Pill>}
    </Link>
  )
}
