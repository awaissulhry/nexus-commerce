'use client'

/**
 * The listings of the studio's channel · market · account, for the studio bar's listing picker (aliases, Owner
 * 2026-10-05: "I do not want to do anything in the address bar").
 *
 * ONE source: the destination's Status and Action read (`GET …/studio/publish-actions?channel&marketplace&accountId`) —
 * every listing record there, with each alias's name, place and state (`aliasLabel`, `aliasPosition`, `aliasStatus`),
 * and no channel call. A listing appears only when it has a record, which is exactly what the studio can open; only the
 * aliases the Publish window offers are listed (`offeredCells`: ACTIVE, with a record of the family's main product).
 *
 * The read is SHARED (review 2026-10-05, m2): the sheet's Status and Action columns and the toolbar mark read the same
 * destination, so the page makes one request (`readPublishActionsShared`), and every newer answer any of them gets
 * redraws the picker. It reads again (m1) when a listing of the family is created or removed, when a waiting Status
 * choice of the family may have started drafts, and when the page drops the family's reads (`invalidatePublishActions`,
 * e.g. after the sheet's own Status or Action write) — each time only an answer read after that moment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInvalidationChannel, type InvalidationEvent } from '@/lib/sync/invalidation-channel'
import { listingEventConcerns, offeredCells } from '@/app/products/_publication/dialog/destinations'
import { useStudioProduct, useStudioScope } from './contracts'
import { publishActionsReadKey, publishActionsReads, readPublishActionsShared } from './sheet/publishActionsApi'
import { isLocalPublishActionWrite } from './sheet/usePublishActions'
import { listingChoicesFromCells, listingParamForRecord, type ListingChoices } from './listingScope'
import type { PublishActionCell } from '@nexus/shared/publish-actions'

export interface ListingChoicesState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The last good answer for this coordinate; null before it. */
  choices: ListingChoices | null
}

const IDLE: ListingChoicesState = { status: 'idle', choices: null }
const LOADING: ListingChoicesState = { status: 'loading', choices: null }

/** The picker's listings from one read: the main listings and the offered aliases (pure; the tests read it). */
export function listingChoicesOf(cells: readonly PublishActionCell[], familyId: string): ListingChoices {
  return listingChoicesFromCells(offeredCells(cells, familyId), familyId)
}

interface Held {
  key: string
  value: ListingChoicesState
  /** When the answer shown was asked for (ms); -1 = not known. */
  startedAt: number
  /** The family's products in that answer: a listing event about one of them is ours. */
  products: readonly string[]
}

const productsOf = (cells: readonly PublishActionCell[]) => [...new Set(cells.map(cell => cell.productId))]

export function useListingChoices(productId: string, familyId: string, at: { channel: string | null; marketplace: string | null; accountId: string | null | undefined }): ListingChoicesState {
  const enabled = !!at.channel && !!at.marketplace && !!at.accountId
  const key = enabled ? JSON.stringify([productId, familyId, at.channel, at.marketplace, at.accountId]) : null
  const destination = useMemo(() => (enabled ? { channel: at.channel, marketplace: at.marketplace, accountId: at.accountId } : null),
    [enabled, at.channel, at.marketplace, at.accountId])
  const readKey = destination ? publishActionsReadKey(productId, destination) : null
  /** A read is asked for: on mount and coordinate change (any answer young enough), or after an event (`since`). */
  const [ask, setAsk] = useState<{ nonce: number; since?: number }>({ nonce: 0 })
  const [state, setState] = useState<Held | null>(null)
  useEffect(() => {
    if (!key || !destination) return
    const controller = new AbortController()
    // A re-read of the same coordinate keeps the last answer on screen while it runs.
    setState(previous => (previous?.key === key ? previous : { key, value: LOADING, startedAt: -1, products: [] }))
    readPublishActionsShared(productId, destination, controller.signal, ask.since === undefined ? {} : { since: ask.since })
      // The cache told the subscription below first (same answer, with its start time); this covers a missed one.
      .then(read => { if (!controller.signal.aborted) setState(previous => (previous?.key === key && previous.value.status === 'ready' && previous.startedAt >= 0 ? previous
        : { key, value: { status: 'ready', choices: listingChoicesOf(read.rows, familyId) }, startedAt: -1, products: productsOf(read.rows) })) })
      .catch(() => { if (!controller.signal.aborted) setState(previous => (previous?.key === key ? { ...previous, value: { status: 'error', choices: previous.value.choices } }
        : { key, value: { status: 'error', choices: null }, startedAt: -1, products: [] })) })
    return () => controller.abort()
  }, [key, destination, productId, familyId, ask])

  // Read again soon — an answer read after now — once per burst.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const readSoon = useCallback(() => {
    const since = Date.now()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; setAsk(previous => ({ nonce: previous.nonce + 1, since })) }, 400)
  }, [])

  // Every newer answer for this coordinate, whoever asked for it (the sheet's columns, the toolbar mark), redraws the
  // picker; a dropped read of this product asks again.
  const live = useRef({ key, readKey, familyId })
  live.current = { key, readKey, familyId }
  useEffect(() => publishActionsReads.subscribe(productId, event => {
    const now = live.current
    if (!now.key) return
    if (event.type === 'invalidated') { readSoon(); return }
    if (event.key !== now.readKey) return
    setState(previous => (previous?.key === now.key && previous.startedAt > event.startedAt ? previous
      : { key: now.key!, value: { status: 'ready', choices: listingChoicesOf(event.read.rows, now.familyId) }, startedAt: event.startedAt, products: productsOf(event.read.rows) }))
  }), [productId, readSoon])

  // A listing of the family created or removed anywhere (another tab, the list wizard), or a waiting Status choice that
  // may have started drafts: read again. An event about another product is not ours.
  const held = key && state?.key === key ? state : null
  const choices = held?.value.choices ?? null
  const known = useRef({ products: new Set<string>(), records: new Set<string>() })
  known.current = {
    products: new Set([productId, familyId, ...(held?.products ?? [])]),
    records: new Set(choices ? [...Object.keys(choices.aliasByRecord), ...(choices.mainListingId ? [choices.mainListingId] : [])] : []),
  }
  useInvalidationChannel(['listing.created', 'listing.deleted', 'listing.updated'], useCallback((event: InvalidationEvent) => {
    if (!live.current.key || !listingEventConcerns(event, known.current.products, known.current.records)) return
    // This tab's own Status or Action write: its drop of the shared reads already read again (one request, not two).
    if (isLocalPublishActionWrite(event)) return
    readSoon()
  }, [readSoon]))
  return key && state?.key === key ? state.value : key ? LOADING : IDLE
}

/**
 * For a page that lists listing RECORDS (the eBay and Amazon Media workspaces): the `listing=` the studio bar's picker
 * writes for the same listing (`listingParamForRecord`) — an alias by its alias id; a record the read does not know yet
 * is written as it is (the studio still resolves it).
 */
export function useListingParamForRecord(channel: string): (recordId: string) => string {
  const product = useStudioProduct()
  const { market, accountId } = useStudioScope()
  const { choices } = useListingChoices(product.id, product.parentId ?? product.id, { channel, marketplace: market, accountId })
  return useCallback((recordId: string) => listingParamForRecord(recordId, choices), [choices])
}
