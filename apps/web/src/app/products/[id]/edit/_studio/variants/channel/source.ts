/**
 * VP.4 — the live `ProjectionSource`: §5.4's three calls, and the ONE parse boundary.
 *
 * `GET   /api/products/:id/studio/projection?channel=&market=&accountId=&aliasKey=`
 * `PATCH /api/products/:id/studio/projection`           { expectedVersion, mapping?, split? }
 * `PATCH /api/products/:id/studio/projection/children`  { expectedVersion, changes: [{ id, included }] }
 *
 * 🔴 Nothing downstream of `parseProjection` may narrow or widen the wire again
 * (reference_wire_parse_boundary_rules): a local mirror that is re-derived at three call sites
 * drifts at one of them first. A response that does not satisfy the contract is a FAILURE with a
 * sentence, never a half-populated page — an empty grid and a missing endpoint look identical to an
 * operator, and only one of them is a fact about the catalogue (PES.3's `backendMissing` rule).
 *
 * A 404/501 renders the shared sheet load error. All reads come from the projection endpoint.
 */
import { getBackendUrl } from '@/lib/backend-url'

import type {
  ProjectionChild, ProjectionDraft, ProjectionPage, ProjectionSaveResult, ProjectionSource,
} from './types'

export interface ProjectionCoordinateInput {
  productId: string
  channel: string
  market: string
  locale?: string
  accountId?: string | null
  aliasKey?: string | null
}

export class ProjectionBackendMissing extends Error {
  readonly backendMissing = true
}

