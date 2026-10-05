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
 * the main listing and each alias the Publish window offers (ACTIVE), named and placed by the same publish-actions read
 * the window uses (`listedAliases`). Each listing has its own status read; the mark shows the worst (the newest of
 * equals) and names the others in its detail (`combinedPublicationMark`); the toast names the listing ("eBay · IT · ①
 * Racing edition accepted the product."). With one listing chosen — an alias, or "Main listing" (m5: not "All
 * listings") — only that listing, named the same way. `status` and `read` stay the chosen (or main) listing's: the
 * sheet's column and rejected-rows filter read them as before. Until the aliases are read (or when that read fails), the
 * main or chosen listing is named as before aliases, "eBay · IT" (m9).
 *
 * The alias read is the page's SHARED publish-actions read (m2: one request with the sheet's Status and Action columns and
 * the listing picker), and every newer answer of it renames the listings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudioPublicationStatus } from '@nexus/shared/studio-publication'
import type { SheetStatus } from '@/design-system/grid'
import { useToast } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useStudioProduct, useStudioScope } from '@/app/products/[id]/edit/_studio/contracts'
import { publishActionsReadKey, publishActionsReads, readPublishActionsShared } from '@/app/products/[id]/edit/_studio/sheet/publishActionsApi'
import { sellingChangeInFlight } from '@/app/products/[id]/edit/_studio/sheet/channel/publishColumn'
import {
  combinedPublicationMark, eventListing, listingPlace, publicationEventOf, publicationOutcome, summaryCounts, watchedListings,
  type PublicationDestination, type WatchedAlias,
} from './outcome'
import { listedAliases } from './destinations'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import type { PublishRead } from '@/app/products/[id]/edit/_studio/sheet/channel/publishColumn'

const TOAST_MS = 10_000
const NO_ALIASES: readonly WatchedAlias[] = Object.freeze([])
const NO_READS: ReadonlyMap<string, PublishRead> = new Map()
const IDLE: PublishRead = Object.freeze({ state: 'idle', status: null }) as PublishRead

export interface PublicationStatusTarget {
  channel: string
  marketplace: string
  accountId: string | null | undefined
  /** The studio's listing on this destination (`''` = the main listing, or every listing when none is chosen); `null`
   *  while the destination is not resolved — then nothing is read. */
  aliasKey: string | null
}

/** The destination's offered aliases, by position, from a publish-actions read (pure; the tests read it). */
export function destinationAliases(cells: readonly PublishActionCell[], familyId: string, at: { channel: string; marketplace: string; accountId: string }): WatchedAlias[] {
  return listedAliases(cells, familyId).filter(a => a.channel === at.channel && a.marketplace === at.marketplace && a.accountId === at.accountId)
    .sort((a, b) => a.position - b.position)
}

/**
 * The listings a selling-change re-read asks for again (m2): only those whose own read still shows a selling change on
 * its way; none (a last tick after it settled) — none at all.
 */
export function listingsStillSending(listings: readonly string[], statusOf: (listing: string) => StudioPublicationStatus | null, now: number = Date.now()): string[] {
  return listings.filter(listing => sellingChangeInFlight(statusOf(listing), now))
}

