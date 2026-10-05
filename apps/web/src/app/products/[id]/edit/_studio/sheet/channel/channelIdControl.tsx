'use client'

/**
 * Item ID control (docs/sheet-ids-sku-rows/A2-item-id-control.md, step I1) — the eBay Item ID cell of a MAIN row is a
 * real control, not only Copy and Open:
 *
 *   Enter / double-click   opens a DS `Modal` with the Item ID in an `Input`: type an id → Check (eBay is asked as this
 *                          business's account; the dialog says what eBay found, in plain words) → Link.
 *   "Not confirmed"        the dialog opens on the id Nexus holds: Check → Keep (eBay confirms it) or Clear.
 *   Delete / Clear         a plain confirm: "Nexus forgets item X. Nothing changes on eBay; it stays live and Nexus stops
 *                          updating it."
 *   Moves (Owner, option A) a variation holding ANOTHER item moves with the link only when eBay shows its own SKU on the
 *                          new item; the dialog lists each such row before Link ("M holds item 1234; eBay shows its SKU on
 *                          item 5678; Link moves it to 5678"), and the rows Link leaves alone.
 *
 * One eBay item carries the whole variation family, so a variation row is read-only ("Set on the main row"). The API
 * (`/api/listings/:id/channel-id/{check,link,unlink}`, listings.recover) proves every link again before it writes, writes
 * only the rows the item carries, fences on the Item ID and the listing version this sheet read, and leaves pushes
 * paused. Link and Clear are keyed commands (`sendCommand`): a double press runs once. After a write the sheet re-reads
 * (`listing.values_changed`, emitted here for this tab as the API emits it for the others).
 *
 * The provider is mounted once by `ChannelSheet`; the cell (`ListingIdCell.tsx`) asks it to open. DS parts only.
 */
import { createContext, useContext, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { Banner, Field, Modal, useToast } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, sendCommand, useCommandKey } from '@/lib/command-key'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

import type { ChannelSheetRow } from './types'

/** The permission the API asks for (permissions-manifest.ts): the one Claude's link and unlink tools need too. */
export const CHANNEL_ID_PERMISSION = 'listings.recover'

export const CHANNEL_ID_COPY = {
  title: 'eBay Item ID',
  subtitle: (sku: string, market: string) => `${sku} · eBay ${market}. One Item ID carries the whole variation family.`,
  field: 'Item ID',
  hint: 'The number on the eBay item page (9 to 15 digits). Check asks eBay, as this business\'s account, before anything is written.',
  check: 'Check',
  checking: 'Checking…',
  link: 'Link',
  keep: 'Keep',
  linking: 'Linking…',
  clear: 'Clear',
  clearing: 'Clearing…',
  cancel: 'Cancel',
  back: 'Back',
  clearTitle: 'Clear the Item ID',
  clearSentence: (itemId: string) => `Nexus forgets item ${itemId}. Nothing changes on eBay; it stays live and Nexus stops updating it.`,
  clearAfter: 'The rows read Not listed until you link an item again. Publishing them as new would create a second eBay item.',
  noPermission: 'You can see this Item ID. Checking, linking or clearing it needs the "Recover listings" permission.',
  typeFirst: 'Type the eBay Item ID, then Check.',
  notANumber: 'An eBay Item ID is 9 to 15 digits.',
  checkAgain: 'The Item ID changed since the check. Check it again.',
  found: 'What eBay says',
  moves: (n: number) => `Link moves ${n} row${n === 1 ? '' : 's'} from another item`,
  movesNote: 'eBay shows each one\'s own SKU on this item. A snapshot of each row is kept first.',
  nothingToChange: 'eBay confirms what Nexus holds. Nothing to change.',
  failed: 'The answer could not be read. Nothing was assumed: read the sheet again to see what Nexus holds.',
  command: 'Item ID change',
} as const

/** What the API's Check answers (`ChannelIdCheck`, identity-fix.service.ts). */
export interface ChannelIdCheckAnswer {
  listingId: string
  currentId: string | null
  version: number
  itemId: string
  ok: boolean
  unchanged: boolean
  refusal: string | null
  status: 'ACTIVE' | 'ENDED' | null
  found: string[]
  rows: Array<{ listingId: string; sku: string; from: string | null }>
  /** Rows that hold another item and that Link moves to this one (eBay shows their SKU on it), each with the API's sentence. */
  moved: Array<{ listingId: string; sku: string; channelSku: string; from: string; sentence: string }>
  /** Rows that hold an item whose SKU is not on this one: Link leaves them alone (their sentences are in `found` too). */
  kept: Array<{ id: string; sku: string; externalListingId: string; sentence: string }>
  pushes: string
}

