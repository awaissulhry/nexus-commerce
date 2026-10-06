/**
 * Delete rows (Owner, 2026-10-06): "I don't have the ability to delete any rows I create by accident, or any products or
 * any rows I actually want to delete for any reason at all … It should be for the whole product information or the whole
 * product sheet instead of just one scope."
 *
 * ONE verb for every view of the sheet (Shared and each channel · market), declared once as a `GridAction` so the
 * selection bar, its confirm and its refusals are the same everywhere. The server decides what a row deletes
 * (`apps/api/src/services/pim/sheet-delete-rows.service.ts`) and checks it again when it writes:
 *   - a Shared row or a Main listing row: the product, to the recycle bin, with its listings on every channel and
 *     market (the family's main row: the whole family);
 *   - an extra listing's main row: that listing only, archived (its products stay in the Main listing);
 *   - a row still on a channel, or an extra listing's colour row alone: refused, in the server's words.
 * Nothing is sent to a channel. Undo puts back exactly what the delete moved.
 *
 * Pure (no React), so the node suite reads it.
 */
import { channelLabel } from '@nexus/shared/channel-label'
import { disabled, AVAILABLE, SELECTION, type ActionImpact, type ActionResult, type GridAction } from '@/design-system/grid/actions/registry'
import { getBackendUrl } from '@/lib/backend-url'

import type { AuthStatus } from '../master/familyActions'

export const PERM_DELETE_ROWS = 'products.delete'

export interface DeleteRowsTarget { productId: string; aliasId: string | null }

export interface DeleteRowsPlan {
  rootId: string
  rootSku: string
  products: Array<{ id: string; sku: string }>
  aliases: Array<{ id: string; label: string; channel: string; marketplace: string }>
  familyDeleted: boolean
  refusals: Array<{ productId: string; aliasId: string | null; sku: string; reason: string }>
}

export interface DeleteRowsExpected { products: string[]; aliases: string[] }

