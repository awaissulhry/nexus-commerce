import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOOR_PAGES, FloorMoves, HELD_SHOWN_MS, MOVE_WAIT_MS, PAGE_STALE_SECONDS } from './moves'
import { TILE_RULES } from './model'
import { TASK_ROUTES, taskOfTile } from './tasks/routes'
import { NO_COUNTS, type Counts } from './tasks/scans/model'
import { forgetLeft, keepLeft, leftCounts, withLeft } from './tasks/scans/left'
import { NOT_STARTED } from './tasks/scans/timing'

const HERE = dirname(fileURLToPath(import.meta.url))

function setUp(answers: () => boolean | Promise<boolean>) {
  const calls: string[] = []
  const held: boolean[] = []
  let at = '/floor/operation'
  const moves = new FloorMoves({
    push: (path) => calls.push(`push ${path}`),
    replace: (path) => calls.push(`replace ${path}`),
    at: () => at,
    reachable: async () => answers(),
    held: (value) => held.push(value),
  })
  return { moves, calls, held, land: (path: string) => ((at = path), moves.arrived()) }
}

describe('a floor move with the network gone', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a move that lands is nothing to say', async () => {
    const { moves, calls, held, land } = setUp(() => false)
    moves.push('/floor')
    land('/floor')
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS * 3)
    expect(calls).toEqual(['push /floor'])
    expect(held.at(-1)).toBe(false)
  })

  it('a page the tablet does not hold: the screen stays, the waiting move is taken back, the words show and leave', async () => {
    const { moves, calls, held } = setUp(() => false)
    moves.push('/floor/machine')
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS)
    expect(calls).toEqual(['push /floor/machine', 'replace /floor/operation'])
    expect(held.at(-1)).toBe(true)
    await vi.advanceTimersByTimeAsync(HELD_SHOWN_MS)
    expect(held.at(-1)).toBe(false)
  })

  it('a slow server is no reason to hold: the move goes on waiting until it lands', async () => {
    const { moves, calls, held, land } = setUp(() => true)
    moves.replace('/floor/sign-in')
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS * 5)
    expect(calls).toEqual(['replace /floor/sign-in'])
    expect(held).not.toContain(true)
    land('/floor/sign-in')
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS * 5)
    expect(calls).toHaveLength(1)
  })

  it('an answer that comes after the move landed changes nothing', async () => {
    let answer: (value: boolean) => void = () => undefined
    const { moves, calls, held, land } = setUp(() => new Promise<boolean>((done) => (answer = done)))
    moves.push('/floor')
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS)
    land('/floor')
    answer(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(['push /floor'])
    expect(held).not.toContain(true)
  })

  it('the next tap starts clean: the words go, the new move is watched', async () => {
    const { moves, calls, held } = setUp(() => false)
    moves.push('/floor/machine')
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS)
    moves.push('/floor/help')
    expect(held.at(-1)).toBe(false)
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS)
    expect(calls).toEqual(['push /floor/machine', 'replace /floor/operation', 'push /floor/help', 'replace /floor/operation'])
    expect(held.at(-1)).toBe(true)
  })

  it('a move to where the screen already is needs no watching', async () => {
    const { moves, calls } = setUp(() => false)
    moves.replace('/floor/operation')
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS * 2)
    expect(calls).toEqual(['replace /floor/operation'])
  })
})

describe('what a tablet holds for a move', () => {
  it('every tile, Home, Scan anything, the queue, the notice and sign-in are prefetched', () => {
    for (const rule of TILE_RULES) {
      const task = taskOfTile(rule.key)
      expect(FLOOR_PAGES, rule.key).toContain(task ? TASK_ROUTES[task] : '/floor/scan')
    }
    for (const page of ['/floor', '/floor/sync', '/floor/notice', '/floor/sign-in', '/floor/clock', '/floor/myday', '/floor/help']) expect(FLOOR_PAGES).toContain(page)
    expect(FLOOR_PAGES).not.toContain('/floor/enrol')
    expect(FLOOR_PAGES).not.toContain('/floor/display')
  })

  it('next.config.ts keeps a prefetched page as long as moves.ts says, and has Next wait for the network', () => {
    const config = readFileSync(join(HERE, '../../next.config.ts'), 'utf8')
    expect(config).toContain('useOffline: true')
    expect(Number(/static: ([\d_]+)/.exec(config)?.[1]?.replace(/_/g, ''))).toBe(PAGE_STALE_SECONDS)
  })

  it('every page of a move keeps itself once on screen: Next never prefetches the page on screen', () => {
    for (const page of FLOOR_PAGES) {
      const source = readFileSync(join(HERE, '../app/(floor)', page, 'page.tsx'), 'utf8')
      expect(Number(/unstable_dynamicStaleTime = ([\d_]+)/.exec(source)?.[1]?.replace(/_/g, '')), page).toBe(PAGE_STALE_SECONDS)
    }
  })

  it('no floor screen calls Next\'s router itself: every move goes through FloorMoves', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') ? [join(dir, entry.name)] : []))
    const direct = files(HERE).filter((file) => /useRouter\b[^\n]*from 'next\/navigation'/.test(readFileSync(file, 'utf8')) && !file.endsWith('FloorApp.tsx'))
    expect(direct).toEqual([])
  })
})

describe('what a person left on Operation', () => {
  const left = (counts: Counts = { ...NO_COUNTS, typedGood: 18 }, state: 'RUNNING' | 'PAUSED' | 'NOT_STARTED' = 'RUNNING') => ({
    card: { bundle: { id: 'b1', code: 'BN-1' } },
    operation: { id: 'op-20', seq: 20, code: 'SEW', name: 'Sew' },
    counts,
    work: { timing: { ...NOT_STARTED, state, runningSince: state === 'RUNNING' ? '2026-11-02T10:00:00.000Z' : null } },
  })

  it('the counts typed come back with the bundle, for that person only, and leave with the report', () => {
    keepLeft('ana', left())
    expect(leftCounts('ana', 'bn-1', 'op-20')?.typedGood).toBe(18)
    expect(leftCounts('bea', 'BN-1', 'op-20')).toBeNull()
    expect(withLeft('bea', [])).toEqual([])
    forgetLeft('ana', 'BN-1', 'op-20')
    expect(leftCounts('ana', 'BN-1', 'op-20')).toBeNull()
  })

  it('an offline Home offers Continue for running work the last read cannot know, and wins over an older row', () => {
    keepLeft('ana', left())
    const rows = withLeft('ana', [{ bundleId: 'b1', bundleCode: 'BN-1', operation: { id: 'op-20', seq: 20, code: 'SEW', name: 'Sew' }, state: 'PAUSED', pausedAt: null, runningSince: null, pausedAtClockOut: false }])
    expect(rows.map((row) => row.state)).toEqual(['RUNNING'])
    forgetLeft('ana', 'BN-1', 'op-20')
  })

  it('counts typed on a bundle not started come back, with no Continue row; nothing typed and nothing running is not kept', () => {
    keepLeft('ana', left({ ...NO_COUNTS, typedGood: 3 }, 'NOT_STARTED'))
    expect(leftCounts('ana', 'BN-1', 'op-20')?.typedGood).toBe(3)
    expect(withLeft('ana', [])).toEqual([])
    keepLeft('ana', left(NO_COUNTS, 'NOT_STARTED'))
    expect(leftCounts('ana', 'BN-1', 'op-20')).toBeNull()
  })
})
