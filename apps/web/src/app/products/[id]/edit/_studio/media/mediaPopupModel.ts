import { layerSet, mediaLayerKey, resolveAxis, resolveSet, type MediaOp, type MediaPlanStack, type MediaSetRef } from '@nexus/shared/media-plan'
import { projectMediaDestination, rowGallery, type MediaCheck } from '@nexus/shared/media-plan-channels'
import type { MediaStripItem } from '@/design-system/components'

import {
  CHANNEL_LABEL, applyLocal, assetMap, assetProblems, cardOf, destinationStack, sameGroupOf, shownVersion, valueLabel, viewStack,
  type LayerView, type LibraryAsset, type MediaDestinationRow, type MediaRead,
} from '../images/plan-page/model'
import type { PlanAddress } from './planCellTransfer'

/**
 * Lane C (docs/product-media-popup/PLAN-2026-09-28.md) — the Product media pop-up of a family on the photo plan, as pure
 * rules: which ONE set a row's cell edits, the draft, the ops Enter sends, the checks shown, the sentences. The pop-up
 * keeps a draft; Enter sends ONE request with `replace` / `follow` ops that carry `expect` (what the layer owned when the
 * pop-up opened), so a change someone else made meanwhile is refused by the server, never overwritten (Owner D1 = a).
 * Everything is computed with the Media page's own model and the publishers' projection, so the pop-up, the cell, the
 * Media page and a publish cannot disagree. Pure: tested without a browser.
 */

export const POPUP_TEXT = {
  noAccount: 'This listing has no account, so its photos cannot be set here.',
  notDestination: 'This listing is not one of the product\'s photo destinations yet (no account, or not listed). Its photos are shown as the sheet has them.',
  readOnly: 'You can view these photos. Changing them needs photo editing permission.',
  skuElsewhere: 'This SKU has its own photos on the Shared sheet. "Only this SKU" is changed there.',
  conflict: 'Someone changed these photos while this pop-up was open. Nothing was changed. Press Esc and open the cell again to see their change.',
  changedElsewhere: 'Someone changed these photos. Enter will not overwrite them — press Esc, then open the cell again.',
  unconfirmed: 'The photo change could not be confirmed. Reload the sheet before trying again.',
  loading: 'Loading the photo plan…',
} as const

/** Which set a row's cell stands for, where the pop-up edits it, and why it may not. */
export interface PlanPopupBase {
  /** The layer the pop-up edits; `null` = it can only show the row's photos. */
  view: LayerView | null
  /** Why nothing can be changed here (besides permission), or null. */
  refusal: string | null
  destination: MediaDestinationRow | null
  rowProductId: string
  variant: { productId: string; sku: string } | null
  /** The variant's set of the picture axis (`value:<key>`), or null (the parent, or no value). */
  valueRef: MediaSetRef | null
  valueLabel: string | null
  /** SKUs that show the value set. */
  valueSkus: number
  skuRef: MediaSetRef | null
  /** The SKU's own set applies to this row now. */
  skuOnly: boolean
  /** The SKU's own set comes from, or also exists on, a layer above the one edited here: "Only this SKU" is changed there
   *  (unticking here would show that layer's SKU photos, not the value's). */
  skuElsewhere: boolean
}

