import { z } from 'zod'

/**
 * The media plan — one model for every channel's photos (docs/images-studio-rebuild/PLAN.md §4).
 *
 * A family keeps its photos as ordered SETS: Common, one set per value of the picture axis, optional per-SKU sets,
 * one swatch per value and the Amazon safety images. The first photo of a set is its main photo.
 *
 * Sets live on three LAYERS — Shared → Channel → Listing. A layer stores only what it owns: a missing key follows the
 * layer above, a present key (even an empty array) is that layer's own. "Use own photos" copies the inherited set into
 * the layer; "Follow again" deletes the key. Everything here is pure, so the API, the Media page and the Information
 * column resolve and edit a plan with the same code.
 *
 * A value set is keyed `<attribute code>:<option code>` from the variation theme's dictionary (`color:black`), never by
 * display text, so a rename keeps its photos and each market can name the value its own way at publish. A value the
 * dictionary does not know keys as `<attribute code>:text:<folded text>` until it is mapped.
 */

export const MEDIA_PLAN_VERSION = 1 as const
export const MEDIA_LAYERS = ['SHARED', 'CHANNEL', 'LISTING'] as const
export type MediaLayer = typeof MEDIA_LAYERS[number]
/** The most items any set may hold on any layer. Channel limits are checks per destination, not storage limits. */
export const MEDIA_SET_MAX = 250

const codePattern = '[a-z][a-z0-9_]{0,63}'
export const attributeCodeSchema = z.string().regex(new RegExp(`^${codePattern}$`))
export const valueKeySchema = z.string().max(300).regex(new RegExp(`^${codePattern}:(?:${codePattern}|text:\\S{1,200})$`, 'u'))
const idSchema = z.string().min(1).max(256)
export const mediaItemSchema = z.object({ assetId: idSchema }).strict()
const setSchema = z.array(mediaItemSchema).max(MEDIA_SET_MAX)

export const mediaPlanSchema = z.object({
  version: z.literal(MEDIA_PLAN_VERSION),
  /** The picture axis (attribute code). `null` = one shared gallery with no per-value photos. Missing = follow. */
  axis: attributeCodeSchema.nullable().optional(),
  sets: z.object({
    common: setSchema.optional(),
    values: z.record(valueKeySchema, setSchema).optional(),
    skus: z.record(idSchema, setSchema).optional(),
    swatches: z.record(valueKeySchema, mediaItemSchema.nullable()).optional(),
    safety: setSchema.optional(),
  }).strict(),
}).strict()
export type MediaPlan = z.infer<typeof mediaPlanSchema>
export type MediaItem = z.infer<typeof mediaItemSchema>

export const emptyMediaPlan = (): MediaPlan => ({ version: MEDIA_PLAN_VERSION, sets: {} })

/** Where a set is addressed: `common`, `safety`, `value:<valueKey>`, `sku:<productId>`. Swatches have their own op. */
export type MediaSetRef = 'common' | 'safety' | `value:${string}` | `sku:${string}`
export const setRefSchema = z.string().max(320).refine(ref => ref === 'common' || ref === 'safety'
  || (ref.startsWith('value:') && valueKeySchema.safeParse(ref.slice(6)).success)
  || (ref.startsWith('sku:') && idSchema.safeParse(ref.slice(4)).success), 'Unknown photo set.')

export function valueKey(attributeCode: string, optionCodeOrText: string, isOption = true) {
  return isOption ? `${attributeCode}:${optionCodeOrText}` : `${attributeCode}:text:${optionCodeOrText}`
}
export const valueKeyAttribute = (key: string) => key.slice(0, key.indexOf(':'))

/** The stored array of one set on one layer, or `undefined` when the layer follows. */
export function layerSet(plan: MediaPlan | null | undefined, ref: MediaSetRef): MediaItem[] | undefined {
  const sets = plan?.sets
  if (!sets) return undefined
  if (ref === 'common') return sets.common
  if (ref === 'safety') return sets.safety
  if (ref.startsWith('value:')) return sets.values?.[ref.slice(6)]
  return sets.skus?.[ref.slice(4)]
}

