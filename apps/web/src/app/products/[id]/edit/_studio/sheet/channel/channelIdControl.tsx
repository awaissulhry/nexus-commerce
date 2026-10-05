'use client'

/**
 * Item ID control (docs/sheet-ids-sku-rows/A2-item-id-control.md, steps I1–I4) — a channel id cell is a real control,
 * not only Copy and Open: eBay's Item ID (I1), Etsy's Listing ID (I2), Shopify's Product ID (I3), Amazon's ASIN (I4).
 *
 *   Enter / double-click   opens a DS `Modal` with the id in an `Input`: type an id → Check (the channel is asked as this
 *                          business's account; the dialog says what it found, in plain words) → Link.
 *   "Not confirmed"        the dialog opens on the id Nexus holds: Check → Keep (the channel confirms it) or Clear.
 *   Delete / Clear         a plain confirm in the API's words ("Nexus forgets item X. Nothing changes on eBay; …").
 *   Moves (Owner, option A) a row holding ANOTHER item moves with the link only when the channel shows its own SKU on the
 *                          new item; the dialog lists each such row before Link, and the rows Link leaves alone.
 *
 * eBay, Etsy and Shopify: one id carries the whole family, so the control is on the family's MAIN row only (a variation
 * row is read-only, "Set on the main row"); in a Shopify colour store the main row is still the door (Check finds the
 * colour the typed product is; Link confirms that colour, which writes the Nexus identity on Shopify — the dialog says
 * so before Link). Amazon: the ASIN is one row's own — on a row not on Amazon a typed ASIN becomes the one it lists on at
 * Publish (Set; Clear removes it); a live offer's ASIN is Amazon's, and Check says Amazon's reason and the way.
 *
 * The API (`/api/listings/:id/channel-id/{check,link,unlink}`, listings.recover) proves every link again before it
 * writes, writes only the rows the item carries, fences on the id and the listing version this sheet read, and leaves
 * pushes paused. Link and Clear are keyed commands (`sendCommand`): a double press runs once. After a write the sheet
 * re-reads (`listing.values_changed`, emitted here for this tab as the API emits it for the others).
 *
 * The provider is mounted once by the CHANNEL adapter in `ProductSheet.tsx` (the path the studio renders; `ChannelSheet.tsx`
 * is a wrapper nothing renders); the cell (`ListingIdCell.tsx`) asks it to open. DS parts only.
 */
