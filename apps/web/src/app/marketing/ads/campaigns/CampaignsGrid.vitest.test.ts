/**
 * ADM-A1 — a column whose cell lives in `settingsCell` must be listed in `SETTINGS_KEYS`.
 *
 * `physCols` marks a column `metric: !SETTINGS_KEYS.has(key)`, and a metric column renders through
 * `renderCol`, whose `default:` is `NOT_APPLICABLE[key] ?? '—'`. So a key with a `case` in
 * settingsCell but missing from SETTINGS_KEYS is UNREACHABLE — the cell is dead code and the
 * operator sees a dash forever.
 *
 * Measured on prod 2026-08-26: `ActBid Hours` and `OOB Hours` rendered '—' on 100 of 100 rows while
 * the payload carried `actBidHours`/`oobHours`/`hoursObserved` for 201 of 220 campaigns and
 * `UsageHoursCell` was present in the deployed bundle, never called. ADM-P6 added the two cases and
 * never added the two keys. Nothing failed; it just quietly showed nothing.
 *
 * The four CLUSTER columns are exempt by construction: `CLUSTER` sets `metric: false` literally, so
 * they reach settingsCell without going through SETTINGS_KEYS. The test derives that exemption from
 * the source rather than hard-coding it, so adding a fifth cluster column cannot make this lie.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./CampaignsGrid.tsx', import.meta.url)), 'utf8')

/** Comments name these keys while explaining the bug — strip them or the guard reads its own docs. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** The body of a top-level `function name(` / `const name = (` block, by brace matching. */
function blockAfter(marker: string): string {
  const i = CODE.indexOf(marker)
  if (i < 0) throw new Error(`marker not found: ${marker}`)
  const open = CODE.indexOf('{', i)
  let depth = 0
  for (let j = open; j < CODE.length; j++) {
    if (CODE[j] === '{') depth++
    else if (CODE[j] === '}' && --depth === 0) return CODE.slice(open, j + 1)
  }
  throw new Error(`unbalanced block: ${marker}`)
}

const caseKeys = (body: string) => new Set([...body.matchAll(/case '([A-Za-z0-9_]+)':/g)].map((m) => m[1]))

function settingsKeys(): Set<string> {
  const m = CODE.match(/const SETTINGS_KEYS = new Set\(\[([\s\S]*?)\]\)/)
  if (!m) throw new Error('SETTINGS_KEYS not found')
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
}

function clusterKeys(): Set<string> {
  const m = CODE.match(/const CLUSTER: PhysCol\[\] = \[([\s\S]*?)\n\]/)
  if (!m) throw new Error('CLUSTER not found')
  return new Set([...m[1].matchAll(/key: '([^']+)'/g)].map((x) => x[1]))
}

describe('ADM-A1 — every settingsCell column is reachable', () => {
  it('no settingsCell case is stranded outside SETTINGS_KEYS', () => {
    const settings = caseKeys(blockAfter('const settingsCell = (c: Camp, key: string)'))
    const stranded = [...settings].filter((k) => !settingsKeys().has(k) && !clusterKeys().has(k)).sort()
    expect(stranded, `these render '—' because physCols marks them metric: ${stranded.join(', ')}`).toEqual([])
  })

  it('the two columns the prod audit caught are wired', () => {
    expect(settingsKeys().has('actBidHours')).toBe(true)
    expect(settingsKeys().has('oobHours')).toBe(true)
  })

  it('the CLUSTER exemption is real — those four declare metric: false', () => {
    const cluster = blockAfter('const CLUSTER: PhysCol[] = ')
    expect(clusterKeys().size).toBeGreaterThan(0)
    for (const _ of clusterKeys()) expect(cluster).toContain('metric: false')
  })

  // A guard that cannot fail proves nothing: reproduce the exact prod defect and catch it.
  it('CATCHES the defect if a key is removed from SETTINGS_KEYS again', () => {
    const broken = new Set([...settingsKeys()].filter((k) => k !== 'actBidHours' && k !== 'oobHours'))
    const settings = caseKeys(blockAfter('const settingsCell = (c: Camp, key: string)'))
    const stranded = [...settings].filter((k) => !broken.has(k) && !clusterKeys().has(k)).sort()
    expect(stranded).toEqual(['actBidHours', 'oobHours'])
  })
})
