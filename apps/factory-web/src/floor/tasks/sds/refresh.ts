import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { readPack, readSheetBytes, type SdsPack } from './api'
import { sha256Of, type SdsKeeper } from './keep'
import { filesToDrop, sheetsToFetch } from './model'

/** A read the file store refused (its rate bucket) waits this long before its one retry. */
const RETRY_MS = 1_500

/** One refresh at a time per tab (the page and the app's beat may both ask); whoever asks while it runs watches it too. */
let running: Promise<RefreshResult> | null = null
const watchers = new Set<RefreshWatch>()

export interface RefreshResult {
  readonly pack: SdsPack
  /** Current sheets the tablet could not take this time (the store did not answer, the bytes did not match). */
  readonly missing: number
}

export interface RefreshWatch {
  /** The new pack is kept (the list can show at once; its PDFs follow). */
  readonly onPack?: (pack: SdsPack) => void
  /** One more PDF is kept. */
  readonly onFile?: (fileId: string) => void
}

/** The API refused for now (the file store's pacing, a moment of no answer): worth one more try; a missing object is not. */
const worthRetry = (error: unknown): boolean => isApiError(error) && (error.kind === 'unavailable' || error.kind === 'rate_limited')

/**
 * Brings what the tablet keeps up to date (model.ts): the site's pack read and kept FIRST (the list shows at once), then every
 * current sheet whose bytes the tablet lacks (or holds with another SHA-256) read and checked against its SHA-256 before it is
 * kept, then the files the pack no longer lists dropped. A failure on the way keeps what was kept before; the next refresh
 * tries again.
 */
export function refreshKept(api: ApiClient, keeper: SdsKeeper, watch: RefreshWatch = {}): Promise<RefreshResult> {
  watchers.add(watch)
  const done = () => void watchers.delete(watch)
  running ??= (async () => {
    try {
      const pack = await readPack(api)
      const kept = await keeper.files()
      await keeper.savePack(pack)
      for (const watcher of watchers) watcher.onPack?.(pack)
      let missing = 0
      for (const sheet of sheetsToFetch(pack, kept)) {
        let taken = false
        for (let attempt = 0; attempt < 2 && !taken; attempt += 1) {
          try {
            const { bytes } = await readSheetBytes(api, sheet.id)
            if ((await sha256Of(bytes)) !== sheet.sha256) break
            await keeper.saveFile({ fileId: sheet.fileId, sha256: sheet.sha256, bytes })
            for (const watcher of watchers) watcher.onFile?.(sheet.fileId)
            taken = true
          } catch (error) {
            if (!worthRetry(error) || attempt > 0) break
            await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
          }
        }
        if (!taken) missing += 1
      }
      await keeper.dropFiles(filesToDrop(pack, kept.keys()))
      return { pack, missing }
    } finally {
      running = null
    }
  })()
  return running.finally(done)
}