interface WriteAnswer {
  ok: true
  externalId: string
  rows: Array<{ listingId: string; version: number }>
  sentence: string
  pushes?: string
}

/** The listing a main row's control acts on, and the fence: the Item ID and the version this sheet read. */
export interface ChannelIdTarget {
  listingId: string
  /** The family root's product id (the main row's): the sheet's live rule matches the write's event by it. */
  productId: string
  sku: string
  currentId: string | null
  version: number
}

/** PURE. The control's target for a row, or null: eBay, a main row (no parent), with a listing. */
export function channelIdTarget(row: Pick<ChannelSheetRow, 'id' | 'sku' | 'parentId' | 'listing'> | null | undefined, channel: string): ChannelIdTarget | null {
  if (!row?.listing || row.parentId || String(channel).toUpperCase() !== 'EBAY') return null
  const held = typeof row.listing.externalListingId === 'string' ? row.listing.externalListingId.trim() : ''
  return { listingId: row.listing.id, productId: row.id, sku: row.sku, currentId: held || null, version: row.listing.version }
}

/** PURE. What a person typed, as an id: spaces dropped (eBay shows "1234 5678 9012" on some pages). */
export const typedItemId = (raw: string): string => raw.replace(/\s+/g, '')

/** PURE. A first hint before eBay is asked; the API's proof is what decides. */
export const looksLikeItemId = (text: string): boolean => /^\d{9,15}$/.test(text)

export type DialogBusy = 'check' | 'link' | 'clear' | null

/** PURE. What the dialog offers now: Check, Link (or Keep), Clear — and why the primary waits. */
export function channelIdActions(input: { typed: string; target: ChannelIdTarget; check: ChannelIdCheckAnswer | null; busy: DialogBusy; canEdit: boolean }): {
  check: boolean
  link: { label: string; enabled: boolean } | null
  clear: boolean
  hint: string | null
} {
  const { typed, target, check, busy, canEdit } = input
  const idle = busy === null && canEdit
  const fresh = !!check && check.itemId === typed
  const keep = typed !== '' && typed === target.currentId
  const link = fresh && check!.ok && !check!.unchanged ? { label: keep ? CHANNEL_ID_COPY.keep : CHANNEL_ID_COPY.link, enabled: idle } : null
  const hint = !canEdit ? CHANNEL_ID_COPY.noPermission
    : !typed ? CHANNEL_ID_COPY.typeFirst
    : !looksLikeItemId(typed) ? CHANNEL_ID_COPY.notANumber
    : check && !fresh ? CHANNEL_ID_COPY.checkAgain
    : null
  return { check: idle && looksLikeItemId(typed), link, clear: idle && !!target.currentId, hint }
}

/** PURE. The answer of a write, or the plain sentence of its refusal (`conflict`: the idempotency layer's own words). */
export function readWriteAnswer(response: Pick<Response, 'ok'>, body: unknown, conflict: string | null): WriteAnswer | { error: string } {
  if (conflict) return { error: conflict }
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : null
  if (response.ok && b?.ok === true) return b as unknown as WriteAnswer
  return { error: typeof b?.message === 'string' && b.message ? b.message : CHANNEL_ID_COPY.failed }
}

/** The event the API sends to the other tabs, for this one: the sheet re-reads the family (`listingValuesLive.ts`). */
export function channelIdChangedEvent(target: Pick<ChannelIdTarget, 'productId'>, rows: WriteAnswer['rows']) {
  return {
    type: 'listing.values_changed' as const,
    id: target.productId,
    fields: ['externalListingId'],
    meta: { productId: target.productId, listings: rows.map((r) => ({ listingId: r.listingId, productId: target.productId, version: r.version })), fields: ['externalListingId'] },
  }
}

async function postJson(url: string, body: unknown): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { response, body: await response.json().catch(() => null) }
}

interface ChannelIdControlValue {
  channel: string
  marketplace: string
  canEdit: boolean
  /** Open the control on a main row; `clear` opens straight on the Clear confirm (the Delete key). */
  open: (row: ChannelSheetRow, intent?: 'edit' | 'clear') => void
}

