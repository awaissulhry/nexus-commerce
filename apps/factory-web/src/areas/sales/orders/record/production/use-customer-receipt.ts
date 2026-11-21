'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { getMaterial, listSites, type SiteOption } from '../../../../_shared/buying/api'
import type { Order } from '../../api'
import { readProblem, type Phrase } from '../../model'
import type { Part } from '../record-model'
import { recordCustomerReceipt } from './api'
import type { CustomerGood } from './materials'
import { receiptBodyOf, receiptDraftOf, receiptHeldOf, receiptRefusalOf, receivePlacesOf, sentLinesOf, type ReceiptActions, type ReceiptDraft, type ReceiptModel } from './receipt'

/**
 * F-PT-304 (order PRODUCTION tab, 10-design §9 D3) — Record what the customer sent…, the container's part (OrderRecord.tsx mounts
 * it; a view never imports it). Only with inventory.receive (`may`; hidden otherwise, L9). Opening it reads the company's sites
 * with their places (GET /inventory/locations) and each material's tracking (product.materials.view; not readable: the server's own
 * refusal says it, in words); Record the receipt sends ONE command (one key per opening) and, done, the page reads the customer's
 * materials again (`onDone`).
 */
export function useCustomerReceipt(input: {
  readonly api: ApiClient
  readonly order: Order | null
  readonly may: boolean
  readonly goods: readonly CustomerGood[] | null
  readonly onDone: (number: string) => void
}): { readonly model: ReceiptModel | null; readonly actions: ReceiptActions } {
  const { api, order, may, goods } = input
  const [open, setOpen] = useState<{ draft: ReceiptDraft; sites: Part<SiteOption[]>; tracking: ReadonlyMap<string, string> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const key = useRef(newIdempotencyKey())
  const turn = useRef(0)
  const doneRef = useRef(input.onDone)
  doneRef.current = input.onDone

  const onOpen = useCallback(
    (only: string | null) => {
      if (!may || !order || !goods) return
      const mine = ++turn.current
      key.current = newIdempotencyKey()
      setProblem(null)
      setOpen({ draft: receiptDraftOf(goods, only, null), sites: { value: null, problem: null }, tracking: new Map() })
      listSites(api, order.companyId)
        .then((sites) =>
          mine === turn.current &&
          setOpen((known) => {
            if (!known) return known
            const site = known.draft.siteId ? sites.find((entry) => entry.id === known.draft.siteId) : sites.length === 1 ? sites[0] : null
            return { ...known, sites: { value: sites, problem: null }, draft: { ...known.draft, siteId: site?.id ?? null, locationId: known.draft.locationId ?? receivePlacesOf(site)[0]?.id ?? null } }
          }),
        )
        .catch((error: unknown) => mine === turn.current && setOpen((known) => (known ? { ...known, sites: { value: null, problem: readProblem(error) } } : known)))
      for (const itemId of new Set(goods.map((good) => good.itemId)))
        getMaterial(api, itemId)
          .then((material) => mine === turn.current && setOpen((known) => (known ? { ...known, tracking: new Map(known.tracking).set(itemId, material.tracking) } : known)))
          .catch(() => undefined)
    },
    [api, may, order, goods],
  )

  const actions: ReceiptActions = {
    onOpen,
    onDraft: (patch) =>
      setOpen((known) => {
        if (!known) return known
        const siteChanged = patch.siteId !== undefined && patch.siteId !== known.draft.siteId
        const site = siteChanged ? (known.sites.value ?? []).find((entry) => entry.id === patch.siteId) : null
        return { ...known, draft: { ...known.draft, ...patch, ...(siteChanged ? { locationId: receivePlacesOf(site)[0]?.id ?? null } : {}) } }
      }),
    onLine: (lineKey, patch) => setOpen((known) => (known ? { ...known, draft: { ...known.draft, lines: known.draft.lines.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)) } } : known)),
    onSubmit: () => {
      if (!open || !order || busy) return
      const body = receiptBodyOf(order, open.draft, open.tracking)
      if (!body || receiptHeldOf(open.draft, open.tracking, false)) return
      const sent = sentLinesOf(open.draft, open.tracking)
      setBusy(true)
      setProblem(null)
      recordCustomerReceipt(api, body, key.current)
        .then((answer) => {
          setOpen(null)
          doneRef.current(answer.receipt.number)
        })
        .catch((error: unknown) => setProblem(receiptRefusalOf(error, sent)))
        .finally(() => setBusy(false))
    },
    onClose: () => {
      turn.current++
      setOpen(null)
      setProblem(null)
    },
  }
  if (!may || !open) return { model: null, actions }
  return { model: { draft: open.draft, sites: open.sites, tracking: open.tracking, busy, problem, held: receiptHeldOf(open.draft, open.tracking, busy) }, actions }
}