function withSet(plan: MediaPlan, ref: MediaSetRef, items: MediaItem[] | undefined): MediaPlan {
  const sets = { ...plan.sets }
  const put = <T,>(record: Record<string, T> | undefined, key: string, value: T | undefined) => {
    const next = { ...(record ?? {}) }
    if (value === undefined) delete next[key]; else next[key] = value
    return Object.keys(next).length ? next : undefined
  }
  if (ref === 'common') { if (items === undefined) delete sets.common; else sets.common = items }
  else if (ref === 'safety') { if (items === undefined) delete sets.safety; else sets.safety = items }
  else if (ref.startsWith('value:')) { const v = put(sets.values, ref.slice(6), items); if (v) sets.values = v; else delete sets.values }
  else { const v = put(sets.skus, ref.slice(4), items); if (v) sets.skus = v; else delete sets.skus }
  return { ...plan, sets }
}

// ── Resolution ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The plans that apply to one destination, top to bottom. `channel` and `listing` are absent on the Shared view. */
export interface MediaPlanStack { shared: MediaPlan | null; channel?: MediaPlan | null; listing?: MediaPlan | null }
export interface ResolvedMediaSet { items: string[]; source: MediaLayer | null }

const STACK_ORDER: Array<[keyof MediaPlanStack, MediaLayer]> = [['listing', 'LISTING'], ['channel', 'CHANNEL'], ['shared', 'SHARED']]

/** One set as a destination sees it: the lowest layer that owns it wins; `source: null` = no layer set it. */
export function resolveSet(stack: MediaPlanStack, ref: MediaSetRef): ResolvedMediaSet {
  for (const [key, layer] of STACK_ORDER) {
    const own = layerSet(stack[key], ref)
    if (own !== undefined) return { items: own.map(i => i.assetId), source: layer }
  }
  return { items: [], source: null }
}

export function resolveAxis(stack: MediaPlanStack, fallback: string | null): { axis: string | null; source: MediaLayer | null } {
  for (const [key, layer] of STACK_ORDER) {
    const axis = stack[key]?.axis
    if (axis !== undefined) return { axis, source: layer }
  }
  return { axis: fallback, source: null }
}

export function resolveSwatch(stack: MediaPlanStack, key: string): { assetId: string | null; source: MediaLayer | null } {
  for (const [name, layer] of STACK_ORDER) {
    const swatches = stack[name]?.sets.swatches
    if (swatches && key in swatches) return { assetId: swatches[key]?.assetId ?? null, source: layer }
  }
  return { assetId: null, source: null }
}

/** Every set key any layer mentions — so a set that only a lower layer owns is still shown. */
export function knownSetRefs(stack: MediaPlanStack): MediaSetRef[] {
  const refs = new Set<MediaSetRef>(['common', 'safety'])
  for (const plan of [stack.shared, stack.channel, stack.listing]) {
    for (const key of Object.keys(plan?.sets.values ?? {})) refs.add(`value:${key}`)
    for (const key of Object.keys(plan?.sets.skus ?? {})) refs.add(`sku:${key}`)
  }
  return [...refs]
}

// ── Editing ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type MediaOp =
  /** Add photos to a set at `index` (default: the end). A photo already in the set is refused, never moved silently. */
  | { op: 'insert'; set: MediaSetRef; assetIds: string[]; index?: number }
  | { op: 'remove'; set: MediaSetRef; assetId: string }
  /** Move within a set or to another set (a move takes it OUT of the source — D8: repeats only on purpose). */
  | { op: 'move'; from: MediaSetRef; to: MediaSetRef; assetId: string; index: number }
  /** Replace a set's whole order (drag-reorder). Must be a permutation of the current set. */
  | { op: 'reorder'; set: MediaSetRef; assetIds: string[] }
  /** Set a set to exactly these photos — Undo's op. `expect` = what the layer must hold now (`null` = it must
   *  follow), so an undo never overwrites someone else's later change. */
  | { op: 'replace'; set: MediaSetRef; assetIds: string[]; expect?: string[] | null }
  /** Copy the inherited set into this layer so it can be edited ("Use own photos"). */
  | { op: 'own'; set: MediaSetRef }
  /** Drop this layer's copy so the set follows the layer above ("Follow again"). `expect` as for `replace`. */
  | { op: 'follow'; set: MediaSetRef; expect?: string[] | null }
  /** `axis: undefined` follows the layer above; `null` = one shared gallery. */
  | { op: 'axis'; axis: string | null | undefined }
  /** `assetId: undefined` follows; `null` = explicitly no swatch. */
  | { op: 'swatch'; value: string; assetId: string | null | undefined }