const ChannelIdControlContext = createContext<ChannelIdControlValue | null>(null)

/** The control of the sheet the cell sits in, or null (another surface, no provider): the cell then stays read-only. */
export function useChannelIdControl(): ChannelIdControlValue | null {
  return useContext(ChannelIdControlContext)
}

export function ChannelIdControlProvider({ channel, marketplace, children }: { channel: string; marketplace: string; children: ReactNode }) {
  const canEdit = usePermission(CHANNEL_ID_PERMISSION)
  const [open, setOpen] = useState<{ target: ChannelIdTarget; intent: 'edit' | 'clear' } | null>(null)
  const value = useMemo<ChannelIdControlValue>(() => ({
    channel, marketplace, canEdit,
    open: (row, intent = 'edit') => {
      const target = channelIdTarget(row, channel)
      if (target) setOpen({ target, intent: intent === 'clear' && target.currentId ? 'clear' : 'edit' })
    },
  }), [channel, marketplace, canEdit])
  return (
    <ChannelIdControlContext.Provider value={value}>
      {children}
      {open && <ChannelIdDialog key={`${open.target.listingId}:${open.target.version}`} target={open.target} intent={open.intent} marketplace={marketplace}
        canEdit={canEdit} onClose={() => setOpen(null)} />}
    </ChannelIdControlContext.Provider>
  )
}

function ChannelIdDialog({ target, intent, marketplace, canEdit, onClose }: {
  target: ChannelIdTarget; intent: 'edit' | 'clear'; marketplace: string; canEdit: boolean; onClose: () => void
}) {
  const { toast } = useToast()
  const linkKey = useCommandKey()
  const clearKey = useCommandKey()
  const [mode, setMode] = useState<'edit' | 'clear'>(intent)
  const [typed, setTyped] = useState(target.currentId ?? '')
  const [check, setCheck] = useState<ChannelIdCheckAnswer | null>(null)
  const [busy, setBusy] = useState<DialogBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const actions = channelIdActions({ typed, target, check, busy, canEdit })
  const base = getBackendUrl()

  const run = async (kind: Exclude<DialogBusy, null>, work: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(kind); setError(null)
    try { await work() } catch { setError(CHANNEL_ID_COPY.failed) } finally { inFlight.current = false; setBusy(null) }
  }

  const doCheck = () => run('check', async () => {
    const { response, body } = await postJson(`${base}/api/listings/${encodeURIComponent(target.listingId)}/channel-id/check`, { externalId: typed })
    const answer = body as ChannelIdCheckAnswer | { message?: string } | null
    if (!response.ok || !answer || !('found' in answer)) { setCheck(null); setError((answer as { message?: string } | null)?.message || CHANNEL_ID_COPY.failed); return }
    setCheck(answer)
  })

  const done = (answer: WriteAnswer) => {
    emitInvalidation(channelIdChangedEvent(target, answer.rows))
    toast([answer.sentence, answer.pushes].filter(Boolean).join(' '), 'success')
    onClose()
  }

  const doLink = () => run('link', async () => {
    const sent = await sendCommand(linkKey, `${base}/api/listings/${encodeURIComponent(target.listingId)}/channel-id/link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalId: check!.itemId, expectedExternalId: target.currentId, expectedVersion: target.version }),
    })
    const answer = readWriteAnswer(sent.response, sent.body, sent.conflict ? commandConflictMessage(sent.conflict, CHANNEL_ID_COPY.command) : null)
    if ('error' in answer) { setError(answer.error); return }
    done(answer)
  })

  const doClear = () => run('clear', async () => {
    const sent = await sendCommand(clearKey, `${base}/api/listings/${encodeURIComponent(target.listingId)}/channel-id/unlink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedExternalId: target.currentId, expectedVersion: target.version }),
    })
    const answer = readWriteAnswer(sent.response, sent.body, sent.conflict ? commandConflictMessage(sent.conflict, CHANNEL_ID_COPY.command) : null)
    if ('error' in answer) { setError(answer.error); return }
    done(answer)
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    // Enter in the field: Link once a fresh check allows it, else Check.
    if (actions.link?.enabled) void doLink()
    else if (actions.check) void doCheck()
  }

  const closeUnlessBusy = () => { if (!busy) onClose() }

  if (mode === 'clear' && target.currentId) {
    return <Modal open onClose={closeUnlessBusy} size="sm" title={CHANNEL_ID_COPY.clearTitle} subtitle={CHANNEL_ID_COPY.subtitle(target.sku, marketplace)}
      footer={<>
        <Button variant="secondary" data-autofocus disabled={!!busy} onClick={() => (intent === 'clear' ? onClose() : setMode('edit'))}>{intent === 'clear' ? CHANNEL_ID_COPY.cancel : CHANNEL_ID_COPY.back}</Button>
        <Button variant="danger" disabled={!canEdit || !!busy} onClick={() => { void doClear() }}>{busy === 'clear' ? CHANNEL_ID_COPY.clearing : CHANNEL_ID_COPY.clear}</Button>
      </>}>
      {error && <div className="nds-confirm-block"><Banner tone="danger">{error}</Banner></div>}
      {!canEdit && <div className="nds-confirm-block"><Banner tone="info">{CHANNEL_ID_COPY.noPermission}</Banner></div>}
      <p className="nds-confirm-block nds-confirm-h">{CHANNEL_ID_COPY.clearSentence(target.currentId)}</p>
      <p className="nds-confirm-block">{CHANNEL_ID_COPY.clearAfter}</p>
    </Modal>
  }

  const formId = `channel-id-${target.listingId}`
  return <Modal open onClose={closeUnlessBusy} size="md" title={CHANNEL_ID_COPY.title} subtitle={CHANNEL_ID_COPY.subtitle(target.sku, marketplace)}
    footer={<>
      {actions.clear && <Button variant="danger" disabled={!!busy} onClick={() => { setError(null); setMode('clear') }}>{CHANNEL_ID_COPY.clear}</Button>}
      <Button variant="secondary" disabled={!!busy} onClick={onClose}>{CHANNEL_ID_COPY.cancel}</Button>
      <Button variant={actions.link ? 'secondary' : 'primary'} type={actions.link ? 'button' : 'submit'} form={formId} disabled={!actions.check}
        onClick={actions.link ? () => { void doCheck() } : undefined}>{busy === 'check' ? CHANNEL_ID_COPY.checking : CHANNEL_ID_COPY.check}</Button>
      {actions.link && <Button variant="primary" type="submit" form={formId} disabled={!actions.link.enabled}>{busy === 'link' ? CHANNEL_ID_COPY.linking : actions.link.label}</Button>}
    </>}>
    <form id={formId} onSubmit={submit} aria-busy={!!busy}>
      {error && <div className="nds-confirm-block"><Banner tone="danger">{error}</Banner></div>}
      <div className="nds-confirm-block">
        <Field label={CHANNEL_ID_COPY.field} hint={actions.hint ?? CHANNEL_ID_COPY.hint}>
          <Input value={typed} inputMode="numeric" autoComplete="off" spellCheck={false} data-autofocus disabled={!canEdit || !!busy}
            onChange={(event) => setTyped(typedItemId(event.target.value))} />
        </Field>
      </div>
      {check && check.itemId === typed && <ChannelIdFindings check={check} />}
    </form>
  </Modal>
}

