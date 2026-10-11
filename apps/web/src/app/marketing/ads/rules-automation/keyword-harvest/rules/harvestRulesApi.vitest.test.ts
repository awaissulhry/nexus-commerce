/**
 * The Rules view's mode requests (release review RS3, RS4, delta review D1): a mode change is ONE request to the harvest
 * mode route (it sets and puts back a builder rule's Manual/Automate itself), and its Undo sends the route's `before` back
 * UNCHANGED — mode, belt and harvest Auto mark — so nothing comes back acting alone that did not before.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://api.test' }))
import { restoreHarvestMode, saveHarvestMode } from './harvestRulesApi'

type Call = { method: string; path: string; body: unknown }
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let calls: Call[] = []
let modeAnswer: Record<string, unknown> = { ok: true }

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('http://api.test', '')
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path === '/api/advertising/harvest/rules/mode') return answer({ results: [{ id: 'r1', ...modeAnswer }] })
    return answer({ error: 'unexpected' }, 500)
  }))
})
afterEach(() => vi.unstubAllGlobals())

const MODE = '/api/advertising/harvest/rules/mode'

it('RS3: a refused raise is the one mode request — the page never writes a Manual setting of its own', async () => {
  modeAnswer = { ok: false, error: 'Runs 14 days first.', before: { mode: 'WATCH', belt: null, marked: false } }
  expect(await saveHarvestMode('r1', 'AUTO')).toEqual({ ok: false, words: 'Runs 14 days first.' })
  expect(calls).toEqual([{ method: 'POST', path: MODE, body: { ids: ['r1'], mode: 'AUTO' } }])
})

it('a mode change is one request, and hands back what the rule was before (mode, belt, mark)', async () => {
  modeAnswer = { ok: true, mode: 'WATCH', belt: 'automate', before: { mode: 'AUTO', belt: 'manual', marked: false } }
  expect(await saveHarvestMode('r1', 'WATCH')).toEqual({ ok: true, before: { mode: 'AUTO', belt: 'manual', marked: false } })
  expect(calls).toHaveLength(1)
})

it('D1: Undo of a rule saved at Auto before the release sends Auto UNMARKED — it keeps asking, never acts alone', async () => {
  modeAnswer = { ok: true }
  expect(await restoreHarvestMode('r1', { mode: 'AUTO', belt: 'automate', marked: false })).toEqual({ ok: true })
  expect(calls).toEqual([{ method: 'POST', path: MODE, body: { ids: ['r1'], mode: 'AUTO', belt: 'automate', marked: false } }])
})

it('RS4: Undo of Watch for a rule whose Manual made it ask sends Watch AND Manual — it asks again', async () => {
  modeAnswer = { ok: true }
  await restoreHarvestMode('r1', { mode: 'WATCH', belt: 'manual', marked: false })
  expect(calls[0].body).toEqual({ ids: ['r1'], mode: 'WATCH', belt: 'manual', marked: false })
  // A marked Auto rule gets its mark back, as it was.
  calls = []
  await restoreHarvestMode('r1', { mode: 'AUTO', belt: null, marked: true })
  expect(calls[0].body).toEqual({ ids: ['r1'], mode: 'AUTO', belt: null, marked: true })
})

it('no `before`, nothing sent; a refused Undo says the server’s words', async () => {
  expect(await restoreHarvestMode('r1', null)).toEqual({ ok: false, words: 'What it was is not known: set its mode again' })
  expect(calls).toHaveLength(0)
  modeAnswer = { ok: false, error: 'Auto is for a rule that runs: pick Watch or Ask me first.' }
  expect(await restoreHarvestMode('r1', { mode: 'AUTO', belt: null, marked: true })).toEqual({ ok: false, words: 'Auto is for a rule that runs: pick Watch or Ask me first.' })
})
