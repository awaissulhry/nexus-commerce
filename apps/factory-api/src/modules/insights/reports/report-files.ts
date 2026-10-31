import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the standard reports live, found by folder (B-W2a-79; plan W2a §1 "Registries: report definitions
 * (`modules/insights/reports/defs/`) are files in registry folders. Nobody edits a central list."): every
 * `modules/insights/reports/defs/<area>.<name>.ts` under `src/` (`.js` under `dist/`), tests aside, in name order. One
 * function finds them for every consumer, as core/autoload.ts does for routes and platform/search/indexer-files.ts for
 * the search indexers:
 *   - the insights routes (`../routes.ts`) load each file when the API starts and serve its report;
 *   - the production build (`build.mjs`) makes each file an esbuild entry point, so `dist/` has them too;
 *   - the tests load them from `src/`.
 * This file imports only `node:fs` and `node:path`, so the build can load it on its own.
 */

export const REPORTS_FOLDER = ['modules', 'insights', 'reports', 'defs'] as const

const REPORT_FILE = /^[a-z]+\.[a-z][a-z0-9-]*\.(ts|js|mjs)$/
const TEST_FILE = /\.(vitest\.)?test\.[cm]?[jt]s$|\.d\.ts$/

/** Every report file under `<root>/modules/insights/reports/defs/` (root = `src/` or `dist/`), in name order. */
export function reportFiles(root: string): string[] {
  const folder = join(root, ...REPORTS_FOLDER)
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && REPORT_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.map'))
    .map((entry) => join(folder, entry.name))
    .sort()
}
