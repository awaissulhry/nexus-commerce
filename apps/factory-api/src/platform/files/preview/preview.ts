import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { dispositionOf, PREVIEW_URL_SECONDS, previewModeOf, type PreviewMode } from '@nexus/factory-domain/files/preview/rules'
import { contextOf, presignedView, readVisible, storeCall, tenantOf, type Callers } from '../files'
import type { FilesRuntime } from '../service'
import { keyShownTo } from '../thumbs/outside'

/**
 * In-browser preview (COL-047; B-W2b-160): GET /files/:fileId/preview answers a presigned GET that lives 60 seconds, like
 * the download, with the same audience check (COL-050: the office always; a floor, a portal or a link only what is shared
 * with it, once AVAILABLE) — `inline` for a picture or a PDF, so the browser shows it in place, `download` (an attachment)
 * for every other kind. A portal or a link is shown a picture only as its stripped copy (thumbs/outside.ts). Floor, portal
 * and link callers presign as their tenant's system context, as the download does.
 */
export async function previewFile(runtime: FilesRuntime, callers: Callers, fileId: string): Promise<Omit<ReturnType<typeof presignedView>, 'method'> & { readonly mode: PreviewMode; readonly method: 'GET' }> {
  const context = contextOf(callers.caller)
  const row = await readVisible(callers.caller, fileId)
  if (row.status !== 'AVAILABLE') throw new InvalidStateError(`This file is ${row.status}; only an available file can be opened.`)
  const storeCaller = context.audience === 'office' ? callers.caller : callers.system(tenantOf(context))
  const key = await keyShownTo(runtime, context, storeCaller, row)
  const mode = previewModeOf(row.contentType)
  const request = await storeCall(() =>
    runtime.storage.presignDownload(storeCaller, row.storeAccountId, {
      key,
      contentType: row.contentType,
      disposition: dispositionOf(mode, row.originalName),
      expiresInSeconds: PREVIEW_URL_SECONDS,
      now: runtime.clock.now(),
    }),
  )
  return { mode, ...presignedView(request), method: 'GET' }
}
