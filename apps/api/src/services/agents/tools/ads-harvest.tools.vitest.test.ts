/**
 * Keyword Harvest page rebuild (lane HMCP) — Claude's harvest tools as the contract and the descriptions hold them (no
 * database; ads-harvest-postgres.vitest.test.ts runs them end to end on a real PostgreSQL):
 *
 *   tools     the three reads (ads.view, money only under the engine's money keys) and the Nexus-only skip; apply-harvest,
 *             harvest-search-term and graduate-keyword: the one change set, always a person
 *   undo      a change the engine made is put back by apply-harvest op undo; one an older tool made before the engine by
 *             harvest-search-term op undo; a skip by an unskip, an unskip by a skip of the period that was left
 *   limits    a skip runs by rule only inside the business's limits (none by default; for good only when allowed)
 *   words     every description says approving a waiting harvest is a person's act in Nexus
 */
import { describe, expect, it } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { getTool } from '../tool-registry.js'
import { HARVEST_UNDO } from './ads-targets.tools.js'
import { GRADUATE_UNDO } from './ads-propose.tools.js'
import { SKIP_UNDO } from './ads-harvest.tools.js'

const ENGINE_CHANGE = { before: { changeSetId: 'ap1', op: 'harvest', harvestIds: [], keywords: [], negatives: [] }, after: { op: 'harvest', harvestIds: ['h1', 'h2'], keywords: ['t1'], negatives: ['n1'] } }
const DAY = 86_400_000

describe('HMCP — the harvest tools as the contract holds them', () => {
  it('the three reads: ads.view, read only, the engine\'s money keys and the start bid\'s explanation stripped without ad-spend money', () => {
    for (const name of ['harvest-candidates', 'harvest-destinations', 'harvest-history']) {
      const tool = getTool(name)!
      expect(tool, name).toMatchObject({ readOnly: true, requires: ['ads.view'] })
      for (const key of ['spendCents', 'salesCents', 'acosPct', 'cpcCents', 'bidCents', 'startBidCents', 'dailyBudgetCents', 'capMonthlyCents', 'maxAcosPct', 'bidWhy']) {
        expect(tool.restrictedFields?.[key], `${name}.${key}`).toBe(FIELDS.financialsAdspendView)
      }
    }
  })

  it('the skip: Nexus only, a person by default, undoable; the one change set and its two older names: always a person', () => {
    expect(getTool('skip-harvest-terms')).toMatchObject({ readOnly: false, openWorld: false, maxClaudeTrust: 'auto', reversibility: 'partial', requires: ['ads.campaigns.manage'] })
    expect(getTool('skip-harvest-terms')!.limits!.parse({})).toEqual({ maxTerms: 0, allowForever: false })
    for (const name of ['apply-harvest', 'harvest-search-term', 'graduate-keyword']) {
      expect(getTool(name), name).toMatchObject({ readOnly: false, openWorld: true, maxClaudeTrust: 'ask', reversibility: 'partial' })
      expect(getTool(name)!.limits, name).toBeUndefined()
    }
  })
})