/**
 * What the proof found: the refusal (danger), or eBay's confirmation (success); then, before Link, every row Link moves
 * from another item (a warning, in the API's words); then each finding as a plain sentence (the rows left alone among them).
 */
export function ChannelIdFindings({ check }: { check: ChannelIdCheckAnswer }) {
  const moved = check.refusal ? [] : check.moved ?? []
  return <>
    <div className="nds-confirm-block">
      {check.refusal ? <Banner tone="danger">{check.refusal}</Banner>
        : check.unchanged ? <Banner tone="success">{CHANNEL_ID_COPY.nothingToChange}</Banner>
        : <Banner tone={check.status === 'ENDED' ? 'warning' : 'success'}>{check.pushes}</Banner>}
    </div>
    {moved.length > 0 && <div className="nds-confirm-block">
      <Banner tone="warning" title={CHANNEL_ID_COPY.moves(moved.length)}>
        <ul className="nds-confirm-list">{moved.map((row) => <li key={row.listingId}>{row.sentence}</li>)}</ul>
        {CHANNEL_ID_COPY.movesNote}
      </Banner>
    </div>}
    {check.found.length > 0 && <div className="nds-confirm-block">
      <div className="nds-confirm-h">{CHANNEL_ID_COPY.found}</div>
      <ul className="nds-confirm-list">{check.found.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </div>}
  </>
}
