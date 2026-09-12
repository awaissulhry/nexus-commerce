'use client'

/**
 * PES.7 — committing an eBay bucket edit.
 *
 * Every write goes through the same `bulk-save` the Amazon matrix uses, and the one-bucket
 * invariant is expressed as a single transaction: the upsert that adds the photo to its new bucket
 * and the delete that removes it from the old one travel together. Splitting them would leave a
 * window where the same picture is in two buckets — the exact duplicate eBay will not collapse.
 */
import { useCallback, useMemo, useState } from 'react'

import { apiSend, routes, type ApiResult } from '../../api'
import { writeSubject } from '../../imageWrites'
import { placeInBucket, renumber, type EbayBucket, type EbayRow } from './buckets'

export function useEbayEdits(args: {
  productId: string
  rows: readonly EbayRow[]
  groupKey: string | null
  reload(): Promise<void>
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}) {
  const { productId, rows, groupKey, reload, write } = args
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const commit = useCallback(async (body: { upserts?: unknown[]; deletes?: string[] }) => {
    setBusy(true)
    setRefusal(null)
    const res = await write(writeSubject.surface('ebay-grid'), () => apiSend<unknown>(routes.bulkSave(productId), 'POST', body))
    if (!res.ok) { setRefusal(res.message); setBusy(false); return }
    await reload()
    setBusy(false)
  }, [productId, reload, write])

  const place = useCallback(async (url: string, bucket: EbayBucket, position: number) => {
    const outcome = placeInBucket({ url, target: bucket, groupKey, allRows: rows, position })
    // A refusal is a RESULT shown where the operator is looking, never a silent no-op.
    if (outcome.kind === 'refused') { setRefusal(outcome.reason); return }
    const existing = bucket.photos[position]
    await commit({
      upserts: [outcome.upsert],
      deletes: [
        // The photo's old home, when it had one.
        ...(outcome.kind === 'move' ? [outcome.removeRowId] : []),
        // Whatever was sitting at this position — the operator chose to replace it.
        ...(existing ? [existing.id] : []),
      ],
    })
  }, [commit, groupKey, rows])

  const remove = useCallback(async (bucket: EbayBucket, position: number) => {
    const photo = bucket.photos[position]
    if (!photo) { setRefusal('There is no photo in that position.'); return }
    const remaining = bucket.photos.filter((p) => p.id !== photo.id)
    // Renumber what is left: eBay reads position as an order, and a gap makes the cover ambiguous.
    const moves = renumber(remaining)
    await commit({
      deletes: [photo.id],
      upserts: moves.map((m) => {
        const src = remaining.find((p) => p.id === m.id)!
        return {
          id: src.id,
          scope: 'PLATFORM',
          platform: 'EBAY',
          marketplace: null,
          variantGroupKey: src.variantGroupKey,
          variantGroupValue: src.variantGroupValue,
          url: src.url,
          position: m.position,
          role: src.role,
        }
      }),
    })
  }, [commit])

  // Stable on its own, so a consumer can depend on the callback rather than the whole object.
  const dismiss = useCallback(() => setRefusal(null), [])

  // Memoised: a fresh object here breaks any consumer that correctly lists it as a
  // dependency — the memo never caches, and reads as though it does (PES ruling #156).
  return useMemo(
    () => ({ busy, refusal, dismiss, place, remove }),
    [busy, refusal, dismiss, place, remove],
  )
}
