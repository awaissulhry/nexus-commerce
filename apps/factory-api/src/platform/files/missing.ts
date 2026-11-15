import { NotFoundError } from '@nexus/factory-domain/core/errors'

/**
 * A file whose bytes are missing from the store (B-W2b-F56): the file's row is there, but the store holds no object under
 * its key (or the key is one storageKeyFor could not have made, so no object can be under it). The store answered, so it
 * is never an outage (503, worth a retry): it is 404 in words, and a screen shows its placeholder. Its own module, so the
 * thumbs and the readers use it without an import cycle through files.ts.
 */

/** The words of a missing file. */
export const MISSING_FILE_WORDS = 'The file is missing from the store.'

export class MissingFileError extends NotFoundError {
  override name = 'MissingFileError'
  constructor() {
    super(MISSING_FILE_WORDS)
  }
}
