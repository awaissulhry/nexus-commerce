/**
 * PES.4 — locate the API's service sources for the contract tests.
 *
 * NOT collected as a test (vitest's `include` is `*.vitest.test.ts`); imported by the two suites
 * that assert this lane's type mirrors against the API files they mirror.
 *
 * ## Why this is not `join(process.cwd(), '..', 'api', …)`
 *
 * It was, and it was wrong in a way that could only be seen from someone else's chair. `cwd`
 * depends on HOW vitest is invoked: `npm run test --workspace=@nexus/web` and `cd apps/web &&
 * npx vitest` both set it to `apps/web`, where the relative path resolves correctly — and those
 * are the only two ways this lane ever ran it. Run from the repo root (`npx vitest run --root
 * apps/web`), the same expression resolves to `/Users/awais/api/...` and every assertion dies on
 * ENOENT. PES.2 hit it immediately (ruling #67); this lane never could.
 *
 * So the root is derived from THIS FILE's own location and verified to exist, which no invocation
 * can bend. It also survives the test files moving, which the relative-dots version would not.
 *
 * The throw is deliberate and matches the extractor's rule one level up: a contract test whose
 * SUBJECT is missing must fail loudly, and so must one whose FILE is missing. Returning a path
 * that happens not to exist would turn `readFileSync` into the error reporter, which names the
 * symptom (ENOENT) rather than the cause (the repo root was not found).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from this file until the directory that actually contains `apps/api`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 15; i++) {
    if (existsSync(join(dir, 'apps', 'api', 'src', 'services', 'pim'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    'Could not find the repo root (no ancestor of this file contains apps/api/src/services/pim). ' +
      'The contract tests cannot read the API sources they assert against.',
  )
}

/** `apps/api/src/services/pim` — where the types these mirrors mirror actually live. */
export const PIM_DIR = join(repoRoot(), 'apps', 'api', 'src', 'services', 'pim')

/** One service file inside it. */
export function pimFile(name: string): string {
  const path = join(PIM_DIR, name)
  if (!existsSync(path)) throw new Error(`${name} is not in ${PIM_DIR} — renamed, moved, or deleted?`)
  return path
}
