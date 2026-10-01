import type { ProductTransferOptions, ProductTransferSelection, SheetImportChangesPage, SheetImportStatus } from '@nexus/shared/catalog-transfer'
import { getBackendUrl } from '@/lib/backend-url'
import { downloadResponse } from '@/design-system/lib'

/** PSIE — the product sheet's Export and Import (`apps/api/src/routes/sheet-transfer.routes.ts`). */
const base = () => `${getBackendUrl()}/api/catalog-transfer`

/** `fetch` rejects with a bare TypeError when no answer came back; say what that means for the user. */
function noAnswer(error: unknown): never {
  if (error instanceof TypeError) throw new Error('The server did not answer. Nothing was changed. Check that you are still signed in, then try again.')
  throw error
}
async function json<T>(request: Promise<Response>): Promise<T> {
  const response = await request.catch(noAnswer)
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok) throw new Error(data?.error ?? `The request failed (${response.status}).`)
  if (!data) throw new Error('The server sent an empty answer. Try again.')
  return data
}
const post = (path: string, body?: unknown, signal?: AbortSignal) => fetch(`${base()}${path}`, { method: 'POST', credentials: 'include', cache: 'no-store', signal,
  ...(body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }) })
const get = (path: string, signal?: AbortSignal) => fetch(`${base()}${path}`, { credentials: 'include', cache: 'no-store', signal })

export interface ExportNotes { total: number; notes: string[] }
/** Reads the export's notes header; an unreadable or absent header is "no notes", never an error. */
export function exportNotesOf(header: string | null): ExportNotes {
  if (!header) return { total: 0, notes: [] }
  try {
    const value = JSON.parse(decodeURIComponent(header)) as Partial<ExportNotes>
    return { total: Number(value.total) || 0, notes: Array.isArray(value.notes) ? value.notes.filter((n): n is string => typeof n === 'string') : [] }
  } catch { return { total: 0, notes: [] } }
}

export const sheetTransferApi = {
  options: (productId: string, signal?: AbortSignal) => json<ProductTransferOptions>(get(`/products/${encodeURIComponent(productId)}/options`, signal)),

  /** Downloads the file and returns its name and the export's notes (a listing left out, a store's fields not loaded). */
  async export(productId: string, body: { market: string; selection: ProductTransferSelection; fields?: string[] }, signal?: AbortSignal) {
    const response = await post(`/sheet/products/${encodeURIComponent(productId)}/export`, body, signal).catch(noAnswer)
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(data?.error ?? `The export failed (${response.status}).`)
    }
    const notes = exportNotesOf(response.headers.get('X-Nexus-Export-Notes'))
    const filename = await downloadResponse(response, 'products.xlsx')
    return { filename, notes }
  },

  startImport(productId: string, file: File, market: string, decisions: { links?: Record<string, string>; confirmDeletes?: boolean | string[]; listings?: string[] } = {}, signal?: AbortSignal) {
    const form = new FormData()
    form.append('market', market)
    if (decisions.links && Object.keys(decisions.links).length) form.append('links', JSON.stringify(decisions.links))
    if (decisions.confirmDeletes) form.append('confirmDeletes', decisions.confirmDeletes === true ? 'true' : JSON.stringify(decisions.confirmDeletes))
    if (decisions.listings?.length) form.append('listings', JSON.stringify(decisions.listings))
    form.append('file', file)
    return json<SheetImportStatus>(post(`/sheet/products/${encodeURIComponent(productId)}/import`, form, signal))
  },
  status: (jobId: string, signal?: AbortSignal) => json<SheetImportStatus>(get(`/sheet/imports/${encodeURIComponent(jobId)}`, signal)),
  changes: (jobId: string, query: { page?: number; filter?: 'all' | 'problems'; search?: string } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams({ page: String(query.page ?? 1), filter: query.filter ?? 'all', ...(query.search ? { search: query.search } : {}) })
    return json<SheetImportChangesPage>(get(`/sheet/imports/${encodeURIComponent(jobId)}/changes?${params}`, signal))
  },
  apply: (jobId: string, reviewToken: string) => json<SheetImportStatus>(post(`/sheet/imports/${encodeURIComponent(jobId)}/apply`, { reviewToken })),
  undo: (jobId: string) => json<SheetImportStatus>(post(`/sheet/imports/${encodeURIComponent(jobId)}/undo`)),
  problemsUrl: (jobId: string) => `${base()}/sheet/imports/${encodeURIComponent(jobId)}/problems`,
}