export const mediaOpSchema: z.ZodType<MediaOp> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('insert'), set: setRefSchema, assetIds: z.array(idSchema).min(1).max(MEDIA_SET_MAX), index: z.number().int().min(0).optional() }).strict(),
  z.object({ op: z.literal('remove'), set: setRefSchema, assetId: idSchema }).strict(),
  z.object({ op: z.literal('move'), from: setRefSchema, to: setRefSchema, assetId: idSchema, index: z.number().int().min(0) }).strict(),
  z.object({ op: z.literal('reorder'), set: setRefSchema, assetIds: z.array(idSchema).max(MEDIA_SET_MAX) }).strict(),
  z.object({ op: z.literal('replace'), set: setRefSchema, assetIds: z.array(idSchema).max(MEDIA_SET_MAX), expect: z.array(idSchema).max(MEDIA_SET_MAX).nullable().optional() }).strict(),
  z.object({ op: z.literal('own'), set: setRefSchema }).strict(),
  z.object({ op: z.literal('follow'), set: setRefSchema, expect: z.array(idSchema).max(MEDIA_SET_MAX).nullable().optional() }).strict(),
  z.object({ op: z.literal('axis'), axis: attributeCodeSchema.nullable().optional() }).strict(),
  z.object({ op: z.literal('swatch'), value: valueKeySchema, assetId: idSchema.nullable().optional() }).strict(),
]) as z.ZodType<MediaOp>

export class MediaPlanEditError extends Error {}

/**
 * Apply ops to ONE layer of a stack. Editing a set the layer does not own yet first copies the inherited set into
 * the layer (the edit is what makes it "own") — the layers above never change. Returns the new layer plan.
 * `sameGroup(a, b)` says two assets are language versions of one photo: they count as one photo in a set.
 */