export interface PlanDraft {
  skuOnly: boolean
  /** The photos of the edited set, in order (placed ids). */
  items: string[]
  /** Below Shared: drop this layer's copy so the set follows the layer above again. */
  follow: boolean
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/** The layer view an address edits, as the Media page keys it (`PlanSetDialog` did the same). */
export function planView(read: MediaRead, address: PlanAddress | null): { view: LayerView | null; destination: MediaDestinationRow | null; refusal: string | null } {
  if (!address) return { view: null, destination: null, refusal: POPUP_TEXT.noAccount }
  if (address.layer === 'SHARED') return { view: { layer: 'SHARED' }, destination: null, refusal: null }
  const channel = address.channel
  const key = mediaLayerKey({ layer: 'LISTING', channel, marketplace: channel === 'EBAY' ? address.marketplace : 'GLOBAL', accountId: address.accountId, aliasKey: channel === 'AMAZON' ? '' : address.aliasKey })
  const destination = read.destinations.find(d => d.key === key) ?? null
  if (!destination) return { view: null, destination: null, refusal: POPUP_TEXT.notDestination }
  if (!destination.targetable) return { view: null, destination, refusal: destination.refusal ?? POPUP_TEXT.notDestination }
  return { view: { layer: 'LISTING', destination: key }, destination, refusal: null }
}

export function planBase(read: MediaRead, input: { rowProductId: string; address: PlanAddress | null }): PlanPopupBase {
  const { view, destination, refusal } = planView(read, input.address)
  const stack: MediaPlanStack = view ? viewStack(read, view) : { shared: read.layers.find(l => l.key === 'SHARED')?.plan ?? null }
  const found = read.family.variants.find(v => v.productId === input.rowProductId)
  const variant = found ? { productId: found.productId, sku: found.sku } : null
  const { axis } = resolveAxis(stack, read.family.defaultAxis)
  const valueKey = found && axis ? found.values[axis] : undefined
  const valueRef: MediaSetRef | null = valueKey ? `value:${valueKey}` : null
  const skuRef: MediaSetRef | null = found ? `sku:${found.productId}` : null
  const sku = skuRef ? resolveSet(stack, skuRef) : null
  const skuOnly = !!sku && sku.source !== null
  return {
    view, refusal, destination, rowProductId: input.rowProductId, variant, valueRef,
    valueLabel: valueKey ? valueLabel(read, valueKey) : null,
    valueSkus: valueKey && axis ? read.family.variants.filter(v => v.values[axis] === valueKey).length : 0,
    skuRef, skuOnly,
    skuElsewhere: skuOnly && !!view && (sku!.source !== view.layer
      || (view.layer !== 'SHARED' && resolveSet({ shared: stack.shared, channel: stack.channel }, skuRef!).source !== null)),
  }
}

/** The set the draft edits: the SKU's own set, else the value's set, else Common (the parent, or a variant with no value). */
export function mainRef(base: PlanPopupBase, draft: Pick<PlanDraft, 'skuOnly'>): MediaSetRef {
  if (base.variant && draft.skuOnly && base.skuRef) return base.skuRef
  return base.variant && base.valueRef ? base.valueRef : 'common'
}

function stackFor(read: MediaRead, base: PlanPopupBase): MediaPlanStack {
  return base.view ? viewStack(read, base.view) : { shared: read.layers.find(l => l.key === 'SHARED')?.plan ?? null }
}

/** What the edited layer itself holds for a set (`null` = it follows the layer above). */
export function ownItems(read: MediaRead, base: PlanPopupBase, ref: MediaSetRef): string[] | null {
  if (!base.view) return null
  const key = base.view.layer === 'SHARED' ? 'SHARED' : base.view.layer === 'CHANNEL' ? `CHANNEL:${base.view.channel}` : base.view.destination
  return layerSet(read.layers.find(l => l.key === key)?.plan, ref)?.map(i => i.assetId) ?? null
}

export function initialDraft(read: MediaRead, base: PlanPopupBase): PlanDraft {
  return { skuOnly: base.skuOnly, items: resolveSet(stackFor(read, base), mainRef(base, { skuOnly: base.skuOnly })).items, follow: false }
}

/** Where the edited set's photos come from now, for the head line (below Shared only). */
export function setSource(read: MediaRead, base: PlanPopupBase, draft: PlanDraft): 'own' | 'shared' | 'channel' | null {
  if (!base.view || base.view.layer === 'SHARED') return null
  if (draft.follow) return inheritedSource(read, base, mainRef(base, draft))
  const ref = mainRef(base, draft)
  if (ownItems(read, base, ref) !== null) return 'own'
  // An edit here makes the set this layer's own; until then it follows.
  return same(draft.items, resolveSet(stackFor(read, base), ref).items) ? inheritedSource(read, base, ref) : 'own'
}

function inheritedSource(read: MediaRead, base: PlanPopupBase, ref: MediaSetRef): 'shared' | 'channel' {
  const stack = stackFor(read, base)
  return resolveSet({ shared: stack.shared, channel: stack.channel }, ref).source === 'CHANNEL' ? 'channel' : 'shared'
}

/** The photos the set would show if this layer followed again. */
export function inheritedItems(read: MediaRead, base: PlanPopupBase, ref: MediaSetRef): string[] {
  const stack = stackFor(read, base)
  return resolveSet({ shared: stack.shared, channel: stack.channel }, ref).items
}

// ── Draft edits ─────────────────────────────────────────────────────────────────────────────────────────────────

export function moveItem(draft: PlanDraft, id: string, index: number): PlanDraft {
  const rest = draft.items.filter(x => x !== id)
  if (rest.length === draft.items.length) return draft
  const at = Math.max(0, Math.min(index, rest.length))
  return { ...draft, follow: false, items: [...rest.slice(0, at), id, ...rest.slice(at)] }
}
export function removeItem(draft: PlanDraft, id: string): PlanDraft {
  return draft.items.includes(id) ? { ...draft, follow: false, items: draft.items.filter(x => x !== id) } : draft
}
/** Adds at the end; a photo the set already shows (another copy or language version of it) is not added twice. */
export function addItem(read: MediaRead, draft: PlanDraft, id: string): PlanDraft {
  const sameGroup = sameGroupOf(read)
  return draft.items.some(x => sameGroup(x, id)) ? draft : { ...draft, follow: false, items: [...draft.items, id] }
}
/** Removes whichever placed copy of the picture the set holds (a library card may stand for several stored copies). */
export function removePicture(read: MediaRead, draft: PlanDraft, id: string): PlanDraft {
  const sameGroup = sameGroupOf(read)
  const hit = draft.items.find(x => sameGroup(x, id))
  return hit ? removeItem(draft, hit) : draft
}
export function inSet(read: MediaRead, draft: PlanDraft, id: string) {
  const sameGroup = sameGroupOf(read)
  return draft.items.some(x => sameGroup(x, id))
}
/** "Only this SKU": ticked starts from the photos shown now; unticked shows the value's photos again. */
export function setSkuOnly(read: MediaRead, base: PlanPopupBase, draft: PlanDraft, on: boolean): PlanDraft {
  if (!base.variant || !base.skuRef || on === draft.skuOnly) return draft
  if (on) return { skuOnly: true, items: [...draft.items], follow: false }
  const valueItems = resolveSet(stackFor(read, base), base.valueRef ?? 'common').items
  return { skuOnly: false, items: valueItems, follow: false }
}
/** "Follow … again": the set shows the layer above; Enter drops this layer's copy. */
export function followAgain(read: MediaRead, base: PlanPopupBase, draft: PlanDraft): PlanDraft {
  return { ...draft, follow: true, items: inheritedItems(read, base, mainRef(base, draft)) }
}

// ── Enter ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The ops Enter sends (none = nothing changed, no request). Every op carries `expect`. */
export function saveOps(read: MediaRead, base: PlanPopupBase, draft: PlanDraft): MediaOp[] {
  if (!base.view) return []
  const stack = stackFor(read, base)
  const ops: MediaOp[] = []
  if (base.variant && base.skuRef && draft.skuOnly !== base.skuOnly) {
    if (draft.skuOnly) return [{ op: 'replace', set: base.skuRef, assetIds: draft.items, expect: ownItems(read, base, base.skuRef) }]
    ops.push({ op: 'follow', set: base.skuRef, expect: ownItems(read, base, base.skuRef) })
    // Unticked AND the value's set changed in the same pop-up (its photos, or "Follow … again"): both in the one request.
    const ref = base.valueRef ?? 'common'
    const own = ownItems(read, base, ref)
    if (draft.follow) { if (own !== null) ops.push({ op: 'follow', set: ref, expect: own }) }
    else if (!same(draft.items, resolveSet(stack, ref).items)) ops.push({ op: 'replace', set: ref, assetIds: draft.items, expect: own })
    return ops
  }
  const ref = mainRef(base, draft)
  const own = ownItems(read, base, ref)
  if (draft.follow) return own !== null ? [{ op: 'follow', set: ref, expect: own }] : []
  if (same(draft.items, resolveSet(stack, ref).items)) return []
  return [{ op: 'replace', set: ref, assetIds: draft.items, expect: own }]
}

/** The same refusal the server would give, before any request (`applyMediaOps` with the same "one photo" rule). */
export function localRefusal(read: MediaRead, base: PlanPopupBase, ops: readonly MediaOp[]): string | null {
  if (!base.view || !ops.length) return null
  try { applyLocal(read, base.view, ops); return null } catch (error) { return error instanceof Error ? error.message : String(error) }
}

/** The read as it will be once the ops land (for the checks and the cells shown at once). */
export function afterSave(read: MediaRead, base: PlanPopupBase, ops: readonly MediaOp[]): MediaRead {
  if (!base.view || !ops.length) return read
  try { return applyLocal(read, base.view, ops) } catch { return read }
}

/** The sets this row's save is about: the SKU's own set and the value's (or Common's). */
function rowRefs(base: PlanPopupBase): MediaSetRef[] {
  return base.variant ? [...(base.skuRef ? [base.skuRef] : []), base.valueRef ?? 'common'] : ['common']
}

/**
 * Did the photos this row shows change since the pop-up opened — on this layer OR on a layer it follows? A save on top
 * of a set this layer does not own yet binds only to "owned nothing" (`expect: null`), which a change to the inherited set
 * does not break; so the pop-up compares what the row RESOLVES to, and refuses before sending (the server cannot).
 */
export function changedSince(baseline: MediaRead, fresh: MediaRead | null, base: PlanPopupBase): boolean {
  if (!fresh) return false
  const before = stackFor(baseline, base), after = stackFor(fresh, base)
  return rowRefs(base).some(ref => {
    const a = resolveSet(before, ref), b = resolveSet(after, ref)
    return a.source !== b.source || !same(a.items, b.items)
  })
}

/** The answer was lost, but the photos are exactly what the save would have made: it landed. (`saveOps` never sends an
 *  op that changes nothing, so "what it makes" always differs from what was there.) */
export function landedAnyway(baseline: MediaRead, fresh: MediaRead | null, base: PlanPopupBase, ops: readonly MediaOp[]): boolean {
  if (!fresh || !base.view || !ops.length) return false
  let expected: MediaRead
  try { expected = applyLocal(baseline, base.view, ops) } catch { return false }
  const refs = ops.flatMap(op => ('set' in op ? [op.set] : []))
  return refs.every(ref => JSON.stringify(ownItems(fresh, base, ref)) === JSON.stringify(ownItems(expected, base, ref)))
}

/**
 * A refused save: when a set the ops were bound to (`expect`) now holds something else, someone changed it meanwhile —
 * say so plainly (the server's own sentence was written for Undo). Otherwise the server's sentence stands.
 */
export function refusalSentence(fresh: MediaRead | null, base: PlanPopupBase, ops: readonly MediaOp[], serverMessage: string): string {
  if (!fresh) return serverMessage
  for (const op of ops) {
    if ((op.op !== 'replace' && op.op !== 'follow') || op.expect === undefined) continue
    if (JSON.stringify(ownItems(fresh, base, op.set)) !== JSON.stringify(op.expect)) return POPUP_TEXT.conflict
  }
  return serverMessage
}

// ── What the pop-up shows ───────────────────────────────────────────────────────────────────────────────────────

export interface PopupTile {
  id: string; src: string | null; label: string; mediaType: string
  language: string | null; exact: boolean; problem: string | null; missing: boolean; alsoInCommon: boolean
}

/** One tile per placed photo: the version the sheet's language shows, its problems, and whether Common has it too. */
export function tiles(read: MediaRead, base: PlanPopupBase, draft: PlanDraft, language: string | null): PopupTile[] {
  const assets = assetMap(read)
  const card = cardOf(read)
  const library = new Map(read.library.map(a => [a.id, a]))
  const common = mainRef(base, draft) === 'common' ? [] : resolveSet(stackFor(read, base), 'common').items
  const sameGroup = sameGroupOf(read)
  return draft.items.map(id => {
    const shown = shownVersion(read, assets, id, language ? [language] : null)
    const asset = library.get(card(shown.id))
    return {
      id, src: asset && asset.mediaType !== 'VIDEO' ? asset.url : null, label: asset?.label ?? 'Deleted photo', mediaType: asset?.mediaType ?? 'IMAGE',
      language: shown.language !== 'zxx' ? shown.language : null, exact: shown.exact,
      problem: asset ? assetProblems(asset)[0] ?? null : 'Deleted from the library', missing: !asset,
      alsoInCommon: common.some(c => sameGroup(c, id)),
    }
  })
}

/** The photos a variant shows after its set: Common, minus what the set already shows (muted in the cell too). */
export function commonAfter(read: MediaRead, base: PlanPopupBase, draft: PlanDraft): string[] {
  if (!base.variant || mainRef(base, draft) === 'common') return []
  const sameGroup = sameGroupOf(read)
  return resolveSet(stackFor(read, base), 'common').items.filter(id => !draft.items.some(x => sameGroup(x, id)))
}

/** The head of the set: "Common · every variant", "Nero · used by 10 SKUs", "<SKU> only". */
export function setTitle(base: PlanPopupBase, draft: PlanDraft): { label: string; detail: string } {
  const ref = mainRef(base, draft)
  const count = `${draft.items.length} photo${draft.items.length === 1 ? '' : 's'}`
  if (ref === 'common') return { label: 'Common', detail: base.variant ? `${count} · this SKU has no value of the photo axis` : `${count} · every variant` }
  if (ref.startsWith('sku:')) return { label: `${base.variant?.sku ?? 'This SKU'} only`, detail: count }
  return { label: base.valueLabel ?? 'This value', detail: `${count} · used by ${base.valueSkus} SKU${base.valueSkus === 1 ? '' : 's'}` }
}

/** Where Enter saves, in one line. */
export function saveLine(base: PlanPopupBase, draft: Pick<PlanDraft, 'skuOnly'>): string {
  if (base.destination) return `Saves in Nexus · Publish sends it to ${CHANNEL_LABEL[base.destination.channel]}`
  if (base.variant && draft.skuOnly) return 'Saves in Nexus · only this SKU changes'
  if (base.variant && base.valueRef) return 'Saves in Nexus · every SKU of this value changes together'
  return 'Saves in Nexus · every channel follows it unless a listing has its own'
}

export interface PopupCheck { severity: 'error' | 'warning'; message: string }

/**
 * The problems this set would have. On a channel sheet: that destination's own checks from the publishers' projection,
 * limited to this set and its photos. On the Shared sheet: each photo's own problems (size, address, deleted).
 */
export function checks(read: MediaRead, base: PlanPopupBase, draft: PlanDraft): PopupCheck[] {
  const ref = mainRef(base, draft)
  const ops = saveOps(read, base, draft)
  const next = afterSave(read, base, ops)
  const card = cardOf(next)
  const mine = new Set(draft.items.map(card))
  const out: PopupCheck[] = []
  const add = (check: PopupCheck) => { if (!out.some(c => c.message === check.message)) out.push(check) }
  if (base.destination && base.view) {
    const d = next.destinations.find(x => x.key === base.destination!.key)
    if (d) {
      const layout = projectMediaDestination({ stack: destinationStack(next, d), family: next.family, axes: next.family.axes, assets: assetMap(next), target: d, mainLanguage: next.mainLanguage })
      const related = (c: MediaCheck) => c.set === ref || (!!c.assetId && mine.has(card(c.assetId))) || (c.code === 'sku-photos-unused' && ref.startsWith('sku:'))
      for (const c of layout.checks.filter(related)) add({ severity: c.severity, message: c.message })
    }
    return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  }
  const library = new Map(next.library.map(a => [a.id, a]))
  for (const id of draft.items) {
    const asset = library.get(card(id))
    if (!asset) { add({ severity: 'error', message: 'A photo in this set was deleted from the library. Remove it or add it again.' }); continue }
    for (const problem of assetProblems(asset)) add({ severity: problem === 'Size unknown' ? 'warning' : 'error', message: `${asset.label}: ${problemWords(problem)}` })
  }
  return out
}

function problemWords(problem: string) {
  if (problem === 'Not HTTPS') return 'not on a public HTTPS address — no channel accepts it.'
  if (problem === 'Size unknown') return 'size unknown — it cannot be checked.'
  if (/^\d+ px$/.test(problem)) return `${problem} — eBay and Amazon need 500 px on the longest side.`
  return problem
}

// ── The library ("+ Add") ───────────────────────────────────────────────────────────────────────────────────────

export type LibraryShow = 'not-in-set' | 'all'

/** The family's photos, each picture once, filtered by the search words; "not in this set" hides what the set shows. */
export function libraryCards(read: MediaRead, draft: PlanDraft, show: LibraryShow, search: string): LibraryAsset[] {
  const text = search.trim().toLowerCase()
  return read.library.filter(a => {
    if (text && !`${a.label} ${a.alt ?? ''} ${a.languageTag}`.toLowerCase().includes(text)) return false
    return show === 'all' || !inSet(read, draft, a.id)
  })
}

// ── The cells, at once ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * What each row's cell shows once the ops land — the server's own resolver (`rowGallery`) on the same layers, so the
 * cells change at once (every size of a colour together) and the sheet's re-read then confirms them.
 */
export function cellAfterSave(next: MediaRead, base: PlanPopupBase, productId: string, locale: string): { set: { ref: string; label: string; sharedBy: number }; items: MediaStripItem[] } {
  const stack = stackFor(next, base)
  // The sheet's own call: its locale as the only language and as the main one (`sheetMediaPlan().row`).
  const gallery = rowGallery({ stack, family: next.family, productId, assets: assetMap(next), languages: [locale], mainLanguage: locale })
  const card = cardOf(next)
  const library = new Map(next.library.map(a => [a.id, a]))
  return {
    set: { ref: gallery.set, label: gallery.label, sharedBy: gallery.sharedBy },
    items: gallery.items.map(item => {
      const asset = library.get(card(item.assetId))
      return { id: item.placedId, type: asset?.mediaType ?? 'FILE', preview: asset && asset.mediaType === 'IMAGE' ? asset.url : null,
        alt: asset?.alt?.trim() || asset?.label || '', ...(item.from === 'common' ? { muted: true } : {}) }
    }),
  }
}