import { createContext, useContext, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { Banner, Field, Modal, useToast } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { channelPlace } from '@nexus/shared/channel-label'
import { commandConflictMessage, sendCommand, useCommandKey } from '@/lib/command-key'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

import type { ChannelSheetRow } from './types'

/** The permission the API asks for (permissions-manifest.ts): the one Claude's link and unlink tools need too. */
export const CHANNEL_ID_PERMISSION = 'listings.recover'

export const CHANNEL_ID_COPY = {
  title: 'eBay Item ID',
  subtitle: (sku: string, market: string) => `${sku} on ${channelPlace('EBAY', market)}. One Item ID carries the whole variation family.`,
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

/** The words of one channel's control (eBay's are `CHANNEL_ID_COPY`; the Clear sentences are the API's `unlinkSentence`). */
export interface ChannelIdWords {
  title: string
  subtitle: (sku: string, market: string) => string
  field: string
  hint: string
  clearTitle: string
  clearSentence: (id: string) => string
  clearAfter: string
  noPermission: string
  typeFirst: string
  notANumber: string
  checkAgain: string
  found: string
  moves: (n: number) => string
  movesNote: string
  nothingToChange: string
  command: string
  /** The primary write's label: Link (a shared id), Set (Amazon's ASIN for Publish). */
  link: string
  linking: string
}

const moves = (noun: string) => (n: number) => `Link moves ${n} row${n === 1 ? '' : 's'} from another ${noun}`

export const CHANNEL_ID_WORDS: Readonly<Record<'EBAY' | 'ETSY' | 'SHOPIFY' | 'AMAZON', ChannelIdWords>> = {
  EBAY: { ...CHANNEL_ID_COPY },
  ETSY: {
    title: 'Etsy Listing ID',
    subtitle: (sku, _market) => `${sku} on ${channelPlace('ETSY')}. One Etsy listing carries the whole family.`,
    field: 'Listing ID',
    hint: 'The number in the listing\'s web address (etsy.com/listing/…). Check asks Etsy, as this business\'s shop, before anything is written.',
    clearTitle: 'Clear the Listing ID',
    clearSentence: (id) => `Nexus forgets Etsy listing ${id}. Nothing changes on Etsy; it stays live and Nexus stops updating it.`,
    clearAfter: 'The rows read Not listed until you link a listing again. Publishing them as new would create a second Etsy listing.',
    noPermission: 'You can see this Listing ID. Checking, linking or clearing it needs the "Recover listings" permission.',
    typeFirst: 'Type the Etsy Listing ID, then Check.',
    notANumber: 'An Etsy Listing ID is a number.',
    checkAgain: 'The Listing ID changed since the check. Check it again.',
    found: 'What Etsy says',
    moves: moves('listing'),
    movesNote: 'Etsy shows each one\'s own SKU on this listing. A snapshot of each row is kept first.',
    nothingToChange: 'Etsy confirms what Nexus holds. Nothing to change.',
    command: 'Listing ID change',
    link: CHANNEL_ID_COPY.link,
    linking: CHANNEL_ID_COPY.linking,
  },
  SHOPIFY: {
    title: 'Shopify Product ID',
    subtitle: (sku, _market) => `${sku} on ${channelPlace('SHOPIFY')}. The family's product (in a colour store, each colour's) is linked on this row.`,
    field: 'Product ID',
    hint: 'The number at the end of the product\'s Shopify admin address (…/products/<number>). Check asks this business\'s store before anything is written.',
    clearTitle: 'Clear the Product ID',
    clearSentence: (id) => `Nexus forgets Shopify product ${id}. Nothing changes on Shopify; the product stays as it is and Nexus stops updating it.`,
    clearAfter: 'The rows read Not listed until you link a product again. Publishing them as new would create a second Shopify product.',
    noPermission: 'You can see this Product ID. Checking, linking or clearing it needs the "Recover listings" permission.',
    typeFirst: 'Type the Shopify Product ID, then Check.',
    notANumber: 'A Shopify Product ID is a number.',
    checkAgain: 'The Product ID changed since the check. Check it again.',
    found: 'What Shopify says',
    moves: moves('product'),
    movesNote: 'Shopify shows each one\'s own SKU on this product. A snapshot of each row is kept first.',
    nothingToChange: 'Shopify confirms what Nexus holds. Nothing to change.',
    command: 'Product ID change',
    link: CHANNEL_ID_COPY.link,
    linking: CHANNEL_ID_COPY.linking,
  },
  AMAZON: {
    title: 'Amazon ASIN',
    subtitle: (sku, market) => `${sku} on ${channelPlace('AMAZON', market)}. This row's own ASIN on this market.`,
    field: 'ASIN',
    hint: 'Ten letters or digits (B0…). On a row not on Amazon, Check reads Amazon\'s catalog for this market; Set makes it the ASIN this row lists on at Publish.',
    clearTitle: 'Clear the ASIN',
    clearSentence: (id) => `Nexus removes ASIN ${id} from this row: Publish lists it without an ASIN of your choice. Nothing changes on Amazon.`,
    clearAfter: 'The row stays a draft. Nothing is sent to Amazon until you Publish it.',
    noPermission: 'You can see this ASIN. Checking or setting it needs the "Recover listings" permission.',
    typeFirst: 'Type the ASIN, then Check.',
    notANumber: 'An ASIN is 10 letters or digits.',
    checkAgain: 'The ASIN changed since the check. Check it again.',
    found: 'What Amazon says',
    moves: moves('ASIN'),
    movesNote: '',
    nothingToChange: 'This row already lists on this ASIN at Publish. Nothing to change.',
    command: 'ASIN change',
    link: 'Set',
    linking: 'Setting…',
  },
}

export const channelIdWords = (channel: string): ChannelIdWords => CHANNEL_ID_WORDS[String(channel).toUpperCase() as keyof typeof CHANNEL_ID_WORDS] ?? CHANNEL_ID_WORDS.EBAY
/** The channels whose id cell is a control. */
export const isChannelIdChannel = (channel: string) => String(channel).toUpperCase() in CHANNEL_ID_WORDS

/** What the API's Check answers (`ChannelIdCheck`, identity-fix.service.ts). */
export interface ChannelIdCheckAnswer {
  listingId: string
  currentId: string | null
  version: number
  itemId: string
  ok: boolean
  unchanged: boolean
  refusal: string | null
  status: 'ACTIVE' | 'ENDED' | 'INACTIVE' | null
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

/** The listing a control acts on, and the fence: the id and the version this sheet read. */
export interface ChannelIdTarget {
  listingId: string
  /** The row's product id (a main row's: the family root's): the sheet's live rule matches the write's event by it. */
  productId: string
  sku: string
  currentId: string | null
  version: number
  /** Amazon: the shown id is the ASIN the row lists on at Publish (Clear removes it); a live offer's ASIN is Amazon's. */
  suggested?: boolean
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * PURE. The control's target for a row, or null. eBay, Etsy, Shopify: a main row (no parent) with a listing. Amazon: any
 * row with a listing — its id is the ASIN, or the ASIN it lists on at Publish (the cell's `pendingId`).
 */
export function channelIdTarget(row: Pick<ChannelSheetRow, 'id' | 'sku' | 'parentId' | 'listing'> & Partial<Pick<ChannelSheetRow, 'values'>> | null | undefined, channel: string): ChannelIdTarget | null {
  const ch = String(channel).toUpperCase()
  if (!row?.listing || !isChannelIdChannel(ch)) return null
  const held = text(row.listing.externalListingId)
  if (ch === 'AMAZON') {
    const pending = text((row.values?.listing_asin as { pendingId?: { id?: unknown } } | undefined)?.pendingId?.id)
    return { listingId: row.listing.id, productId: row.id, sku: row.sku, currentId: held || pending || null, version: row.listing.version, suggested: !held && !!pending }
  }
  if (row.parentId) return null
  return { listingId: row.listing.id, productId: row.id, sku: row.sku, currentId: held || null, version: row.listing.version }
}

/** PURE. What a person typed, as an id: spaces dropped (eBay shows "1234 5678 9012" on some pages). */
export const typedItemId = (raw: string): string => raw.replace(/\s+/g, '')

/** PURE. A typed id in the channel's form: Shopify's admin `gid://shopify/Product/<n>` → n; an ASIN in capitals. */
export function typedChannelId(raw: string, channel: string): string {
  const id = typedItemId(raw)
  const ch = String(channel).toUpperCase()
  if (ch === 'SHOPIFY') return /^gid:\/\/shopify\/Product\/(\d+)$/.exec(id)?.[1] ?? id
  if (ch === 'AMAZON') return id.toUpperCase()
  return id
}

/** PURE. A first hint before eBay is asked; the API's proof is what decides. */
export const looksLikeItemId = (text: string): boolean => /^\d{9,15}$/.test(text)

/** PURE. A first hint per channel before it is asked (the API's proof decides). */
export function looksLikeChannelId(text: string, channel: string): boolean {
  const ch = String(channel).toUpperCase()
  if (ch === 'ETSY' || ch === 'SHOPIFY') return /^[1-9]\d{0,19}$/.test(text)
  if (ch === 'AMAZON') return /^[A-Z0-9]{10}$/.test(text)
  return looksLikeItemId(text)
}

export type DialogBusy = 'check' | 'link' | 'clear' | null

/** PURE. What the dialog offers now: Check, Link (or Keep; Amazon: Set), Clear — and why the primary waits. */
export function channelIdActions(input: { typed: string; target: ChannelIdTarget; check: ChannelIdCheckAnswer | null; busy: DialogBusy; canEdit: boolean; channel?: string }): {
  check: boolean
  link: { label: string; enabled: boolean } | null
  clear: boolean
  hint: string | null
} {
  const { typed, target, check, busy, canEdit } = input
  const channel = String(input.channel ?? 'EBAY').toUpperCase()
  const words = channelIdWords(channel)
  const idle = busy === null && canEdit
  const fresh = !!check && check.itemId === typed
  const keep = typed !== '' && typed === target.currentId
  const link = fresh && check!.ok && !check!.unchanged ? { label: keep ? CHANNEL_ID_COPY.keep : words.link, enabled: idle } : null
  const hint = !canEdit ? words.noPermission
    : !typed ? words.typeFirst
    : !looksLikeChannelId(typed, channel) ? words.notANumber
    : check && !fresh ? words.checkAgain
    : null
  // Amazon: only the ASIN a row lists on at Publish is cleared here; a live offer's ASIN is Amazon's.
  const clearable = !!target.currentId && (channel !== 'AMAZON' || target.suggested === true)
  return { check: idle && looksLikeChannelId(typed, channel), link, clear: idle && clearable, hint }
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
      const clearable = !!target?.currentId && (String(channel).toUpperCase() !== 'AMAZON' || target.suggested === true)
      if (target) setOpen({ target, intent: intent === 'clear' && clearable ? 'clear' : 'edit' })
    },
  }), [channel, marketplace, canEdit])
  return (
    <ChannelIdControlContext.Provider value={value}>
      {children}
      {open && <ChannelIdDialog key={`${open.target.listingId}:${open.target.version}`} target={open.target} intent={open.intent} channel={channel} marketplace={marketplace}
        canEdit={canEdit} onClose={() => setOpen(null)} />}
    </ChannelIdControlContext.Provider>
  )
}

function ChannelIdDialog({ target, intent, channel, marketplace, canEdit, onClose }: {
  target: ChannelIdTarget; intent: 'edit' | 'clear'; channel: string; marketplace: string; canEdit: boolean; onClose: () => void
}) {
  const words = channelIdWords(channel)
  const amazon = String(channel).toUpperCase() === 'AMAZON'
  const { toast } = useToast()
  const linkKey = useCommandKey()
  const clearKey = useCommandKey()
  const [mode, setMode] = useState<'edit' | 'clear'>(intent)
  const [typed, setTyped] = useState(target.currentId ?? '')
  const [check, setCheck] = useState<ChannelIdCheckAnswer | null>(null)
  const [busy, setBusy] = useState<DialogBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const actions = channelIdActions({ typed, target, check, busy, canEdit, channel })
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
    const answer = readWriteAnswer(sent.response, sent.body, sent.conflict ? commandConflictMessage(sent.conflict, words.command) : null)
    if ('error' in answer) { setError(answer.error); return }
    done(answer)
  })

  const doClear = () => run('clear', async () => {
    const sent = await sendCommand(clearKey, `${base}/api/listings/${encodeURIComponent(target.listingId)}/channel-id/unlink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedExternalId: target.currentId, expectedVersion: target.version }),
    })
    const answer = readWriteAnswer(sent.response, sent.body, sent.conflict ? commandConflictMessage(sent.conflict, words.command) : null)
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
    return <Modal open onClose={closeUnlessBusy} size="sm" title={words.clearTitle} subtitle={words.subtitle(target.sku, marketplace)}
      footer={<>
        <Button variant="secondary" data-autofocus disabled={!!busy} onClick={() => (intent === 'clear' ? onClose() : setMode('edit'))}>{intent === 'clear' ? CHANNEL_ID_COPY.cancel : CHANNEL_ID_COPY.back}</Button>
        <Button variant="danger" disabled={!canEdit || !!busy} onClick={() => { void doClear() }}>{busy === 'clear' ? CHANNEL_ID_COPY.clearing : CHANNEL_ID_COPY.clear}</Button>
      </>}>
      {error && <div className="nds-confirm-block"><Banner tone="danger">{error}</Banner></div>}
      {!canEdit && <div className="nds-confirm-block"><Banner tone="info">{words.noPermission}</Banner></div>}
      <p className="nds-confirm-block nds-confirm-h">{words.clearSentence(target.currentId)}</p>
      <p className="nds-confirm-block">{words.clearAfter}</p>
    </Modal>
  }

  const formId = `channel-id-${target.listingId}`
  return <Modal open onClose={closeUnlessBusy} size="md" title={words.title} subtitle={words.subtitle(target.sku, marketplace)}
    footer={<>
      {actions.clear && <Button variant="danger" disabled={!!busy} onClick={() => { setError(null); setMode('clear') }}>{CHANNEL_ID_COPY.clear}</Button>}
      <Button variant="secondary" disabled={!!busy} onClick={onClose}>{CHANNEL_ID_COPY.cancel}</Button>
      <Button variant={actions.link ? 'secondary' : 'primary'} type={actions.link ? 'button' : 'submit'} form={formId} disabled={!actions.check}
        onClick={actions.link ? () => { void doCheck() } : undefined}>{busy === 'check' ? CHANNEL_ID_COPY.checking : CHANNEL_ID_COPY.check}</Button>
      {actions.link && <Button variant="primary" type="submit" form={formId} disabled={!actions.link.enabled}>{busy === 'link' ? words.linking : actions.link.label}</Button>}
    </>}>
    <form id={formId} onSubmit={submit} aria-busy={!!busy}>
      {error && <div className="nds-confirm-block"><Banner tone="danger">{error}</Banner></div>}
      <div className="nds-confirm-block">
        <Field label={words.field} hint={actions.hint ?? words.hint}>
          <Input value={typed} inputMode={amazon ? 'text' : 'numeric'} autoCapitalize={amazon ? 'characters' : 'off'} autoComplete="off" spellCheck={false} data-autofocus disabled={!canEdit || !!busy}
            onChange={(event) => setTyped(typedChannelId(event.target.value, channel))} />
        </Field>
      </div>
      {check && check.itemId === typed && <ChannelIdFindings check={check} channel={channel} />}
    </form>
  </Modal>
}

/**
 * What the proof found: the refusal (danger), or eBay's confirmation (success); then, before Link, every row Link moves
 * from another item (a warning, in the API's words); then each finding as a plain sentence (the rows left alone among them).
 */
export function ChannelIdFindings({ check, channel = 'EBAY' }: { check: ChannelIdCheckAnswer; channel?: string }) {
  const words = channelIdWords(channel)
  const moved = check.refusal ? [] : check.moved ?? []
  return <>
    <div className="nds-confirm-block">
      {check.refusal ? <Banner tone="danger">{check.refusal}</Banner>
        : check.unchanged ? <Banner tone="success">{words.nothingToChange}</Banner>
        : <Banner tone={check.status === 'ENDED' || check.status === 'INACTIVE' ? 'warning' : 'success'}>{check.pushes}</Banner>}
    </div>
    {moved.length > 0 && <div className="nds-confirm-block">
      <Banner tone="warning" title={words.moves(moved.length)}>
        <ul className="nds-confirm-list">{moved.map((row) => <li key={row.listingId}>{row.sentence}</li>)}</ul>
        {words.movesNote}
      </Banner>
    </div>}
    {check.found.length > 0 && <div className="nds-confirm-block">
      <div className="nds-confirm-h">{words.found}</div>
      <ul className="nds-confirm-list">{check.found.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </div>}
  </>
}