export function applyMediaOps(stack: MediaPlanStack, layer: MediaLayer, ops: readonly MediaOp[],
  sameGroup: (a: string, b: string) => boolean = (a, b) => a === b): MediaPlan {
  const key: keyof MediaPlanStack = layer === 'SHARED' ? 'shared' : layer === 'CHANNEL' ? 'channel' : 'listing'
  if (layer !== 'SHARED' && stack.shared === undefined) throw new MediaPlanEditError('The shared plan is missing.')
  let plan: MediaPlan = stack[key] ? structuredClone(stack[key]!) : emptyMediaPlan()
  const view = (): MediaPlanStack => ({ ...stack, [key]: plan })
  const current = (ref: MediaSetRef) => resolveSet(view(), ref).items
  const has = (items: string[], id: string) => items.some(existing => sameGroup(existing, id))
  const expectHolds = (ref: MediaSetRef, expect: string[] | null | undefined) => {
    if (expect === undefined) return
    const own = layerSet(plan, ref)?.map(i => i.assetId) ?? null
    if (JSON.stringify(own) !== JSON.stringify(expect)) throw new MediaPlanEditError('These photos changed since your edit, so it cannot be undone. Nothing was changed.')
  }
  const write = (ref: MediaSetRef, ids: string[]) => {
    if (ids.length > MEDIA_SET_MAX) throw new MediaPlanEditError(`A set holds at most ${MEDIA_SET_MAX} photos.`)
    plan = withSet(plan, ref, ids.map(assetId => ({ assetId })))
  }
  for (const op of ops) {
    switch (op.op) {
      case 'insert': {
        const items = current(op.set)
        for (const id of op.assetIds) if (has(items, id)) throw new MediaPlanEditError('This photo is already in that set.')
        if (new Set(op.assetIds).size !== op.assetIds.length) throw new MediaPlanEditError('The same photo was added twice.')
        const at = Math.min(op.index ?? items.length, items.length)
        write(op.set, [...items.slice(0, at), ...op.assetIds, ...items.slice(at)])
        break
      }
      case 'remove': {
        const items = current(op.set)
        if (!items.includes(op.assetId)) throw new MediaPlanEditError('That photo is not in this set any more.')
        write(op.set, items.filter(id => id !== op.assetId))
        break
      }
      case 'move': {
        const source = current(op.from)
        if (!source.includes(op.assetId)) throw new MediaPlanEditError('That photo is not in this set any more.')
        if (op.from === op.to) {
          const rest = source.filter(id => id !== op.assetId)
          const at = Math.min(op.index, rest.length)
          write(op.to, [...rest.slice(0, at), op.assetId, ...rest.slice(at)])
          break
        }
        const target = current(op.to)
        if (has(target, op.assetId)) throw new MediaPlanEditError('This photo is already in that set.')
        const at = Math.min(op.index, target.length)
        write(op.from, source.filter(id => id !== op.assetId))
        write(op.to, [...target.slice(0, at), op.assetId, ...target.slice(at)])
        break
      }
      case 'reorder': {
        const items = current(op.set)
        const same = items.length === op.assetIds.length && [...items].sort().join('\n') === [...op.assetIds].sort().join('\n')
        if (!same) throw new MediaPlanEditError('The set changed while you were reordering it. Try again.')
        write(op.set, op.assetIds)
        break
      }
      case 'replace': {
        expectHolds(op.set, op.expect)
        if (op.assetIds.some((id, i) => op.assetIds.findIndex(other => sameGroup(other, id)) !== i)) throw new MediaPlanEditError('The same photo was added twice.')
        write(op.set, op.assetIds)
        break
      }
      case 'own': write(op.set, current(op.set)); break
      case 'follow':
        // On Shared only a per-SKU set can be dropped: the SKU then shows its value's photos again.
        if (layer === 'SHARED' && !op.set.startsWith('sku:')) throw new MediaPlanEditError('Shared photos have nothing to follow.')
        expectHolds(op.set, op.expect)
        plan = withSet(plan, op.set, undefined)
        break
      case 'axis':
        // On Shared, dropping the choice means the family's own default axis (what a new plan starts with).
        if (op.axis === undefined) {
          const { axis: _drop, ...rest } = plan
          plan = rest
        } else plan = { ...plan, axis: op.axis }
        break
      case 'swatch': {
        const swatches = { ...(plan.sets.swatches ?? {}) }
        if (op.assetId === undefined) delete swatches[op.value]; else swatches[op.value] = op.assetId === null ? null : { assetId: op.assetId }
        const { swatches: _old, ...others } = plan.sets
        plan = { ...plan, sets: Object.keys(swatches).length ? { ...others, swatches } : others }
        break
      }
    }
  }
  return mediaPlanSchema.parse(plan)
}

/**
 * The ops that put one layer back the way it was (Undo), from the layer before and after an edit, set by set: a set
 * the layer did not own follows again, an owned set gets its old photos back. Each set op carries what the layer holds
 * now (`expect`), so an undo is refused when someone changed that set in between. On Shared "not owned" and an empty
 * set look the same, so a set new on Shared is undone to empty — except a per-SKU set, which is dropped again.
 */