describe('HMCP round 2 — the Rules and Sources views', () => {
  it('two reads on ads.view; archive and sources changes: Nexus only, automation permission, always a person, undoable', () => {
    for (const name of ['harvest-rules', 'harvest-sources']) expect(getTool(name), name).toMatchObject({ readOnly: true, requires: ['ads.view'] })
    for (const name of ['set-harvest-rules', 'set-harvest-sources']) {
      expect(getTool(name), name).toMatchObject({ readOnly: false, openWorld: false, maxClaudeTrust: 'ask', reversibility: 'partial', requires: ['ads.automation.manage'] })
    }
    // M1 — a rule's mode is the Rules view's own service, never A1's switch.
    expect(getTool('harvest-rules')!.description).toMatch(/set-harvest-rules \(the Rules view\'s own service\)/)
    expect(getTool('harvest-rules')!.description).not.toMatch(/turn-up-automation/)
    expect(getTool('set-harvest-rules')!.description).toMatch(/Manual\/Automate setting with it \(Automate for Watch and Auto, Manual for Ask me\)/)
  })

  it('undo: a mode change sets each rule back to its own mode; an archive is unarchived and back; a source change is the opposite op', async () => {
    const { RULES_UNDO, SOURCES_UNDO } = await import('./ads-harvest-rules.tools.js')
    const mode = RULES_UNDO.request({ before: { op: 'mode', rules: [{ id: 'r1', mode: 'ASK' }, { id: 'r2', mode: 'OFF' }] }, after: { op: 'mode', rules: [{ id: 'r1', mode: 'WATCH' }, { id: 'r2', mode: 'WATCH' }] } })
    expect(mode).toEqual({ tool: 'set-harvest-rules', args: expect.objectContaining({ op: 'mode', rules: [{ id: 'r1', mode: 'ASK' }, { id: 'r2', mode: 'OFF' }] }) })
    expect(getTool('set-harvest-rules')!.input.safeParse((mode as { args: Record<string, unknown> }).args).success).toBe(true)
    // Delta review D1 — each rule back with its own Manual/Automate and its harvest Auto mark exactly as they were: a rule
    // that was at Auto WITHOUT the mark is put back at Auto without it (it keeps asking).
    const exact = RULES_UNDO.request({ before: { op: 'mode', rules: [{ id: 'r1', mode: 'AUTO', belt: null, marked: false }, { id: 'r2', mode: 'AUTO', belt: 'automate', marked: true }] }, after: { op: 'mode', rules: [{ id: 'r1', mode: 'ASK' }, { id: 'r2', mode: 'ASK' }] } })
    expect(exact).toEqual({ tool: 'set-harvest-rules', args: expect.objectContaining({ rules: [{ id: 'r1', mode: 'AUTO', belt: null, marked: false }, { id: 'r2', mode: 'AUTO', belt: 'automate', marked: true }] }) })
    expect(getTool('set-harvest-rules')!.input.safeParse((exact as { args: Record<string, unknown> }).args).success).toBe(true)
    expect(RULES_UNDO.request({ before: null, after: { op: 'archive', rules: [{ id: 'r1' }] } })).toEqual({ tool: 'set-harvest-rules', args: expect.objectContaining({ op: 'unarchive', ids: ['r1'] }) })
    expect(RULES_UNDO.request({ before: null, after: { op: 'unarchive', rules: [{ id: 'r1' }] } })).toMatchObject({ args: { op: 'archive' } })
    for (const [op, back] of [['assign', 'detach'], ['detach', 'assign'], ['pause', 'resume'], ['resume', 'pause']]) {
      expect(SOURCES_UNDO.request({ before: null, after: { op, market: 'IT', ruleId: 'r1', ids: ['g1'] } })).toEqual({ tool: 'set-harvest-sources', args: expect.objectContaining({ op: back, market: 'IT', ruleId: 'r1', adGroupIds: ['g1'] }) })
    }
  })
})

describe('MCP.8 — a harvest tool aimed at another business\'s rows says "not found", never an input error, and never echoes the id', () => {
  it('the refusals name no id the caller did not send whole', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./ads-harvest.tools.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/a product it names was' : `\$\{unknown.length\} products it names were`\} not found in this business/)
    const rules = (await import('node:fs')).readFileSync(new URL('./ads-harvest-rules.tools.ts', import.meta.url), 'utf8')
    expect(rules).toMatch(/why: 'not found in this business \(no harvest rule with this id\)'/)
    expect(rules).toMatch(/why: 'not found in this business' \}\)/)
  })
})

describe('HMCP review fixes', () => {
  it('L2 — a graduation is re-checked on the engine plan it was approved on (basis), as harvest-search-term', async () => {
    const { MATERIAL_PREVIEW_FIELDS } = await import('../../agent-fleet/approval-inbox.service.js')
    for (const name of ['graduate-keyword', 'harvest-search-term', 'apply-harvest']) expect(MATERIAL_PREVIEW_FIELDS[name], name).toContain('basis')
  })

  it('L1 — a harvest asked before the engine is told apart from today\'s requests and legacy undos', async () => {
    const { preEngineHarvest } = await import('../../agent-fleet/approval-inbox.service.js')
    expect(preEngineHarvest('harvest-search-term', {}, { action: 'harvest-search-term', basis: 'old' })).toBe(true)
    expect(preEngineHarvest('graduate-keyword', {}, { suggestedBidCents: 40, destination: {} })).toBe(true)
    expect(preEngineHarvest('graduate-keyword', {}, { engine: 'apply-harvest' })).toBe(false)
    expect(preEngineHarvest('harvest-search-term', { op: 'undo' }, { op: 'undo', legacy: true })).toBe(false)
    expect(preEngineHarvest('apply-harvest', {}, {})).toBe(false)
  })

  it('L3 — harvest-search-term takes no harvestIds: an engine harvest is put back by apply-harvest op undo, the undo the page counts', () => {
    expect(getTool('harvest-search-term')!.input.shape).not.toHaveProperty('harvestIds')
  })
})

