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
import { useEffect, useState } from 'react'

import { Button } from '@/design-system/primitives'
import type { ICellRendererParams } from '@/design-system/grid'
import type { FamilyFooterRow } from '@/app/products/next/productsDatasource'
import { getBackendUrl } from '@/lib/backend-url'

import styles from './styles.module.css'
import { familyHref } from './columns'
import {
  familyFooterCounts,
  familyFooterSentence,
  type FamilyFooterCounts,
  type ReadinessScopeEntry,
} from './variationMappingFilter'

/**
 * VT.4b — the market the readiness read is addressed with.
 *
 * 🔴 `GET /api/products/:id/readiness` REQUIRES `?market=` (400 without it), but the `matrix` this footer reads
 * is the family's EVERY coordinate and does not depend on it. Measured three arms on `VX-TEST-3AX`:
 * `market=IT`, `market=DE` and `market=UK` each returned `matrix n=34` with the identical distribution
 * `{derived: 26, none: 7, NULL: 1}` while `scopes` stayed market-filtered at 6. So the parameter selects the
 * `scopes` block, which this footer does not use.
 *
 * It is still DERIVED and not hardcoded — the first active market the workspace's own
 * `/api/marketplaces/grouped` reports — because a literal `'IT'` in the catalogue would be a channel fact
 * invented on a page, and the next workspace would not have it.
 */
let marketPromise: Promise<string | null> | null = null
function readinessMarket(): Promise<string | null> {
  marketPromise ??= fetch(`${getBackendUrl()}/api/marketplaces/grouped`, { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((body: Record<string, Array<{ code?: string; isActive?: boolean }>> | null) => {
      if (!body) return null
      for (const [channel, rows] of Object.entries(body)) {
        if (channel.startsWith('_') || !Array.isArray(rows)) continue
        const hit = rows.find((row) => row?.isActive && typeof row.code === 'string')
        if (hit?.code) return hit.code
      }
      return null
    })
    .catch(() => null)
  return marketPromise
}

/**
 * The family's variation-mapping counts, from the materialized index.
 *
 * 🔴 It renders **`Not computed`** — never `0 collides` — for a family whose index rows carry no provenance.
 * 818 of the 884 local rows are in exactly that state, and a footer printing a zero beside them would be
 * asserting a measurement nobody took, in the one place an operator reads a total (R-LX-9's vocabulary, one
 * table over). A failed or refused read is also `Not computed`, for the same reason.
 *
 * One GET per EXPANDED family (the footer row exists only under an expansion), on the same materialized index
 * the catalogue filter narrows with — so the sentence here and the narrowing there cannot disagree.
 */
function useFamilyMappingCounts(parentId: string): FamilyFooterCounts | null {
  const [counts, setCounts] = useState<FamilyFooterCounts | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      const market = await readinessMarket()
      if (!live || !market) return
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${encodeURIComponent(parentId)}/readiness?market=${encodeURIComponent(market)}`,
          { credentials: 'include', cache: 'no-store' },
        )
        if (!res.ok) return
        const body = (await res.json()) as { matrix?: ReadinessScopeEntry[] }
        if (live && Array.isArray(body.matrix)) setCounts(familyFooterCounts(body.matrix))
      } catch {
        /* Left null — the footer then says `Not computed`, which is what a read that did not answer means. */
      }
    })()
    return () => { live = false }
  }, [parentId])
  return counts
}

export function FamilyFooter({ data }: ICellRendererParams<FamilyFooterRow>) {
  /* The hook runs before the early return so the order of hooks is stable across renders; `''` never fetches. */
  const counts = useFamilyMappingCounts(data?.parentId ?? '')
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
      {/* VT.4b — the unit is COORDINATES, and the label says so: a family can be derived on 25 coordinates and
          overridden on one, which is exactly what GALE-JACKET is. */}
      <span
        className={styles.famFootCount}
        title={counts
          ? `Variation mapping across this family's ${counts.rows} coordinate${counts.rows === 1 ? '' : 's'} in the readiness index.`
          : 'The readiness index has not answered for this family yet.'}
      >
        Variation mapping · {counts ? familyFooterSentence(counts) : 'Not computed'}
      </span>
      <Button asChild size="sm" variant="secondary">
        <a href={familyHref(data.parentId)} target="_blank" rel="noopener noreferrer">
          {capped ? `View all ${data.total}` : 'Open family'} <ExternalLink size={13} />
        </a>
      </Button>
    </div>
  )
}