export function inverseMediaOps(layer: MediaLayer, before: MediaPlan | null, after: MediaPlan | null): MediaOp[] {
  const was = before ?? emptyMediaPlan(), now = after ?? emptyMediaPlan()
  const ops: MediaOp[] = []
  const refs = new Set<MediaSetRef>(['common', 'safety'])
  for (const plan of [was, now]) {
    for (const key of Object.keys(plan.sets.values ?? {})) refs.add(`value:${key}`)
    for (const key of Object.keys(plan.sets.skus ?? {})) refs.add(`sku:${key}`)
  }
  const ids = (plan: MediaPlan, ref: MediaSetRef) => layerSet(plan, ref)?.map(i => i.assetId)
  for (const ref of refs) {
    const old = ids(was, ref), current = ids(now, ref)
    if (JSON.stringify(old) === JSON.stringify(current)) continue
    const expect = current ?? null
    if (old === undefined && (layer !== 'SHARED' || ref.startsWith('sku:'))) ops.push({ op: 'follow', set: ref, expect })
    else ops.push({ op: 'replace', set: ref, assetIds: old ?? [], expect })
  }
  if (was.axis !== now.axis) ops.push({ op: 'axis', axis: was.axis })
  const swatchOf = (plan: MediaPlan, key: string) => plan.sets.swatches && key in plan.sets.swatches ? plan.sets.swatches[key]?.assetId ?? null : undefined
  for (const key of new Set([...Object.keys(was.sets.swatches ?? {}), ...Object.keys(now.sets.swatches ?? {})])) {
    const old = swatchOf(was, key)
    if (old !== swatchOf(now, key)) ops.push({ op: 'swatch', value: key, assetId: old })
  }
  return ops
}

/**
 * Images W4a — the Owner marked `from` as the same picture as `to`: every set and swatch that uses `from` uses `to`
 * instead, in the same place. Where the set already shows `to` (or a photo `same` counts as `to`: a copy, a language
 * version), `from` is dropped, so a set never repeats a photo. The plan comes back unchanged (the same object) when it
 * does not use `from`.
 */
export function replaceAssetInPlan(plan: MediaPlan, from: string, to: string, same: (a: string, b: string) => boolean = (a, b) => a === b): MediaPlan {
  if (!planAssetIds(plan).includes(from)) return plan
  const swap = (items: MediaItem[]) => !items.some(i => i.assetId === from) ? items
    : items.some(i => i.assetId !== from && same(i.assetId, to)) ? items.filter(i => i.assetId !== from)
    : items.map(i => i.assetId === from ? { ...i, assetId: to } : i)
  const each = (record?: Record<string, MediaItem[]>) => record && Object.fromEntries(Object.entries(record).map(([key, items]) => [key, swap(items)]))
  const sets: MediaPlan['sets'] = { ...plan.sets }
  if (sets.common) sets.common = swap(sets.common)
  if (sets.safety) sets.safety = swap(sets.safety)
  if (sets.values) sets.values = each(sets.values)
  if (sets.skus) sets.skus = each(sets.skus)
  if (sets.swatches) sets.swatches = Object.fromEntries(Object.entries(sets.swatches).map(([key, item]) => [key, item?.assetId === from ? { ...item, assetId: to } : item]))
  return mediaPlanSchema.parse({ ...plan, sets })
}

/** Asset ids the plan points at — to refuse ops that name a photo the family does not own. */
export function planAssetIds(plan: MediaPlan | null | undefined): string[] {
  if (!plan) return []
  const ids = new Set<string>()
  const add = (items?: MediaItem[]) => items?.forEach(i => ids.add(i.assetId))
  add(plan.sets.common); add(plan.sets.safety)
  Object.values(plan.sets.values ?? {}).forEach(add)
  Object.values(plan.sets.skus ?? {}).forEach(add)
  Object.values(plan.sets.swatches ?? {}).forEach(item => item && ids.add(item.assetId))
  return [...ids]
}

/** The layer a row belongs to, as stored: `SHARED`, `CHANNEL:EBAY`, `LISTING:EBAY:IT:<account>:<aliasKey>`. */
export function mediaLayerKey(input: { layer: MediaLayer; channel?: string; marketplace?: string; accountId?: string; aliasKey?: string }) {
  if (input.layer === 'SHARED') return 'SHARED'
  if (input.layer === 'CHANNEL') return `CHANNEL:${input.channel}`
  return `LISTING:${input.channel}:${input.marketplace}:${input.accountId}:${input.aliasKey ?? ''}`
}
