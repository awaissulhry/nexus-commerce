import { pathToFileURL } from 'node:url'
import { indexerFiles } from './indexer-files'
import { IndexerConfigError, type SearchIndexer } from './indexer'

/**
 * The search indexers of this process (B-W2a-32): the default export of every file in `platform/search/indexers/`
 * (./indexer-files.ts), loaded once. Two indexers of one record type, or a file without an indexer, stop the worker at
 * start (and fail the registry test), never at the first event.
 */

function isIndexer(value: unknown): value is SearchIndexer {
  return typeof value === 'object' && value !== null && typeof (value as SearchIndexer).recordType === 'string' && typeof (value as SearchIndexer).read === 'function'
}

/** Checks a set of indexers: one per record type. */
export function checkIndexers(indexers: readonly SearchIndexer[]): readonly SearchIndexer[] {
  const types = new Set<string>()
  for (const indexer of indexers) {
    if (types.has(indexer.recordType)) throw new IndexerConfigError(`Two indexers of ${indexer.recordType}`)
    types.add(indexer.recordType)
  }
  return Object.freeze([...indexers])
}

/** Loads every indexer file under `root` (`src/` or `dist/`). */
export async function loadIndexers(root: string): Promise<readonly SearchIndexer[]> {
  const indexers: SearchIndexer[] = []
  for (const file of indexerFiles(root)) {
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown }
    if (!isIndexer(module.default)) throw new IndexerConfigError(`${file} does not default-export defineIndexer({…})`)
    indexers.push(module.default)
  }
  return checkIndexers(indexers)
}

/** The event types any of the indexers follows, sorted. */
export function followedEvents(indexers: readonly SearchIndexer[]): string[] {
  return [...new Set(indexers.flatMap((indexer) => Object.keys(indexer.on)))].sort()
}
