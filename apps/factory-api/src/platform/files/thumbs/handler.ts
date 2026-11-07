import { events as fileEvents } from '@nexus/factory-domain/files/events'
import { defineHandler, type EventHandler } from '../../outbox/dispatch'
import { processFiles, type FilesRuntime } from '../service'
import { makeStrippedCopy } from './strip-copy'

/**
 * The worker's job after a file became AVAILABLE (COL-058; B-W2b-160): `file.available` is emitted only once the upload
 * matched its announcement and, with a scanner on, once its scan said CLEAN — so the stripped copy of a picture is made
 * after the scan, as the plan asks. Not a picture, or one that cannot be stripped: nothing to do. The store not answering:
 * the job tries again (a portal's or a link's own download makes the copy too, should every try fail).
 */

export const STRIP_PICTURES_HANDLER = 'files.stripPictures'
const ATTEMPTS = 5

const fileAvailable = fileEvents.find((event) => event.type === 'file.available')!.payload

/** The store did not answer: the job tries again. */
export class StoreNotAnswering extends Error {
  override name = 'StoreNotAnswering'
}

export function stripPicturesHandler(runtime: { readonly files?: () => FilesRuntime } = {}): EventHandler {
  const files = runtime.files ?? processFiles
  return defineHandler({
    name: STRIP_PICTURES_HANDLER,
    events: ['file.available'],
    attempts: ATTEMPTS,
    async handle(event, tools) {
      const payload = fileAvailable.parse(event.payload)
      const { outcome } = await makeStrippedCopy(files(), tools.caller, payload.fileId)
      if (outcome === 'store_unavailable') throw new StoreNotAnswering(`The file store did not answer for file ${payload.fileId}; its stripped copy is made on the next try.`)
    },
  })
}
