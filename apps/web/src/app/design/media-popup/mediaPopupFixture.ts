import { applyMediaOps, MediaPlanEditError, mediaOpSchema, resolveSet, type MediaOp, type MediaPlan, type MediaPlanStack, type MediaSetRef } from '@nexus/shared/media-plan'
import type { LibraryAsset, MediaDestinationRow, MediaRead, PlanLayer } from '../../products/[id]/edit/_studio/images/plan-page/model'

/**
 * /design/media-popup — a made-up family on the photo plan, answered in the page (Lane C, the Product media pop-up).
 *
 * "Lab jacket": two colours × three sizes, drawn photos, one 420 px photo, one eBay listing. The stand-in answers the
 * pop-up's reads and writes for the LAB PRODUCT only (`GET /media`, `POST /media/ops`, `POST /images`) with the shared
 * plan code the server runs (`applyMediaOps`), so a refusal here is the server's refusal. Every other request goes to
 * the real API untouched. Every name, id and picture here is invented.
 */

export const LAB_PRODUCT = 'lab-jacket'
export const LAB_PHOTO_HOST = 'lab-photos.nexus.invalid'
const photo = (name: string, hue: number, extra: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id: `lab-${name}`, productId: LAB_PRODUCT, url: `https://${LAB_PHOTO_HOST}/${name}.svg?hue=${hue}`, alt: null, mediaType: 'IMAGE',
  width: 1600, height: 1600, mimeType: 'image/svg+xml', fileSize: 180_000, languageTag: 'zxx', versionGroupId: null, label: name, ...extra,
})

const SIZES = ['S', 'M', 'L'] as const
const COLOURS = [{ key: 'color:nero', label: 'Nero', code: 'black' }, { key: 'color:grigio', label: 'Grigio', code: 'grey' }] as const
export const LAB_VARIANTS = COLOURS.flatMap(c => SIZES.map(size => ({ productId: `lab-${c.code}-${size.toLowerCase()}`, sku: `LAB-JACKET-${c.code.toUpperCase()}-${size}`, values: { color: c.key }, included: true })))
const EBAY_KEY = 'LISTING:EBAY:IT:lab-account:'
export const LAB_EBAY = { layer: 'LISTING' as const, channel: 'EBAY', marketplace: 'IT', accountId: 'lab-account', aliasKey: '' }

const START_LIBRARY: LibraryAsset[] = [
  photo('front', 210), photo('back', 200), photo('detail', 30), photo('size-chart', 120),
  photo('black-front', 0), photo('black-side', 10), photo('grey-front', 260), photo('grey-side', 280),
  photo('small-label', 50, { width: 420, height: 300 }),
]
const START_SHARED: MediaPlan = { version: 1, axis: 'color', sets: {
  common: [{ assetId: 'lab-front' }, { assetId: 'lab-back' }, { assetId: 'lab-size-chart' }],
  values: { 'color:nero': [{ assetId: 'lab-black-front' }, { assetId: 'lab-black-side' }], 'color:grigio': [{ assetId: 'lab-grey-front' }] },
} }

export interface LabSwitches { refuseNext: boolean; someoneElse: boolean; slow: boolean; nearDuplicate: boolean }
export const labSwitches: LabSwitches = { refuseNext: false, someoneElse: false, slow: false, nearDuplicate: false }

let library = [...START_LIBRARY]
let layers: Array<{ key: string; plan: MediaPlan; revision: number }> = [{ key: 'SHARED', plan: START_SHARED, revision: 1 }]
let uploads = 0
const listeners = new Set<() => void>()
export function onLabChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
const changed = () => listeners.forEach(fn => fn())

export function resetLab() { library = [...START_LIBRARY]; layers = [{ key: 'SHARED', plan: START_SHARED, revision: 1 }]; uploads = 0; changed() }

export function labRead(): MediaRead {
  const destinations: MediaDestinationRow[] = [{ key: EBAY_KEY, channel: 'EBAY', marketplace: 'IT', markets: ['IT'], accountId: 'lab-account', accountLabel: 'Lab eBay',
    accountActive: true, alias: null, languages: ['it'], listed: LAB_VARIANTS.length, productIds: LAB_VARIANTS.map(v => v.productId), targetable: true, refusal: null, api: 'TRADING' }]
  return {
    productId: LAB_PRODUCT, rootId: LAB_PRODUCT, sku: 'LAB-JACKET', name: 'Lab jacket', mainLanguage: 'it',
    family: { productId: LAB_PRODUCT, variants: LAB_VARIANTS, defaultAxis: 'color', valueOrder: { color: COLOURS.map(c => c.key) },
      valueLabels: Object.fromEntries(COLOURS.map(c => [c.key, c.label])), axes: [{ code: 'color', label: 'Colore', dictionary: true, values: COLOURS.map(c => ({ key: c.key, label: c.label })) }], unmapped: [] },
    library,
    layers: layers.map((l): PlanLayer => {
      const [layer, channel = '', marketplace = '', accountId = '', aliasKey = ''] = l.key.split(':')
      return { key: l.key, layer: layer as PlanLayer['layer'], channel, marketplace, accountId, aliasKey, plan: l.plan, revision: l.revision }
    }),
    destinations,
  }
}