export interface DeleteRowsApi {
  preview(productId: string, rows: DeleteRowsTarget[]): Promise<DeleteRowsPlan>
  run(productId: string, rows: DeleteRowsTarget[], expected: DeleteRowsExpected): Promise<DeleteRowsPlan>
  restore(productId: string, expected: DeleteRowsExpected): Promise<{ restored: { products: number; aliases: number } }>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${getBackendUrl()}${path}`, {
    method: 'POST', credentials: 'include', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const parsed = await res.json().catch(() => null)
  if (!res.ok) throw new Error(parsed?.message || parsed?.error?.message || (typeof parsed?.error === 'string' ? parsed.error : null) || `HTTP ${res.status}`)
  return parsed as T
}

const base = (productId: string) => `/api/products/${encodeURIComponent(productId)}/sheet-rows`

export const deleteRowsApi: DeleteRowsApi = {
  preview: (productId, rows) => post(`${base(productId)}/delete/preview`, { rows }),
  run: (productId, rows, expected) => post(`${base(productId)}/delete/run`, { rows, expected }),
  restore: (productId, expected) => post(`${base(productId)}/restore`, expected),
}

/** What a finished delete hands its host: the plan that ran, and the Undo. */
export interface DeleteRowsDone {
  plan: DeleteRowsPlan
  /** The page's own product went with it: the host leaves for Products. */
  closesPage: boolean
  /** One sentence for the message after the delete. */
  summary: string
  undo: () => Promise<{ ok: boolean; message: string }>
}

export interface DeleteRowsContext<R> {
  /** The product the studio is open on (the server finds its family). */
  productId: string
  /** The product and listing a ticked row stands for. A Shared row has no listing (`aliasId: null`). */
  target: (row: R) => DeleteRowsTarget
  can: (permission: string) => boolean
  authStatus: AuthStatus
  /** After the delete ran: the host repaints, shows the Undo, or leaves the page when the family went. */
  onDeleted: (done: DeleteRowsDone) => void
  api?: DeleteRowsApi
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The ticked rows, one per product and listing (a row can be ticked under two group headers). */
export function deleteTargets<R>(rows: readonly R[], target: (row: R) => DeleteRowsTarget): DeleteRowsTarget[] {
  const seen = new Map<string, DeleteRowsTarget>()
  for (const row of rows) {
    const t = target(row)
    seen.set(`${t.productId}\u0000${t.aliasId ?? ''}`, t)
  }
  return [...seen.values()]
}

/** "1 product and 1 extra listing" — what the delete moves, counted. */
export function deleteSubject(plan: DeleteRowsPlan): string {
  const parts = [
    ...(plan.familyDeleted ? [`the family ${plan.rootSku}`] : plan.products.length ? [plural(plan.products.length, 'product')] : []),
    ...(plan.aliases.length ? [plural(plan.aliases.length, 'extra listing')] : []),
  ]
  return parts.join(' and ')
}

/** The page's own product leaves with the delete (the whole family, or the variation this page is open on). */
export const deleteClosesPage = (plan: DeleteRowsPlan, pageProductId: string) => plan.familyDeleted || plan.products.some((p) => p.id === pageProductId)

/** The confirm, from the server's plan. Pure, so the words are tested. */
export function deleteImpact(plan: DeleteRowsPlan, rows: DeleteRowsTarget[], pageProductId = plan.rootId): ActionImpact {
  const title = 'Delete the ticked rows?'
  const refused = plan.refusals.map((r) => ({ rowId: r.productId, label: `${r.sku}: ${r.reason}`, severity: 'error' as const }))
  if (!plan.products.length && !plan.aliases.length) {
    const reasons = plan.refusals.slice(0, 3).map((r) => r.reason).join(' ')
    const more = plan.refusals.length > 3 ? ` ${plural(plan.refusals.length - 3, 'more row')} cannot be deleted either.` : ''
    return { level: 'none', title, unavailable: `Nothing was deleted. ${reasons}${more}` }
  }
  const children = plan.products.filter((p) => p.id !== plan.rootId)
  const consequences = plan.familyDeleted
    ? [
        `${plan.rootSku}${children.length ? ` and its ${plural(children.length, 'variation')}` : ''}: to the recycle bin, with every listing on every channel and market, extra listings included.`,
      ]
    : plan.products.map((p) => `${p.sku}: to the recycle bin, with its listings on every channel and market.`)
  for (const alias of plan.aliases)
    consequences.push(`${alias.label} (${channelLabel(alias.channel)} · ${alias.marketplace}): this extra listing is removed. Its products stay in the Main listing.`)
  const sideEffects = [
    'Nothing is sent to a channel.',
    'Undo, in the message after the delete, puts everything back.',
    ...(plan.products.length ? ['Later, restore products from Products → Recycle bin.'] : []),
    ...(deleteClosesPage(plan, pageProductId) ? ['This page closes and Products opens.'] : []),
    ...(plan.refusals.length ? [`${plural(plan.refusals.length, 'row')} cannot be deleted and ${plan.refusals.length === 1 ? 'stays' : 'stay'} as ${plan.refusals.length === 1 ? 'it is' : 'they are'} (below).`] : []),
  ]
  return {
    level: plan.familyDeleted ? 'type-to-confirm' : 'confirm',
    title: `Delete ${deleteSubject(plan)}?`,
    consequences,
    sideEffects,
    ...(refused.length ? { findings: refused } : {}),
    // The whole family goes: typed, as Demote with children is (its SKU, never "DELETE").
    ...(plan.familyDeleted ? { confirmPhrase: plan.rootSku } : {}),
    payload: { rows, expected: { products: plan.products.map((p) => p.id), aliases: plan.aliases.map((a) => a.id) } satisfies DeleteRowsExpected },
  }
}

/** The 3-state permission sentence of `familyActions` (an unknown session is never called a denial). */
function needsDelete(status: AuthStatus): ReturnType<typeof disabled> {
  return disabled(
    status === 'loading'
      ? 'Checking whether this session may delete…'
      : status === 'anon'
        ? `Deleting needs the "${PERM_DELETE_ROWS}" permission, and this session is not signed in — so it cannot be checked`
        : `Deleting needs the "${PERM_DELETE_ROWS}" permission, which this account does not have`,
  )
}

export function deleteRowsAction<R>(ctx: DeleteRowsContext<R>): GridAction<R> {
  const api = ctx.api ?? deleteRowsApi
  return {
    id: 'delete-rows',
    label: 'Delete…',
    scope: SELECTION,
    danger: true,
    available: (rows) => {
      if (rows.length === 0) return disabled('Tick the rows to delete')
      if (!ctx.can(PERM_DELETE_ROWS)) return needsDelete(ctx.authStatus)
      return AVAILABLE
    },
    preflight: async (rows) => {
      const targets = deleteTargets(rows, ctx.target)
      let plan: DeleteRowsPlan
      try {
        plan = await api.preview(ctx.productId, targets)
      } catch (err) {
        // A check that could not run never falls back to a gentler confirm.
        return { level: 'none', title: 'Delete the ticked rows?', unavailable: `Could not check what these rows hold: ${err instanceof Error ? err.message : String(err)}` }
      }
      return deleteImpact(plan, targets, ctx.productId)
    },
    run: async (_rows, impact) => {
      const p = (impact?.payload ?? null) as { rows: DeleteRowsTarget[]; expected: DeleteRowsExpected } | null
      if (!p) return { ok: false, message: 'Nothing was checked, so nothing was deleted.' }
      const plan = await api.run(ctx.productId, p.rows, p.expected)
      const summary = `Deleted ${deleteSubject(plan)}.`
      ctx.onDeleted({
        plan,
        closesPage: deleteClosesPage(plan, ctx.productId),
        summary,
        undo: async () => {
          try {
            const { restored } = await api.restore(plan.rootId, p.expected)
            const back = [...(restored.products ? [plural(restored.products, 'product')] : []), ...(restored.aliases ? [plural(restored.aliases, 'extra listing')] : [])]
            return { ok: true, message: back.length ? `Put back ${back.join(' and ')}.` : 'Everything was already back.' }
          } catch (err) {
            return { ok: false, message: `Undo failed: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      })
      return { ok: true, invalidates: { kind: 'page' } } satisfies ActionResult
    },
  }
}
