/**
 * AX3 — reads of the daily table, classified. Written against its own failure modes.
 *
 * 🔴 Four ways this scanner gave a WRONG answer while looking green, each fixed here:
 *
 *  1. FALSE ZERO — `git ls-files "apps/api/src/**"` returns nothing from inside apps/api, so
 *     the first run reported a spotless codebase. cwd pinned, file count asserted.
 *  2. FALSE POSITIVE, guard in a SQL variable — `ads-hierarchy` uses `${AMS}` where
 *     `const AMS = excludeAmsDailySql('p')`. Aliases are resolved per file.
 *  3. FALSE POSITIVE, guard in a `where` variable — `ads-dayparting-intel` builds
 *     `const where = { ...EXCLUDE_AMS_DAILY }` above the call and passes it by name, so
 *     brace-matching the call sees nothing. Identifiers passed as `where` are resolved.
 *  4. OVERSTATEMENT — a read constrained to `entityType: 'PRODUCT_AD'` (or TARGET) cannot be
 *     touched by duplicates that are CAMPAIGN-only. Those are IMMUNE, not unguarded.
 *
 * A false positive is worse than a false negative here: it sends you editing correct code.
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = '/Users/awais/nexus-commerce'
const files = execSync('git ls-files "apps/api/src/**/*.ts"', { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !/\.test\.|\.vitest\./.test(f))
if (files.length < 1000) throw new Error(`only ${files.length} files — mis-scoped, not clean`)

const READS = /\.amazonAdsDailyPerformance\s*\.\s*(findMany|findFirst|findUnique|aggregate|groupBy|count)\s*\(/g
type Hit = { at: string; why: string }
const guarded: Hit[] = [], immune: Hit[] = [], exposed: Hit[] = []

for (const f of files) {
  const src = readFileSync(`${ROOT}/${f}`, 'utf8')
  if (!src.includes('amazonAdsDailyPerformance') && !src.includes('"AmazonAdsDailyPerformance"')) continue

  const sqlAliases = [...src.matchAll(/(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*excludeAmsDailySql\s*\(/g)].map((m) => m[1])
  // Any identifier whose initialiser mentions the Prisma guard — however it is spelled.
  const whereAliases = [...src.matchAll(/(?:const|let)\s+([A-Za-z0-9_]+)[^=\n]*=\s*\{[\s\S]{0,600}?EXCLUDE_AMS_DAILY/g)].map((m) => m[1])
  const direct = /excludeAmsDailySql|EXCLUDE_AMS_DAILY|AMS_DAILY_MARKER|reportRunId/

  for (const m of src.matchAll(READS)) {
    let i = m.index! + m[0].length - 1, depth = 0, end = src.length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break } }
    }
    const call = src.slice(m.index!, end + 1)
    const at = `${f}:${src.slice(0, m.index!).split('\n').length} ${m[1]}`

    if (direct.test(call)) { guarded.push({ at, why: 'inline guard' }); continue }
    // Three spellings, and the third is the one that actually appears: `findMany({ where, ... })`
    // — ES shorthand, where the property and the variable share the name `where`. Matching only
    // `where: <alias>` reported `ads-dayparting-intel` as unguarded when its guard is right there.
    const byVar = whereAliases.find((a) => new RegExp(
      `where\\s*:\\s*${a}\\b` + `|where\\s*:\\s*\\{[^}]*\\.\\.\\.${a}\\b` +
      (a === 'where' ? `|\\{\\s*where\\s*[,}]` : ''),
    ).test(call))
    if (byVar) { guarded.push({ at, why: `guard via \`${byVar}\`` }); continue }

    // The duplicates are entityType CAMPAIGN, marketplace IT, 2026-05-21..2026-07-27.
    const et = call.match(/entityType\s*:\s*'([A-Z_]+)'/)
    if (et && et[1] !== 'CAMPAIGN') { immune.push({ at, why: `entityType '${et[1]}' — duplicates are CAMPAIGN-only` }); continue }

    /**
     * 🔴 The decisive one. All 659 duplicates carry `localEntityId` NULL — measured, not assumed.
     * A read that constrains `localEntityId` to an id or an in-list therefore CANNOT match them,
     * whatever else it does. AX2.3's own note says the harm came from the OTHER arm: aggregates
     * written as `localEntityId = x OR entityId = <external id>` matched on the second arm,
     * because an unlinked-looking row for a campaign we can in fact link is exactly what these
     * are. So an `entityId` clause re-exposes a read that a `localEntityId` clause had protected.
     */
    // `{ not: null }` is the same immunity spelled the other way round, and missing it put the
    // budget enforcer's per-campaign aggregate in the exposed list when it is provably safe.
    const byLocal = /localEntityId\s*:\s*(?:\{\s*(?:in|not)\s*:|[A-Za-z0-9_'"`])/.test(call)
    const byExternal = /\bentityId\s*:/.test(call)
    if (byLocal && !byExternal) { immune.push({ at, why: 'joined on localEntityId; duplicates are null there' }); continue }
    exposed.push({ at, why: byExternal ? 'matches on entityId — the arm the duplicates land in' : 'no guard, no localEntityId constraint' })
  }

  for (const m of src.matchAll(/"AmazonAdsDailyPerformance"/g)) {
    const start = Math.max(0, src.lastIndexOf('\nexport ', m.index!), src.lastIndexOf('\nfunction ', m.index!))
    const nextFn = src.indexOf('\nexport ', m.index!)
    const fn = src.slice(start, nextFn < 0 ? src.length : nextFn)
    const at = `${f}:${src.slice(0, m.index!).split('\n').length} sql`
    if (direct.test(fn) || sqlAliases.some((a) => fn.includes('${' + a + '}'))) { guarded.push({ at, why: 'guard in scope' }); continue }
    if (/entityType"?\s*=\s*'(PRODUCT_AD|AD_TARGET)'/.test(fn)) { immune.push({ at, why: 'non-CAMPAIGN grain' }); continue }
    if (/"localEntityId"\s*(=|IN)/.test(fn) && !/"entityId"\s*(=|IN)/.test(fn)) { immune.push({ at, why: 'joined on localEntityId' }); continue }
    exposed.push({ at, why: 'no guard in the enclosing function' })
  }
}

console.log(`scanned ${files.length} files\n`)
console.log(`GUARDED: ${guarded.length}`)
console.log(`IMMUNE (cannot see CAMPAIGN-only duplicates): ${immune.length}`)
console.log(`EXPOSED: ${exposed.length}\n`)
console.log('── exposed ──')
exposed.forEach((h) => console.log(`   x ${h.at}`))
