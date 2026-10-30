import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the search indexers live, found by folder (B-W2a-32; plan "Registries: nobody edits a central list"): every
 * `platform/search/indexers/<name>.ts` under `src/` (`<name>.js` under `dist/`), tests aside, in name order. One
 * function finds them for every consumer, as core/autoload.ts does for routes:
 *   - the worker (`background.ts`) imports each file and runs the index handlers with their default exports;
 *   - the production build (`build.mjs`) makes each file an esbuild entry point, so `dist/` has them too;
 *   - the tests load them from `src/`.
 * This file imports only `node:fs` and `node:path`, so the build can load it on its own.
 */

export const INDEXERS_FOLDER = ['platform', 'search', 'indexers'] as const

const INDEXER_FILE = /^[a-z][a-z0-9-]*\.(ts|js|mjs)$/
const TEST_FILE = /\.(vitest\.)?test\.[cm]?[jt]s$|\.d\.ts$/

/** Every indexer file under `<root>/platform/search/indexers/` (root = `src/` or `dist/`), in name order. */
export function indexerFiles(root: string): string[] {
  const folder = join(root, ...INDEXERS_FOLDER)
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && INDEXER_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.map'))
    .map((entry) => join(folder, entry.name))
    .sort()
}
