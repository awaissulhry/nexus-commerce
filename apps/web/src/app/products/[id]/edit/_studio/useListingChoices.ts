'use client'

/**
 * The listings of the studio's channel · market · account, for the studio bar's listing picker (aliases, Owner
 * 2026-10-05: "I do not want to do anything in the address bar").
 *
 * ONE source: the destination's Status and Action read (`GET …/studio/publish-actions?channel&marketplace&accountId`) —
 * every listing record there, with each active alias's name and place (`aliasLabel`, `aliasPosition`), and no channel
 * call. A listing appears only when it has a record, which is exactly what the studio can open. Read again when the
 * coordinate changes and when a listing is created or removed (a new alias from the sheet's "Add rows").
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useStudioProduct, useStudioScope } from './contracts'
import { readPublishActions } from './sheet/publishActionsApi'
import { listingChoicesFromCells, listingParamForRecord, type ListingChoices } from './listingScope'

export interface ListingChoicesState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The last good answer for this coordinate; null before it. */
  choices: ListingChoices | null
}

const IDLE: ListingChoicesState = { status: 'idle', choices: null }

export function useListingChoices(productId: string, familyId: string, at: { channel: string | null; marketplace: string | null; accountId: string | null | undefined }): ListingChoicesState {
  const enabled = !!at.channel && !!at.marketplace && !!at.accountId
  const key = enabled ? JSON.stringify([productId, familyId, at.channel, at.marketplace, at.accountId]) : null
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{ key: string; value: ListingChoicesState } | null>(null)
  useEffect(() => {
    if (!key) return
    const [, family, channel, marketplace, accountId] = JSON.parse(key) as [string, string, string, string, string]
    const controller = new AbortController()
    // A re-read of the same coordinate keeps the last answer on screen while it runs.
    setState(previous => (previous?.key === key ? previous : { key, value: { status: 'loading', choices: null } }))
    readPublishActions(productId, { channel, marketplace, accountId }, controller.signal)
      .then(read => { if (!controller.signal.aborted) setState({ key, value: { status: 'ready', choices: listingChoicesFromCells(read.rows, family) } }) })
      .catch(() => { if (!controller.signal.aborted) setState(previous => ({ key, value: { status: 'error', choices: previous?.key === key ? previous.value.choices : null } })) })
    return () => controller.abort()
  }, [key, productId, nonce])
  // A listing created or removed anywhere (another tab, the sheet's Add rows): read again, once per burst.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useInvalidationChannel(['listing.created', 'listing.deleted'], () => {
    if (!key) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; setNonce(n => n + 1) }, 400)
  })
  return key && state?.key === key ? state.value : key ? { status: 'loading', choices: null } : IDLE
}

/**
 * For a page that lists listing RECORDS (the eBay and Amazon Media workspaces): the `listing=` the studio bar's picker
 * writes for the same listing — an alias by its alias id, the main listing by the family's main record. One id kind on
 * every page; a record the read does not know yet is written as it is (the studio still resolves it).
 */
export function useListingParamForRecord(channel: string): (recordId: string) => string {
  const product = useStudioProduct()
  const { market, accountId } = useStudioScope()
  const { choices } = useListingChoices(product.id, product.parentId ?? product.id, { channel, marketplace: market, accountId })
  return useCallback((recordId: string) => listingParamForRecord(recordId, choices), [choices])
}