function applyOps(key: string, ops: MediaOp[]) {
  const find = (k: string) => layers.find(l => l.key === k)?.plan ?? null
  const layer = key === 'SHARED' ? 'SHARED' : 'LISTING'
  const stack: MediaPlanStack = { shared: find('SHARED'), channel: null, listing: layer === 'LISTING' ? find(key) : null }
  const sameGroup = (a: string, b: string) => a === b
  const next = applyMediaOps(stack, layer, ops, sameGroup)
  const empty = layer !== 'SHARED' && !Object.keys(next.sets).length && next.axis === undefined
  const old = layers.find(l => l.key === key)
  layers = [...layers.filter(l => l.key !== key), ...(empty ? [] : [{ key, plan: next, revision: (old?.revision ?? 0) + 1 }])]
  changed()
  return { plan: empty ? null : next, revision: (old?.revision ?? 0) + 1 }
}

/** "Someone else" changes the set the save is about (reverses its order) just before the save lands, as a second screen would. */
function someoneElseChanges(key: string, set: MediaSetRef) {
  const read = labRead()
  const stack: MediaPlanStack = { shared: read.layers.find(l => l.key === 'SHARED')?.plan ?? null, channel: null, listing: read.layers.find(l => l.key === key && key !== 'SHARED')?.plan ?? null }
  const items = resolveSet(stack, set).items
  if (items.length < 2) return
  applyOps(key, [{ op: 'replace', set, assetIds: [...items].reverse() }])
}

let installed = false
export function installLabMedia() {
  if (typeof window === 'undefined' || installed) return
  installed = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
    if (!url.pathname.startsWith(`/api/products/${LAB_PRODUCT}`) && !LAB_VARIANTS.some(v => url.pathname.startsWith(`/api/products/${v.productId}/`))) return real(input, init)
    await new Promise(resolve => setTimeout(resolve, labSwitches.slow ? 1000 : 120))
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.pathname.endsWith('/media')) return json(labRead())
    if (method === 'POST' && url.pathname.endsWith('/media/ops')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { address?: { layer?: string; channel?: string; marketplace?: string; accountId?: string; aliasKey?: string }; ops?: unknown[] }
      const key = body.address?.layer === 'SHARED' ? 'SHARED' : `LISTING:${body.address?.channel}:${body.address?.marketplace}:${body.address?.accountId}:${body.address?.aliasKey ?? ''}`
      if (key !== 'SHARED' && key !== EBAY_KEY) return json({ error: 'This listing is not one of the product\'s photo destinations yet. Reload the Media page.' }, 409)
      if (labSwitches.refuseNext) { labSwitches.refuseNext = false; changed(); return json({ error: 'Someone else changed these photos at the same moment. Reload the page and try again.' }, 409) }
      try {
        const ops = (body.ops ?? []).map(op => mediaOpSchema.parse(op))
        const first = ops.find((op): op is Extract<MediaOp, { set: MediaSetRef }> => 'set' in op)
        if (labSwitches.someoneElse && first) { labSwitches.someoneElse = false; someoneElseChanges(key, first.set) }
        return json({ rootId: LAB_PRODUCT, key, ...applyOps(key, ops), undo: [] })
      } catch (error) {
        return json({ error: error instanceof MediaPlanEditError ? error.message : 'The media data is invalid.' }, error instanceof MediaPlanEditError ? 409 : 422)
      }
    }
    if (method === 'POST' && url.pathname.endsWith('/images')) {
      if (labSwitches.nearDuplicate) { labSwitches.nearDuplicate = false; changed(); return json({ error: 'NEAR_DUPLICATE', candidate: { id: 'lab-front', url: library[0].url, alt: 'front' } }, 409) }
      uploads += 1
      const added = photo(`upload-${uploads}`, 160 + uploads * 40)
      library = [...library, added]
      changed()
      return json({ id: added.id }, 201)
    }
    return json({ error: 'Not available in the lab' }, 404)
  }
}

/** The lab's drawn photos: a service worker answers `https://lab-photos.nexus.invalid/…` in this page only. */
export async function installLabPhotos(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false
  try {
    const registration = await navigator.serviceWorker.register('/design/media-popup/photo-worker', { scope: '/design/media-popup' })
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => { navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }); registration.active?.postMessage('claim') })
    return true
  } catch { return false }
}