export function usePublicationStatus({ channel, marketplace, accountId, aliasKey }: PublicationStatusTarget) {
  const product = useStudioProduct()
  const { toast } = useToast()
  /** Publications this tab has already told the person about, so a repeated event never toasts twice. */
  const told = useRef(new Set<string>())
  /** Publications whose final word arrived, by listing; the next read of that listing supplies the counts for the toast. */
  const pending = useRef(new Map<string, { status: string; aliasKey: string }>())

  const familyId = product.parentId ?? product.id
  // m5 — a listing is chosen (an alias, or "Main listing"): only it is watched; none chosen: every listing.
  const chosen = !!useStudioScope().listingId
  const destination = useMemo<PublicationDestination | null>(() => accountId && aliasKey !== null
    ? { productIds: [product.id, ...(product.parentId ? [product.parentId] : [])], channel, marketplace, accountId, aliasKey }
    : null, [product.id, product.parentId, channel, marketplace, accountId, aliasKey])
  const destinationKey = destination ? JSON.stringify(destination) : null

  // ── the destination's offered aliases: names and places, from the SHARED publish-actions read (no channel call) ───
  // `aliases` null: not read yet, or the read failed — the main or chosen listing is then named as before aliases (m9).
  const [aliasRead, setAliasRead] = useState<{ key: string; aliases: readonly WatchedAlias[]; startedAt: number } | null>(null)
  const [aliasAsk, setAliasAsk] = useState<{ nonce: number; since?: number }>({ nonce: 0 })
  const accountOf = destination?.accountId ?? null
  const aliasTarget = accountOf ? JSON.stringify([product.id, familyId, channel, marketplace, accountOf]) : null
  const readKey = accountOf ? publishActionsReadKey(product.id, { channel, marketplace, accountId: accountOf }) : null
  useEffect(() => {
    if (!aliasTarget || !accountOf) return
    const controller = new AbortController()
    const at = { channel, marketplace, accountId: accountOf }
    readPublishActionsShared(product.id, at, controller.signal, aliasAsk.since === undefined ? {} : { since: aliasAsk.since })
      // The cache told the subscription below first (with the read's start time); this covers a missed one.
      .then(read => { if (!controller.signal.aborted) setAliasRead(previous => (previous?.key === aliasTarget && previous.startedAt >= 0 ? previous
        : { key: aliasTarget, aliases: destinationAliases(read.rows, familyId, at), startedAt: -1 })) })
      // Unread: the mark and toast cover the main (or chosen) listing, named as before aliases; an alias event reads again.
      .catch(() => undefined)
    return () => controller.abort()
  }, [aliasTarget, aliasAsk, product.id, familyId, channel, marketplace, accountOf])
  // Every newer answer of the shared read renames the listings; a dropped read asks again (an answer read after now).
  const aliasLive = useRef({ aliasTarget, readKey, familyId, at: { channel, marketplace, accountId: accountOf ?? '' } })
  aliasLive.current = { aliasTarget, readKey, familyId, at: { channel, marketplace, accountId: accountOf ?? '' } }
  useEffect(() => publishActionsReads.subscribe(product.id, event => {
    const now = aliasLive.current
    if (!now.aliasTarget) return
    if (event.type === 'invalidated') { setAliasAsk(previous => ({ nonce: previous.nonce + 1, since: Date.now() })); return }
    if (event.key !== now.readKey) return
    setAliasRead(previous => (previous?.key === now.aliasTarget && previous.startedAt > event.startedAt ? previous
      : { key: now.aliasTarget!, aliases: destinationAliases(event.read.rows, now.familyId, now.at), startedAt: event.startedAt }))
  }), [product.id])
  const aliases = aliasRead && aliasRead.key === aliasTarget ? aliasRead.aliases : null
  const listings = useMemo(() => (destination ? watchedListings(destination.aliasKey, aliases ?? NO_ALIASES, chosen) : []), [destination, aliases, chosen])
  const listingsKey = listings.join('\n')

  // ── one status read per watched listing ──────────────────────────────────────────────────────────────────────────
  const [store, setStore] = useState<{ key: string | null; reads: ReadonlyMap<string, PublishRead> }>({ key: null, reads: NO_READS })
  /** Each listing's read request: bumped by an event about it, or by `reload`. */
  const [asked, setAsked] = useState<{ one: ReadonlyMap<string, number> }>({ one: new Map() })
  const started = useRef(new Map<string, { signature: string; controller: AbortController }>())
  const chosenAliasKey = destination?.aliasKey ?? ''
  const placeOf = useCallback((listing: string) => listingPlace(channel, marketplace, listing, aliases, chosenAliasKey), [channel, marketplace, aliases, chosenAliasKey])
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
      const signature = `${destinationKey}|${asked.one.get(listing) ?? 0}`
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
    const about = eventListing(changed, destination, listings, !chosen)
    if (!about) return
    if ((changed.terminal || changed.status === 'UNVERIFIED') && !told.current.has(changed.publicationId)) {
      pending.current.set(changed.publicationId, { status: changed.status, aliasKey: about.aliasKey })
    }
    // An alias the sheet has not read yet (just created or adopted): read the aliases again — an answer read after this
    // event — and its own status read follows.
    if (!about.known) { const since = Date.now(); setAliasAsk(previous => ({ nonce: previous.nonce + 1, since })); return }
    setAsked(previous => ({ one: new Map(previous.one).set(about.aliasKey, (previous.one.get(about.aliasKey) ?? 0) + 1) }))
  }, [destination, listings, chosen]))

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
  /**
   * The "Last publish" column's re-read while a selling change is still being sent: only the listings whose own read
   * still shows one on its way (m2) — never every listing of the destination.
   */
  const readsRef = useRef(reads)
  readsRef.current = reads
  const listingsRef = useRef(listings)
  listingsRef.current = listings
  const reload = useCallback(() => {
    const again = listingsStillSending(listingsRef.current, listing => readsRef.current.get(listing)?.status ?? null)
    if (!again.length) return
    setAsked(previous => {
      const one = new Map(previous.one)
      for (const listing of again) one.set(listing, (one.get(listing) ?? 0) + 1)
      return { one }
    })
  }, [])
  return { status, mark, read, reload, aliasReads }
}
