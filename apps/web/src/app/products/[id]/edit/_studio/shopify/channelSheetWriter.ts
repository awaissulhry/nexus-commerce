import { getBackendUrl } from '@/lib/backend-url'
import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'
import type { ChannelSheetRow } from '../sheet/channel/types'
import type { ShopifySheetWrite } from '@nexus/shared/shopify-information'

/** One row's batch, through the common SheetWriter. A response confirms only a Nexus draft. */
export async function commitShopifySheetRow(req: SheetWriteRequest<ChannelSheetRow>, coord: { accountId?: string; locale?: string }): Promise<SheetWriteResult> {
  const row = req.row
  if (!row?.shopify || !coord.accountId) return { ok: false, reason: 'The Shopify listing identity is unavailable. Reload the sheet.' }
  const cells = req.cells.map(cell => ({ ...row.values[cell.colId]?.shopifyWrite, colId: cell.colId, intent: cell.intent, contentAddress: row.values[cell.colId]?.contentAddress,
    value: cell.value == null ? null : typeof cell.value === 'object' ? JSON.stringify(cell.value) : String(cell.value) }))
  if (cells.some(cell => !cell.token)) return { ok: false, reason: 'The cell has no Shopify draft write address. Reload before editing.' }
  try {
    const query = new URLSearchParams({ accountId: coord.accountId, listingId: row.shopify.listingId, market: 'GLOBAL', ...(coord.locale ? { locale: coord.locale } : {}) })
    const response = await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(row.shopify.productId)}/shopify-linked/cells?${query}`, {
      method: 'POST', credentials: 'include', signal: AbortSignal.timeout(120_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cells }),
    })
    const body = await response.json().catch(() => null)
    if (response.status >= 500 || response.ok && (!body || typeof body.ok !== 'boolean' || !body.cells)) return { ok: false, unreachable: true, reason: 'The draft save could not be confirmed. Checking the saved values.' }
    if (!response.ok) return { ok: false, conflict: response.status === 409, reason: body?.error ?? `The draft save was refused (${response.status}).` }
    if (cells.some(cell => {
      const result = body.cells[cell.colId]
      return typeof result?.ok !== 'boolean' || result.ok && (!result.shopifyWrite?.token || result.shopifyWrite.ownerId !== cell.ownerId || result.shopifyWrite.fieldId !== cell.fieldId)
    })) return { ok: false, unreachable: true, reason: 'The response did not confirm every requested cell identity. Checking the saved draft.' }
    if (body.listing?.id === row.listing?.id && Number.isSafeInteger(body.listing?.version)) row.listing!.version = body.listing.version
    for (const [colId, outcome] of Object.entries(body.cells) as Array<[string, { ok: boolean; shopifyWrite?: ShopifySheetWrite }]>) {
      if (!outcome.ok || !outcome.shopifyWrite) continue
      // Inventory's two physical columns share one structured owner value and draft token.
      for (const cell of Object.values(row.values)) if (cell.shopifyWrite?.ownerId === outcome.shopifyWrite.ownerId && cell.shopifyWrite.fieldId === outcome.shopifyWrite.fieldId) cell.shopifyWrite = outcome.shopifyWrite
      if (row.values[colId]) row.values[colId].shopifyWrite = outcome.shopifyWrite
    }
    return body as SheetWriteResult
  } catch { return { ok: false, unreachable: true, reason: 'The response was interrupted. Checking whether the Nexus draft was saved.' } }
}
