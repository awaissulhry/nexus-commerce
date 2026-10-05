'use client'

/**
 * Sheet publish parity, step 2 (item 1) — the sheet learns what became of a publication without a click.
 *
 * Reads the destination's publication status once (`GET …/studio/publication-status`), then again whenever the
 * server announces `publication.status_changed` for this family on this exact destination. No polling loop: the
 * server's result sweep does the waiting, and the listing event stream carries the news. When a publication this tab
 * watched settles — or the channel never confirms it — ONE toast says so. The toolbar mark keeps the record.
 *
 * Aliases (Owner 2026-10-05): with no listing chosen, the mark and the toast cover EVERY listing of the destination —
 * the main listing and each ACTIVE alias, named and placed by the same publish-actions read the Publish window uses
 * (`listedAliases`). Each listing has its own status read; the mark shows the worst (the newest of equals) and names
 * the others in its detail (`combinedPublicationMark`); the toast names the listing ("eBay · IT · ① Racing edition
 * accepted the product."). With one listing chosen, only that listing — named the same way. `status` and `read` stay
 * the chosen (or main) listing's: the sheet's column and rejected-rows filter read them as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudioPublicationStatus } from '@nexus/shared/studio-publication'
import type { SheetStatus } from '@/design-system/grid'
import { useToast } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useStudioProduct } from '@/app/products/[id]/edit/_studio/contracts'
import { readPublishActions } from '@/app/products/[id]/edit/_studio/sheet/publishActionsApi'
import {
  combinedPublicationMark, eventListing, listingPlace, publicationEventOf, publicationOutcome, summaryCounts, watchedListings,
  type PublicationDestination, type WatchedAlias,
} from './outcome'
import { listedAliases } from './destinations'
import type { PublishRead } from '@/app/products/[id]/edit/_studio/sheet/channel/publishColumn'

const TOAST_MS = 10_000
const NO_ALIASES: readonly WatchedAlias[] = Object.freeze([])
const NO_READS: ReadonlyMap<string, PublishRead> = new Map()
const IDLE: PublishRead = Object.freeze({ state: 'idle', status: null }) as PublishRead

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
  /** Publications this tab has already told the person about, so a repeated event never toasts twice. */
  const told = useRef(new Set<string>())
  /** Publications whose final word arrived, by listing; the next read of that listing supplies the counts for the toast. */
  const pending = useRef(new Map<string, { status: string; aliasKey: string }>())

  const familyId = product.parentId ?? product.id
  const destination = useMemo<PublicationDestination | null>(() => accountId && aliasKey !== null
    ? { productIds: [product.id, ...(product.parentId ? [product.parentId] : [])], channel, marketplace, accountId, aliasKey }
    : null, [product.id, product.parentId, channel, marketplace, accountId, aliasKey])
  const destinationKey = destination ? JSON.stringify(destination) : null

  // ── the destination's ACTIVE aliases: names and places, from the publish-actions read (no channel call) ─────────────
  const [aliasRead, setAliasRead] = useState<{ key: string; aliases: readonly WatchedAlias[] } | null>(null)
  const [aliasNonce, setAliasNonce] = useState(0)
  const aliasTarget = destination ? JSON.stringify([product.id, channel, marketplace, destination.accountId]) : null
  useEffect(() => {
    if (!aliasTarget || !destination) return
    const controller = new AbortController()
    readPublishActions(product.id, { channel, marketplace, accountId: destination.accountId }, controller.signal)
      .then(read => {
        if (controller.signal.aborted) return
        const aliases = listedAliases(read.rows, familyId).filter(a => a.channel === channel && a.marketplace === marketplace && a.accountId === destination.accountId)
          .sort((a, b) => a.position - b.position)
        setAliasRead({ key: aliasTarget, aliases })
      })
      // Unread: the mark and toast cover the main (or chosen) listing, as before; an alias event reads them again.
      .catch(() => { if (!controller.signal.aborted) setAliasRead(previous => previous?.key === aliasTarget ? previous : { key: aliasTarget, aliases: NO_ALIASES }) })
    return () => controller.abort()
    // `destination` is read for its account only; `aliasTarget` names it.
  }, [aliasTarget, aliasNonce, product.id, familyId, channel, marketplace]) // eslint-disable-line react-hooks/exhaustive-deps
  const aliases = aliasRead && aliasRead.key === aliasTarget ? aliasRead.aliases : NO_ALIASES
  const listings = useMemo(() => (destination ? watchedListings(destination.aliasKey, aliases) : []), [destination, aliases])
  const listingsKey = listings.join('\n')

  // ── one status read per watched listing ──────────────────────────────────────────────────────────────────────────
  const [store, setStore] = useState<{ key: string | null; reads: ReadonlyMap<string, PublishRead> }>({ key: null, reads: NO_READS })
  /** Each listing's read request: bumped by an event about it, or by `reload`. */
  const [asked, setAsked] = useState<{ all: number; one: ReadonlyMap<string, number> }>({ all: 0, one: new Map() })
  const started = useRef(new Map<string, { signature: string; controller: AbortController }>())
  const placeOf = useCallback((listing: string) => listingPlace(channel, marketplace, listing, aliases), [channel, marketplace, aliases])
  const placeRef = useRef(placeOf)
  placeRef.current = placeOf

  useEffect(() => {
    if (!destination || !destinationKey) {
      for (const read of started.current.values()) read.controller.abort()
      started.current.clear()
      setStore({ key: null, reads: NO_READS })
      return
    }
    // Another destination: the last answers were about different listings — never show them under these.
    setStore(previous => previous.key === destinationKey ? previous : { key: destinationKey, reads: NO_READS })
    for (const [listing, read] of started.current) {
      if (!read.signature.startsWith(`${destinationKey}|`) || !listings.includes(listing)) { read.controller.abort(); started.current.delete(listing) }
    }
    for (const listing of listings) {
      const signature = `${destinationKey}|${asked.all}|${asked.one.get(listing) ?? 0}`
      if (started.current.get(listing)?.signature === signature) continue
      started.current.get(listing)?.controller.abort()
      const controller = new AbortController()
      started.current.set(listing, { signature, controller })
      setStore(previous => {
        if (previous.key !== destinationKey) return previous
        const held = previous.reads.get(listing)
        const next = new Map(previous.reads)
        next.set(listing, held?.status ? held : { state: 'loading', status: null })
        return { key: destinationKey, reads: next }
      })
      const query = new URLSearchParams({ channel: destination.channel, market: destination.marketplace, accountId: destination.accountId, aliasKey: listing })
      fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(product.id)}/studio/publication-status?${query}`, { cache: 'no-store', signal: controller.signal })
        .then(response => (response.ok ? response.json() as Promise<StudioPublicationStatus> : null))
        .catch(() => null /* offline: the next event or reload reads again */)
        .then(read => {
          if (controller.signal.aborted) return
          // A failed read keeps what the sheet knew: the mark is a convenience, never the only record.
          setStore(previous => {
            if (previous.key !== destinationKey) return previous
            const next = new Map(previous.reads)
            next.set(listing, read ? { state: 'ready', status: read } : { state: 'error', status: previous.reads.get(listing)?.status ?? null })
            return { key: destinationKey, reads: next }
          })
          for (const [publicationId, settled] of pending.current) {
            if (settled.aliasKey !== listing || told.current.has(publicationId)) continue
            pending.current.delete(publicationId)
            told.current.add(publicationId)
            const counts = read?.latest?.publicationId === publicationId ? summaryCounts(read.latest.summary) : null
            const outcome = publicationOutcome(settled.status, counts, destination.channel, destination.marketplace, placeRef.current(listing))
            if (outcome) toast(outcome.message, outcome.tone, { duration: TOAST_MS })
          }
        })
    }
    // `listingsKey` stands for `listings`.
  }, [destinationKey, listingsKey, asked, product.id, toast]) // eslint-disable-line react-hooks/exhaustive-deps
  // Unmounted (or React's development re-mount): stop every read and forget it, so a re-mount reads again.
  useEffect(() => () => { for (const read of started.current.values()) read.controller.abort(); started.current.clear() }, [])

  useInvalidationChannel('publication.status_changed', useCallback(event => {
    const changed = publicationEventOf(event)
    if (!changed || !destination) return
    const about = eventListing(changed, destination, listings)
    if (!about) return
    if ((changed.terminal || changed.status === 'UNVERIFIED') && !told.current.has(changed.publicationId)) {
      pending.current.set(changed.publicationId, { status: changed.status, aliasKey: about.aliasKey })
    }
    // An alias the sheet has not read yet (just created or adopted): read the aliases again; its own read follows.
    if (!about.known) { setAliasNonce(n => n + 1); return }
    setAsked(previous => ({ ...previous, one: new Map(previous.one).set(about.aliasKey, (previous.one.get(about.aliasKey) ?? 0) + 1) }))
  }, [destination, listings]))

  const reads = destinationKey && store.key === destinationKey ? store.reads : NO_READS
  /** The chosen (or main) listing's read: the sheet's "Last publish" column and rejected-rows filter read it. */
  const own = destination ? reads.get(destination.aliasKey) ?? { state: 'loading' as const, status: null } : IDLE
  const status = own.status
  const mark: SheetStatus | null = useMemo(() => combinedPublicationMark(listings.map(listing => ({ read: reads.get(listing)?.status ?? null, place: placeOf(listing) })), channel, marketplace),
    [listings, reads, placeOf, channel, marketplace])
  /* Step 3 — the "Last publish" column reads the same answer: one reader for the mark, the toast and every row. */
  const read: PublishRead = useMemo(() => ({ state: own.state, status: own.status }), [own.state, own.status])
  /** Each alias's read (no listing chosen), for a surface that shows every listing's rows. */
  const aliasReads = useMemo<ReadonlyMap<string, PublishRead>>(() => new Map([...reads].filter(([listing]) => listing !== '' && listing !== destination?.aliasKey)),
    [reads, destination?.aliasKey])
  /** Read every watched listing again now (the Last publish column re-reads while a selling change is still being sent). */
  const reload = useCallback(() => setAsked(previous => ({ ...previous, all: previous.all + 1 })), [])
  return { status, mark, read, reload, aliasReads }
}
