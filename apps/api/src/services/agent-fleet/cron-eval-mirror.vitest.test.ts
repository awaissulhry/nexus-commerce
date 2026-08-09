/**
 * NAF.WF-S5R / S5.b — the drift alarm for the web mirror of `cron-eval.ts`.
 *
 * `validateDefinition` refuses a schedule exactly when `nextCronFire` returns
 * null, and the editor's checklist is required to be in EXACT parity with
 * that. The web app cannot import from `apps/api`, so it carries a verbatim
 * copy; this test is what stops the copy from quietly becoming a fork.
 *
 * It compares the CODE, not the file: each header block comment says
 * something different on purpose (the mirror explains that it is one). The
 * comparison starts at the first line of real code, which is where any
 * behaviour can begin to differ.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(import.meta.dirname, '../../../../..')
const SERVER = join(REPO, 'apps/api/src/services/agent-fleet/cron-eval.ts')
const MIRROR = join(REPO, 'apps/web/src/app/fleet/workflows/cron-eval.ts')

/** Everything from the first line of code onward — the header is allowed to
 *  differ, nothing else is. */
function body(path: string): string {
  const src = readFileSync(path, 'utf8')
  const i = src.indexOf('const SCAN_LIMIT_MINUTES')
  if (i < 0) throw new Error(`${path}: cannot find the start of the code`)
  return src.slice(i).trimEnd()
}

describe('cron-eval mirror', () => {
  it('the web copy is byte-identical to the server module below the header', () => {
    expect(body(MIRROR)).toBe(body(SERVER))
  })

  it('both files still exist where the mirror says they do', () => {
    expect(readFileSync(SERVER, 'utf8')).toContain('export function nextCronFire')
    expect(readFileSync(MIRROR, 'utf8')).toContain('export function nextCronFire')
  })
})