export function projectionUrl(o: ProjectionCoordinateInput): string {
  const params = new URLSearchParams({ channel: o.channel, market: o.market })
  if (o.locale) params.set('locale', o.locale)
  if (o.accountId) params.set('accountId', o.accountId)
  if (o.aliasKey != null) params.set('aliasKey', o.aliasKey)
  return `${getBackendUrl()}/api/products/${encodeURIComponent(o.productId)}/studio/projection?${params}`
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * The boundary. Throws with an operator sentence rather than returning a partial page.
 *
 * It asserts the fields the SURFACE reads, not every field §5.4 names — a parser that demands more
 * than its consumer uses turns an additive server change into an outage. What it will not do is
 * substitute: no default axis noun, no invented limit, no empty `mapping` standing in for a missing
 * one. §4.5 is explicit that the UI never hardcodes a number, and a default here would be exactly
 * that, one layer down where nobody would look for it.
 */
export function parseProjection(body: unknown): ProjectionPage {
  const incomplete = () => new Error('The projection response was incomplete. Reload this page.')
  if (!isObject(body)) throw incomplete()
  const { version, coordinate, vocabulary, limits, mapping, targetOptions, split, locked, children } = body
  if (typeof version !== 'number') throw incomplete()
  if (!isObject(coordinate) || !str(coordinate.channel) || !str(coordinate.market)) throw incomplete()
  if (!isObject(vocabulary) || !str(vocabulary.axisNoun) || !str(vocabulary.axisNounPlural)) throw incomplete()
  /* 🔴 `limits` is TOP-LEVEL in VP.2's final contract, and either number may be `null` — "no limit
     this repository can source", which the band then states by omission rather than by a number.
     `null` is accepted; a STRING or a missing `limits` is not, because that is a shape error and
     defaulting it would put eBay's 5 and 250 on an Etsy coordinate one layer below where anyone
     would look (§4.5: the UI never hardcodes a number). */
  if (!isObject(limits)) throw incomplete()
  if (limits.axes !== null && typeof limits.axes !== 'number') throw incomplete()
  if (limits.variants !== null && typeof limits.variants !== 'number') throw incomplete()
  if (!Array.isArray(mapping) || !Array.isArray(targetOptions) || !Array.isArray(children)) throw incomplete()
  if (typeof (body as { freeform?: unknown }).freeform !== 'boolean') throw incomplete()
  if (!isObject(split) || (split.mode !== 'single' && split.mode !== 'per-axis') || !Array.isArray(split.listings) || typeof split.creatable !== 'boolean') throw incomplete()
  /* VT.2c — `setChangeIs` and `orderChangeAllowed` are VALIDATED, not read as possibly-undefined:
     the dock decides whether a reorder may be saved from `orderChangeAllowed`, and a missing boolean
     would silently become `false` — refusing the one commit eBay allows on a live listing. Producer:
     `variationLockFor` (VT.1b), served on every coordinate with a lock. */
  if (locked !== null && (
    !isObject(locked) || !str(locked.reason) || !Array.isArray(locked.lockedAxisKeys)
    || typeof locked.orderChangeAllowed !== 'boolean'
    || (locked.setChangeIs !== 'relist' && locked.setChangeIs !== 'new-parent' && locked.setChangeIs !== 'in-place')
  )) throw incomplete()
  for (const row of children) {
    const c = row as Partial<ProjectionChild>
    if (!isObject(row) || !str(c.id ?? null) || !str(c.sku ?? null) || typeof c.included !== 'boolean' || !isObject(c.values) || !isObject(c.listing)) throw incomplete()
  }
  const page = body as unknown as ProjectionPage
  const state = (value: string | null) => value?.replace(/_/g, '-') as import('./types').ProjectionListingState
  return { ...page, children: page.children.map(child => ({ ...child, listing: { ...child.listing, state: state(child.listing.state) } })),
    ...(page.parent ? { parent: { ...page.parent, listing: { ...page.parent.listing, state: state(page.parent.listing.state) } } } : {}) }
}

async function readBody(res: Response): Promise<unknown> {
  return res.json().catch(() => null)
}

function reasonOf(body: unknown, fallback: string): string {
  if (isObject(body)) return str(body.message) ?? str(body.error) ?? fallback
  return fallback
}

export function liveSource(coord: ProjectionCoordinateInput): ProjectionSource {
  const url = projectionUrl(coord)
  const base = `${getBackendUrl()}/api/products/${encodeURIComponent(coord.productId)}/studio/projection`
  const body = (extra: Record<string, unknown>) => JSON.stringify({
    channel: coord.channel, market: coord.market,
    ...(coord.accountId ? { accountId: coord.accountId } : {}),
    ...(coord.aliasKey ? { aliasKey: coord.aliasKey } : {}),
    ...extra,
  })

  /**
   * One PATCH, one shape of answer. A 409 carries the CURRENT page so the caller repaints from the
   * server's own state — the sheet's rule, and the reason `current` is in §5.4's 409 body at all.
   * A 409 whose body does not parse is still a conflict: the caller must refetch, not overwrite.
   */
  const patch = async (path: string, payload: Record<string, unknown>, refused: string): Promise<ProjectionSaveResult> => {
    try {
      const res = await fetch(`${base}${path}?${url.split('?')[1]}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: body(payload),
        signal: AbortSignal.timeout(30_000),
      })
      const parsed = await readBody(res)
      // VT.4 — the server's `error` code, relayed so a caller can BRANCH (`axes_locked` opens the dry-run
      // plan, design §3.5) instead of matching on the sentence, which is copy and may be reworded.
      const code = isObject(parsed) ? str(parsed.error) ?? undefined : undefined
      if (res.status === 409) {
        try {
          return { ok: false, conflict: true, current: parseProjection(isObject(parsed) ? parsed.current : null), reason: reasonOf(parsed, refused), ...(code ? { code } : {}) }
        } catch {
          return { ok: false, conflict: false, reason: `${reasonOf(parsed, refused)} Reload this page to see the current mapping.`, ...(code ? { code } : {}) }
        }
      }
      if (!res.ok) return { ok: false, conflict: false, reason: reasonOf(parsed, refused), ...(code ? { code } : {}) }
      const next = isObject(parsed) && typeof parsed.version === 'number' ? parsed.version : null
      /* 🔴 A write's RESPONSE is not what it wrote (reference_claims_must_match_their_measurement).
         Without a version back, the next write has no token to guard with — so this is a failure
         that asks for a reload, not a success we paper over with `expectedVersion + 1`. */
      if (next === null) return { ok: false, conflict: false, reason: 'The server accepted the change but did not return the new version. Reload this page before editing again.' }
      return { ok: true, version: next }
    } catch (e) {
      return { ok: false, conflict: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    async read(signal: AbortSignal) {
      const res = await fetch(url, {
        credentials: 'include', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })
      const parsed = await readBody(res)
      if (res.status === 404 || res.status === 501) throw new ProjectionBackendMissing(reasonOf(parsed, `HTTP ${res.status}`))
      if (!res.ok) throw new Error(reasonOf(parsed, `HTTP ${res.status}`))
      return parseProjection(parsed)
    },
    saveMapping(expectedVersion: number, draft: ProjectionDraft) {
      return patch('', {
        expectedVersion,
        mapping: draft.mapping.filter(entry => entry.target !== null),
        split: draft.split,
        ...(draft.presentationOrder ? { presentationOrder: draft.presentationOrder } : {}),
        /* R-VT-9 — AMAZON only, and only when the dock's theme picker actually moved. `undefined` means
           "this draft never touched a theme" and the key stays OUT of the body: the route reads an explicit
           `null` as "clear the theme", so sending one on every save would wipe an override on a reorder. */
        ...(draft.theme !== undefined ? { theme: draft.theme } : {}),
      }, 'The mapping could not be saved.')
    },
    setIncluded(expectedVersion: number, changes) {
      return patch('/children', { expectedVersion, changes }, 'The change could not be saved.')
    },
  }
}
