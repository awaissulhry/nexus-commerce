'use client'

/**
 * Sheet publish parity, step 2 (item 1) — the sheet learns what became of a publication without a click.
 *
 * Reads the destination's publication status once (`GET …/studio/publication-status`), then again whenever the
 * server announces `publication.status_changed` for this family on this exact destination. No polling loop: the
 * server's result sweep does the waiting, and the listing event stream carries the news. When a publication this tab
 * watched settles — or the channel never confirms it — ONE toast says so. The toolbar mark keeps the record.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudioPublicationStatus } from '@nexus/shared/studio-publication'
import type { SheetStatus } from '@/design-system/grid'
import { useToast } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useStudioProduct } from '@/app/products/[id]/edit/_studio/contracts'
import { publicationEventMatches, publicationEventOf, publicationMark, publicationOutcome, summaryCounts, type PublicationDestination } from './outcome'
import type { PublishRead } from '@/app/products/[id]/edit/_studio/sheet/channel/publishColumn'

const TOAST_MS = 10_000

export interface PublicationStatusTarget {
  channel: string
  marketplace: string
  accountId: string | null | undefined
  /** The studio's listing on this destination (`''` = the primary listing); `null` while the destination is not
   *  resolved — then nothing is read. */
  aliasKey: string | null
}

export function usePublicationStatus({ channel, marketplace, accountId, aliasKey }: PublicationStatusTarget) {
  const product = useStudioProduct()
  const { toast } = useToast()
  const [status, setStatus] = useState<StudioPublicationStatus | null>(null)
  /** Whether the newest read answered. A failed re-read keeps the last good `status` (and says so here). */
  const [readState, setReadState] = useState<PublishRead['state']>('idle')
  const [nonce, setNonce] = useState(0)
  /** The destination the held `status` answers for. */
  const readFor = useRef<string | null>(null)
  /** Publications this tab has already told the person about, so a repeated event never toasts twice. */
  const told = useRef(new Set<string>())
  /** A publication whose final word arrived; the next read supplies its counts for the toast. */
  const pending = useRef<{ publicationId: string; status: string } | null>(null)

  const destination = useMemo<PublicationDestination | null>(() => accountId && aliasKey !== null
    ? { productIds: [product.id, ...(product.parentId ? [product.parentId] : [])], channel, marketplace, accountId, aliasKey }
    : null, [product.id, product.parentId, channel, marketplace, accountId, aliasKey])

  useEffect(() => {
    if (!destination) { readFor.current = null; setStatus(null); setReadState('idle'); return }
    const controller = new AbortController()
    const key = JSON.stringify(destination)
    if (readFor.current !== key) {
      // Another destination: the last answer was about a different listing — never show it under this one.
      readFor.current = key
      setStatus(null)
      setReadState('loading')
    }
    const query = new URLSearchParams({ channel: destination.channel, market: destination.marketplace, accountId: destination.accountId, aliasKey: destination.aliasKey })
    fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(product.id)}/studio/publication-status?${query}`, { cache: 'no-store', signal: controller.signal })
      .then(response => (response.ok ? response.json() as Promise<StudioPublicationStatus> : null))
      .then(read => {
        if (controller.signal.aborted) return
        // A failed read keeps what the sheet knew: the mark is a convenience, never the only record.
        if (read) { setStatus(read); setReadState('ready') } else setReadState('error')
        const settled = pending.current
        if (!settled || told.current.has(settled.publicationId)) return
        pending.current = null
        told.current.add(settled.publicationId)
        const counts = read?.latest?.publicationId === settled.publicationId ? summaryCounts(read.latest.summary) : null
        const outcome = publicationOutcome(settled.status, counts, destination.channel, destination.marketplace)
        if (outcome) toast(outcome.message, outcome.tone, { duration: TOAST_MS })
      })
      .catch(() => { if (!controller.signal.aborted) setReadState('error') /* offline: the next event or reload reads again */ })
    return () => controller.abort()
  }, [destination, product.id, nonce, toast])

  useInvalidationChannel('publication.status_changed', useCallback(event => {
    const changed = publicationEventOf(event)
    if (!changed || !destination || !publicationEventMatches(changed, destination)) return
    if ((changed.terminal || changed.status === 'UNVERIFIED') && !told.current.has(changed.publicationId)) {
      pending.current = { publicationId: changed.publicationId, status: changed.status }
    }
    setNonce(n => n + 1)
  }, [destination]))

  const mark: SheetStatus | null = useMemo(() => publicationMark(status, channel, marketplace), [status, channel, marketplace])
  /* Step 3 — the "Last publish" column reads the same answer: one reader for the mark, the toast and every row. */
  const read: PublishRead = useMemo(() => ({ state: readState, status }), [readState, status])
  return { status, mark, read }
}