describe('HMCP — undo', () => {
  it('a change the engine made, asked through any of the three names, is put back by apply-harvest op undo', () => {
    for (const undo of [HARVEST_UNDO, GRADUATE_UNDO, getTool('apply-harvest')!.undo!]) {
      expect(undo.request(ENGINE_CHANGE)).toEqual({ tool: 'apply-harvest', args: expect.objectContaining({ op: 'undo', harvestIds: ['h1', 'h2'] }) })
    }
    // The recommendation a graduation carried out is offered again once it is put back.
    expect(typeof GRADUATE_UNDO.undone).toBe('function')
  })

  it('one an older tool made before the engine: harvest-search-term op undo, with exactly what it made', () => {
    expect(HARVEST_UNDO.request({ before: { changeSetId: 'ap0', op: 'harvest', keyword: null, negative: null }, after: { op: 'harvest', keyword: { targetId: 't1', bidCents: 45 }, negative: { targetId: 'n1', standing: true } } }))
      .toEqual({ tool: 'harvest-search-term', args: expect.objectContaining({ op: 'undo', changeSetId: 'ap0', keywordId: 't1', negativeId: 'n1' }) })
    const grad = GRADUATE_UNDO.request({ before: { changeSetId: 'ap0', keyword: null }, after: { targetId: 't9', bidCents: 37 } })
    expect(grad).toEqual({ tool: 'harvest-search-term', args: expect.objectContaining({ op: 'undo', changeSetId: 'ap0', keywordId: 't9' }) })
    expect((grad as { args: Record<string, unknown> }).args).not.toHaveProperty('negativeId')
    expect(getTool('harvest-search-term')!.input.safeParse((grad as { args: Record<string, unknown> }).args).success).toBe(true)
    expect(HARVEST_UNDO.request({ before: { changeSetId: 'ap2', op: 'undo' }, after: { op: 'undo', undoes: 'ap0', paused: true, lifted: 1 } })).toMatchObject({ refusal: expect.stringMatching(/harvest the term again/) })
  })

  it('a skip is put back by an unskip; an unskip by a skip for good where one was, else for the days that were left (7 or 30)', () => {
    const ids = ['IT|p1|a term']
    expect(SKIP_UNDO.request({ before: { op: 'skip', ids, state: { [ids[0]]: null } }, after: { op: 'skip', ids, state: { [ids[0]]: { until: null, forGood: true } } } }))
      .toEqual({ tool: 'skip-harvest-terms', args: expect.objectContaining({ op: 'unskip', ids }) })
    const unskip = (state: unknown) => SKIP_UNDO.request({ before: { op: 'unskip', ids, state: { [ids[0]]: state } }, after: { op: 'unskip', ids, state: { [ids[0]]: null } } })
    expect(unskip({ until: null, forGood: true })).toMatchObject({ args: { op: 'skip', period: 'forever' } })
    expect(unskip({ until: new Date(Date.now() + 20 * DAY).toISOString(), forGood: false })).toMatchObject({ args: { op: 'skip', period: '30d' } })
    expect(unskip({ until: new Date(Date.now() + 3 * DAY).toISOString(), forGood: false })).toMatchObject({ args: { op: 'skip', period: '7d' } })
    expect(SKIP_UNDO.request({ before: {}, after: { op: 'skip', ids: [] } })).toMatchObject({ refusal: expect.any(String) })
  })
})

describe('HMCP — a skip by rule only inside the business\'s limits', () => {
  const judge = (preview: unknown, limits: Record<string, unknown> = {}) => getTool('skip-harvest-terms')!.withinLimits!(preview, getTool('skip-harvest-terms')!.limits!.parse(limits) as Record<string, unknown>)
  const skip = (n: number, period = '30d') => ({ action: 'skip-harvest-terms', op: 'skip', period, ids: Array.from({ length: n }, (_, i) => `IT|p1|term ${i}`) })
  it('none by default; up to its count; for good only when allowed', () => {
    expect(judge(skip(1))).toMatch(/more than the 0 .* \(0: every one waits for a person\)/)
    expect(judge(skip(3), { maxTerms: 5 })).toBeNull()
    expect(judge(skip(6), { maxTerms: 5 })).toMatch(/hides 6 terms, more than the 5/)
    expect(judge(skip(1, 'forever'), { maxTerms: 5 })).toMatch(/for good waits for a person/)
    expect(judge(skip(1, 'forever'), { maxTerms: 5, allowForever: true })).toBeNull()
    expect(judge({ action: 'something else' }, { maxTerms: 5 })).toMatch(/a person decides/)
  })
})

describe('HMCP — the words Claude reads', () => {
  it('apply-harvest names every choice of a change set and its undo; approving stays a person\'s', () => {
    const d = getTool('apply-harvest')!.description
    for (const words of ['harvest-candidates', 'harvest-destinations', 'newCampaign', 'newPortfolios', 'negateSource', 'funnel', 'bidCents', 'PHRASE', 'op undo', 'never archived', 'planHash', 'approval-status', 'harvest-history', 'Claude cannot approve it']) {
      expect(d, words).toContain(words)
    }
  })

  it('every harvest tool that can find a waiting harvest says a person approves it in Nexus', () => {
    expect(getTool('harvest-candidates')!.description).toMatch(/a person approves or rejects it in Nexus; Claude cannot/)
    for (const name of ['harvest-search-term', 'graduate-keyword']) expect(getTool(name)!.description, name).toMatch(/Claude cannot approve it/)
    expect(getTool('apply-brain-harvest')!.description).toMatch(/Claude cannot approve it/)
    expect(getTool('ad-search-terms')!.description).toMatch(/harvest-candidates/)
  })
})
