/**
 * Meta ads step 2, review A1 — what another business in Nexus already uses is answered by its id and a flag ONLY: a
 * Facebook Page, an Instagram account or an ad account that is another business's is never shown with its name,
 * username or details here, in a live view or in what the daily read keeps. `nexus_meta_links_taken`
 * (packages/database/workspaces/meta-links-taken.sql) answers yes or no per id asked, never which business.
 */
import prisma from '../../../db.js'

/** PORTFOLIO (step 10): a Meta business portfolio another business's chosen ad account belongs to. */
export type MetaTakenProduct = 'AD_ACCOUNT' | 'PAGE' | 'INSTAGRAM' | 'PORTFOLIO'

/** Which of these ids another business already picked, for one product. */
export async function takenIds(product: MetaTakenProduct, ids: string[]): Promise<Set<string>> {
  const asked = [...new Set(ids.filter((id) => typeof id === 'string' && id))]
  if (asked.length === 0) return new Set()
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT t.id FROM nexus_meta_links_taken(${product}, ${asked}::text[]) AS t(id)`
  return new Set(rows.map((r) => r.id))
}

const idOf = (row: unknown): string | null => {
  const id = row && typeof row === 'object' ? (row as { id?: unknown }).id : null
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

/** A list of Meta objects (`{ id, … }`) with each one another business uses reduced to `{ id, takenByAnotherBusiness }`. */
export async function maskTakenRows(product: MetaTakenProduct, rows: unknown[]): Promise<unknown[]> {
  const taken = await takenIds(product, rows.map(idOf).filter((id): id is string => !!id))
  return rows.map((row) => {
    const id = idOf(row)
    if (!id) return row
    return taken.has(id) ? { id, takenByAnotherBusiness: true } : { ...(row as Record<string, unknown>), takenByAnotherBusiness: false }
  })
}

/** The account settings the daily read keeps: promoted Pages and Instagram accounts of another business by id only. */
export async function maskTakenAssets(settings: Record<string, unknown>): Promise<void> {
  if (Array.isArray(settings.promotePages)) settings.promotePages = await maskTakenRows('PAGE', settings.promotePages)
  if (Array.isArray(settings.instagramAccounts)) settings.instagramAccounts = await maskTakenRows('INSTAGRAM', settings.instagramAccounts)
}
