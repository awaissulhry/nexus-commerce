import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the safety calendar's sources live, found by folder (B-W2b-120; plan: "the calendar reads a folder of sources
 * (modules/safety/calendar/sources/*.ts): each later step adds one new file for its deadlines, so no later step edits this
 * one"): every `modules/safety/calendar/sources/<name>.ts` under `src/` (`.js` under `dist/`), tests aside, in name order.
 * One function finds them for every consumer, as core/autoload.ts does for routes and modules/insights/reports/report-files.ts
 * for the reports:
 *   - the calendar routes (`./routes.ts`) load each file when the API starts (./registry.ts);
 *   - the production build (`build.mjs`) makes each file an esbuild entry point, so `dist/` has them too;
 *   - the tests load them from `src/`.
 * This file imports only `node:fs` and `node:path`, so the build can load it on its own.
 */

export const SOURCES_FOLDER = ['modules', 'safety', 'calendar', 'sources'] as const

const SOURCE_FILE = /^[a-z][a-z0-9-]*\.(ts|js|mjs)$/
const TEST_FILE = /\.(vitest\.)?test\.[cm]?[jt]s$|\.d\.ts$/

/** Every source file under `<root>/modules/safety/calendar/sources/` (root = `src/` or `dist/`), in name order. */
export function sourceFiles(root: string): string[] {
  const folder = join(root, ...SOURCES_FOLDER)
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.map'))
    .map((entry) => join(folder, entry.name))
    .sort()
}
