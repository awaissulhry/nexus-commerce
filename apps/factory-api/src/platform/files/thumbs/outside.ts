import { ConflictError } from '@nexus/factory-domain/core/errors'
import { isPicture, isStrippable } from '@nexus/factory-domain/files/thumbs/strip'
import type { CommandCaller } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import type { FilesRuntime } from '../service'
import { makeStrippedCopy } from './strip-copy'

/**
 * What a portal or a link is served of a file (COL-058; B-W2b-160): a picture ONLY as its stripped copy (no EXIF, no
 * position: strip-copy.ts), whatever its kind; every other file as it is stored. The office, the floor and the system
 * get the file itself. When the worker has not made the copy yet, it is made now (as the tenant's system caller, the
 * caller the outside download presigns as); a picture that cannot be stripped (HEIC, a damaged one) is not shown outside
 * the office at all. Used by the download (files.ts downloadFile) and the preview (preview/preview.ts).
 */
export async function keyShownTo(
  runtime: FilesRuntime,
  context: RequestContext,
  storeCaller: CommandCaller,
  row: { readonly id: string; readonly contentType: string; readonly storageKey: string; readonly thumbnailKey?: string | null },
): Promise<string> {
  if ((context.audience !== 'partner' && context.audience !== 'link') || !isPicture(row.contentType)) return row.storageKey
  if (row.thumbnailKey) return row.thumbnailKey
  if (!isStrippable(row.contentType)) {
    throw new ConflictError('This picture cannot be shown outside the office: its type keeps camera and location data. Ask your contact for a JPEG or a PDF.')
  }
  const made = await makeStrippedCopy(runtime, storeCaller, row.id)
  if (made.key) return made.key
  throw new ConflictError(
    made.outcome === 'store_unavailable' ? 'This picture is being prepared to be shown; try again in a minute.' : 'This picture cannot be shown outside the office. Ask your contact for a copy.',
  )
}
