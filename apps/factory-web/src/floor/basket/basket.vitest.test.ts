import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { homeTiles, tilePage, TILE_RULES } from '../model'
import { readScan } from '../scan/scan-model'
import { basketPageFor, FLOOR_NAMESPACES, TASK_ROUTES } from '../tasks/routes'
import { basketHomeSchema, basketReadSchema, FOR_YOU_KINDS, WORK_STATES } from './api'
import { BasketDock, dockDraws, type BasketDockModel } from './dock/BasketDock'
import { atQuality, basketHome, basketRead, FRAME, PACKING, QUALITY, route, STITCHING } from './fixtures'
import { HELP_READY } from './help'
import { memorySeenStore, SEEN_KEPT, seenKeyOf, unseenForYou, withSeen } from './home/seen'
import { BasketHomeView, type BasketHomeViewModel } from './home/view/BasketHomeView'
import { basketHomeOf, basketPath, deptOf, dockOf, elsewhereOf, homeOf, previousStepOf, qualityOf, readyOf, stepBarOf, stepDone, peekFlash, clearFlash, putFlash, viewOf, type BasketView, type DockInput } from './model'
import { BasketPageView, type BasketPageViewModel } from './page/view/BasketPageView'
import { STEPS_READY } from './steps'

/**
 * owb-fl5 — the basket on a phone (written, run at the end: Owner rule "checks only at the end"). The home's lists and the device-only
 * "seen", the step bar, the dock's state machine (hold → no Start; a changed design → "I saw the new design" first; Quality → Passed
 * held until 8 of 8; the last step → Packed; another department → Take it here / Not on its route; a leader from a list → Change the
 * step only once fl6's window exists), the phone's scan router, the Baskets tile, every word in it and en, and the render at 390 px:
 * the dock is the frame's sticky foot, so it is on the first screen whatever the page's length.
 */

// fl8's help parts read the floor app (its queue, its person): a render of the page alone draws their places empty (the page's own
// rule — no tile row while HELP_READY is false — is what is held here; fl8 holds its parts in its own tests).
vi.mock('./help', () => ({ HELP_READY: false, ProblemTile: () => null, AskTile: () => null, PhotoTile: () => null, NotesTile: () => null, AskWindow: () => null, ProblemCard: () => null, AskCard: () => null }))

const view = (read = basketRead()): BasketView => viewOf(read)!
const input = (read = basketRead(), extra: Partial<DockInput> = {}): DockInput => {
  const v = view(read)
  return { view: v, scanned: false, leader: false, designPending: false, stepsReady: false, quality: qualityOf(v.quality, v.quality?.steps ?? []), ...extra }
}

describe('the home: ONE For you list, the baskets here, Coming next', () => {
  it('For you is newest first; a news line opened on this device is hidden, a waiting problem never', () => {
    const home = basketHome()
    const lists = homeOf(home, [])
    expect(lists.forYou.map((item) => item.kind)).toEqual(['CHANGED_DESIGN', 'ANSWER', 'PROBLEM'])
    const seen = home.forYou.map(seenKeyOf)
    expect(homeOf(home, seen).forYou.map((item) => item.kind)).toEqual(['PROBLEM'])
  })

  it('In this department: Do this first on top, then a problem, then the ones worked on, then by code', () => {
    expect(homeOf(basketHome(), []).here.map((row) => row.code)).toEqual(['B-0418', 'B-0409', 'B-0402', 'B-0431'])
  })

  it('Coming next is read only and sorted by code', () => {
    expect(homeOf(basketHome(), []).next.map((row) => row.code)).toEqual(['B-0433', 'B-0440'])
  })

  it('a phone opens its home at /floor, a tablet at /floor/baskets; a basket at /floor/basket/<code>', () => {
    expect(basketHomeOf('PHONE')).toBe('/floor')
    expect(basketHomeOf('STATION')).toBe('/floor/baskets')
    expect(basketPath('B-0431')).toBe('/floor/basket/B-0431')
  })

  it('the line after a Done is said once', () => {
    putFlash({ code: 'B-0431', to: null, moved: false, saved: false })
    expect(peekFlash()?.code).toBe('B-0431')
    clearFlash()
    expect(peekFlash()).toBeNull()
  })
})

describe('"seen" lives on the device only (lead settle 12)', () => {
  it('a key per kind, basket and time; news kinds only', () => {
    expect(seenKeyOf({ kind: 'ANSWER', bundleId: 'b1', at: 't1' })).toBe('ANSWER:b1:t1')
    expect(seenKeyOf({ kind: 'HANDOVER', bundleId: null, at: 't1' })).toBe('HANDOVER:-:t1')
    const items = [{ kind: 'ASK', bundleId: 'b1', at: 't1' }, { kind: 'SOLVED', bundleId: 'b1', at: 't1' }]
    expect(unseenForYou(items, ['ASK:b1:t1', 'SOLVED:b1:t1']).map((item) => item.kind)).toEqual(['ASK'])
  })

  it('keeps at most SEEN_KEPT keys, the oldest fall off; one person never reads another\'s', async () => {
    let keys: string[] = []
    for (let index = 0; index < SEEN_KEPT + 5; index++) keys = withSeen(keys, `k${index}`)
    expect(keys).toHaveLength(SEEN_KEPT)
    expect(keys[0]).toBe('k5')
    const store = memorySeenStore()
    await store.mark('w1', 'ANSWER:b1:t1')
    expect(await store.read('w1')).toEqual(['ANSWER:b1:t1'])
    expect(await store.read('w2')).toEqual([])
  })
})

describe('the step bar: "Step 4 / 6", the route\'s colours, "4 Stitching → 5 Quality"', () => {
  it('counts the step it is at and names the next', () => {
    const bar = stepBarOf(view(), 'en')
    expect([bar.at, bar.total, bar.now?.dept?.no, bar.next?.dept?.no, bar.ready, bar.own]).toEqual([4, 6, 4, 5, false, false])
    expect(bar.steps.map((step) => step.dept?.tone)).toEqual(['blue', 'orange', 'pink', 'cyan', 'purple', 'yellow'])
  })

  it('a skipped step is not counted; an own route says so; every step reported = ready to ship', () => {
    const steps = route(3).map((step) => (step.operationId === 'op-5' ? { ...step, state: 'SKIPPED' as const } : step))
    const bar = stepBarOf(view(basketRead({ route: { own: true, steps } })), 'en')
    expect([bar.at, bar.total, bar.next?.dept?.no, bar.own]).toEqual([4, 5, 6, true])
    const ready = stepBarOf(view(basketRead({ route: { own: false, steps: route(6) } })), 'en')
    expect([ready.at, ready.now, ready.next, ready.ready]).toEqual([null, null, null, true])
    expect(readyOf(route(6))).toBe(true)
  })

  it('waiting for its first step: the first step is where it is', () => {
    const bar = stepBarOf(view(basketRead({ route: { own: false, steps: route(0, 'NEXT') } })), 'en')
    expect([bar.at, bar.now?.dept?.no]).toEqual([1, 1])
  })

  it('a department in the page\'s language; a step with none says its name', () => {
    expect(deptOf(STITCHING, 'it')?.name).toBe('Stitching')
    expect(deptOf(null, 'en')).toBeNull()
  })
})

describe('the dock: ONE next action', () => {
  it('waiting: Start; paused: Resume', () => {
    expect(dockOf(input())).toEqual({ kind: 'start', resume: false })
    expect(dockOf(input(basketRead({ work: { state: 'PAUSED', mine: true } })))).toEqual({ kind: 'start', resume: true })
  })

  it('a hold: no Start, the reason (pick B)', () => {
    const dock = dockOf(input(basketRead({ hold: { kind: 'HOLD', words: 'The customer changes the collar.' } })))
    expect(dock).toEqual({ kind: 'hold', hold: 'HOLD', words: 'The customer changes the collar.' })
  })

  it('a changed design: "I saw the new design" comes before Start; once marked, Start', () => {
    expect(dockOf(input(basketRead(), { designPending: true })).kind).toBe('sawDesign')
    expect(dockOf(input(basketRead(), { designPending: false })).kind).toBe('start')
  })

  it('working: Pause beside Done (Pause only on the own work), Done shows where it goes', () => {
    expect(dockOf(input(basketRead({ work: { state: 'WORKING', mine: true } })))).toEqual({ kind: 'working', main: 'done', pause: true, held: false, back: null })
    expect(dockOf(input(basketRead({ work: { state: 'WORKING', mine: false } })))).toMatchObject({ kind: 'working', pause: false })
  })

  it('Quality: Passed is held until 8 of 8; "Not good: send back" goes to the step before', () => {
    const seven = dockOf(input(atQuality(7)))
    expect(seven).toMatchObject({ kind: 'working', main: 'passed', held: true })
    expect(seven.kind === 'working' ? seven.back?.operationId : null).toBe('op-4')
    expect(dockOf(input(atQuality(8)))).toMatchObject({ kind: 'working', main: 'passed', held: false })
    expect(dockOf(input(atQuality(8, { can: { start: true, done: true, moveForward: true, moveBack: false, route: false, give: false, flag: false, late: false } })))).toMatchObject({ back: null })
    expect(previousStepOf(view(atQuality(0)))?.department?.number).toBe(4)
  })

  it('the last step: Packed (Done makes it ready to ship)', () => {
    const last = basketRead({ route: { own: false, steps: route(5) }, work: { state: 'WORKING', mine: true }, next: { operationId: null, department: null } })
    expect(dockOf(input(last))).toMatchObject({ kind: 'working', main: 'packed' })
  })

  it('scanned in another department, on its route: Take it here; not on its route: no Take it here (settle 8)', () => {
    const onRoute = basketRead({ here: { departmentId: 'dept-3', sameDepartment: false, onRoute: true, takeHereOperationId: 'op-3' } })
    expect(dockOf(input(onRoute, { scanned: true }))).toEqual({ kind: 'takeHere', operationId: 'op-3' })
    const off = basketRead({ here: { departmentId: 'dept-9', sameDepartment: false, onRoute: false, takeHereOperationId: null } })
    expect(dockOf(input(off, { scanned: true }))).toEqual({ kind: 'offRoute' })
    expect(elsewhereOf(view(off))).toBe(true)
  })

  it('a team leader who opens it from a list gets Change the step, only once fl6\'s window exists (never a dead button)', () => {
    const elsewhere = basketRead({ here: { departmentId: 'dept-3', sameDepartment: false, onRoute: true, takeHereOperationId: 'op-3' } })
    expect(dockOf(input(elsewhere, { leader: true, scanned: false, stepsReady: false }))).toEqual({ kind: 'none' })
    expect(dockOf(input(elsewhere, { leader: true, scanned: false, stepsReady: true }))).toEqual({ kind: 'changeStep' })
    expect(dockOf(input(elsewhere, { leader: true, scanned: true }))).toEqual({ kind: 'takeHere', operationId: 'op-3' })
  })

  it('no department picked on the phone: the basket\'s own step (a phone scan opens its next step, settle 2)', () => {
    const none = basketRead({ here: { departmentId: null, sameDepartment: false, onRoute: true, takeHereOperationId: null } })
    expect(elsewhereOf(view(none))).toBe(false)
    expect(dockOf(input(none)).kind).toBe('start')
  })

  it('a restricted basket or one ready to ship: nothing to do', () => {
    expect(dockOf(input(basketRead({ restricted: 'RESTRICTED' })))).toEqual({ kind: 'none' })
    expect(dockOf(input(basketRead({ route: { own: false, steps: route(6) } })))).toEqual({ kind: 'none' })
  })

  it('the dock draws nothing for nothing; "Not on its route" alone only with fl8\'s ask', () => {
    const base: BasketDockModel = { dock: { kind: 'none' }, next: null, here: null, canAsk: false, busy: false, problem: null }
    expect(dockDraws(base)).toBe(false)
    expect(dockDraws({ ...base, dock: { kind: 'offRoute' } })).toBe(false)
    expect(dockDraws({ ...base, dock: { kind: 'offRoute' }, canAsk: true })).toBe(true)
    expect(dockDraws({ ...base, problem: 'That did not go through.' })).toBe(true)
  })
})

describe('the quality check', () => {
  it('counts the steps done of the required; a tick or a photo on this phone counts at once', () => {
    const read = atQuality(6)
    const steps = read.quality!.steps
    expect(qualityOf(read.quality, steps)).toEqual({ done: 6, total: 8, complete: false })
    expect(qualityOf(read.quality, stepDone(stepDone(steps, 'front'), 'back'))).toEqual({ done: 8, total: 8, complete: true })
    expect(qualityOf(read.quality, [])).toEqual({ done: 6, total: 8, complete: false })
    expect(qualityOf(null, [])).toBeNull()
  })
})

describe('the read', () => {
  it('a refusal comes with no basket: nothing to draw', () => {
    const refused = basketReadSchema.parse({ refusal: { code: 'NOT_AT_SITE', message: 'This basket is at another site.' } })
    expect(viewOf(refused)).toBeNull()
  })

  it('a whole read parses as it is; row flags take a yes/no or the object the server sends in its place', () => {
    expect(viewOf(basketReadSchema.parse(basketRead()))?.basket.code).toBe('B-0431')
    const home = basketHome()
    const row = { ...home.here[0]!, flags: { first: false, late: { days: 2, reason: 'MATERIAL' }, problem: null } }
    expect(basketHomeSchema.parse({ ...home, here: [row] }).here[0]!.flags).toEqual({ first: false, late: true, problem: false })
  })

  it('the floor face: a customer CODE, never a name; no money field', () => {
    const shape = JSON.stringify(basketReadSchema.parse(basketRead()))
    expect(shape).toContain('SEED-C1')
    expect(shape).not.toMatch(/price|cost|amount|partyName|customerName/i)
  })
})

describe('the phone\'s scan router and the Baskets tile (lead settle 9)', () => {
  const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
  const BUNDLE = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 431 })

  it('a basket\'s card on a phone opens its page; on a tablet the Operation screen stays (taskForScan)', () => {
    const read = readScan(BUNDLE, TAG)
    expect(basketPageFor('PHONE', read)).toBe(`/floor/basket/${encodeURIComponent(read.code)}`)
    expect(basketPageFor('STATION', read)).toBeNull()
    expect(basketPageFor('PHONE', readScan('WO-00001', TAG))).toBeNull()
  })

  it('a tablet gets ONE new tile, Baskets (production.scan), at the production stations, on the More page; a line tablet and a phone none', () => {
    const rule = TILE_RULES.find((entry) => entry.key === 'baskets')!
    expect(rule.permission).toBe('production.scan')
    expect(TASK_ROUTES.baskets).toBe('/floor/baskets')
    const all = ['floor.work', 'production.scan']
    expect(homeTiles('sewing', all, false).map((tile) => tile.key)).toContain('baskets')
    expect(homeTiles(null, all, false, 'LINE').map((tile) => tile.key)).not.toContain('baskets')
    const operator = ['floor.work', 'production.scan', 'plant.report']
    expect(tilePage(homeTiles('sewing', operator, false), 0).tiles.map((tile) => tile.key)).not.toContain('baskets')
    expect(homeTiles(null, all, false, 'PHONE').map((tile) => tile.key)).not.toContain('baskets')
    expect(homeTiles('warehouse', all, false).map((tile) => tile.key)).not.toContain('baskets')
    expect(FLOOR_NAMESPACES).toContain('floor-basket')
  })
})

// ---- the words ------------------------------------------------------------------------------------------------------------------

const DIR = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && !entry.name.endsWith('fixtures.ts') ? [path] : []
  })
}

describe('every word of the basket screens exists in it and en', () => {
  it('names only keys of floor-basket (literal and built)', () => {
    const keys = new Set<string>()
    for (const file of sources(DIR)) for (const match of readFileSync(file, 'utf8').matchAll(/\btb\(\s*'([A-Za-z0-9_.]+)'/g)) keys.add(match[1]!)
    const built = [
      ...WORK_STATES.map((state) => `state.${state}`),
      'state.READY',
      ...FOR_YOU_KINDS.map((kind) => `item.${kind}`),
      ...['HOLD', 'QUALITY_HOLD', 'FIRST_PIECE'].map((kind) => `needs.hold.${kind}`),
      ...['RESTRICTED', 'OTHER_TEAM'].map((kind) => `lock.${kind}`),
      ...['done', 'passed', 'packed', 'start', 'resume'].map((main) => `dock.${main}`),
      ...['noStation', 'offline', 'failed'].map((problem) => `dept.${problem}`),
    ]
    const has = (key: string) => LOCALES.every((locale) => {
      const words = CATALOGUE[locale]['floor-basket'] ?? {}
      return key in words || (`${key}_one` in words && `${key}_other` in words)
    })
    expect(keys.size).toBeGreaterThan(40)
    expect([...keys, ...built].filter((key) => !has(key))).toEqual([])
  })
})

// ---- the render: 390 px, both languages, no key left, the dock in the frame's sticky foot ----------------------------------------

const draw = (element: ReactElement, locale: (typeof LOCALES)[number]) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['floor', 'floor-basket']) }, element))
const LEFT_KEY = /(?:^|[\s>"])(?:homePage|item|state|flag|dept|page|facts|needs|lock|stepBar|dock|elsewhere|qc)\.[a-zA-Z]+/

const pageModel = (read = basketRead(), extra: Partial<BasketPageViewModel> = {}): BasketPageViewModel => {
  const v = view(read)
  const quality = qualityOf(v.quality, v.quality?.steps ?? [])
  const dock = dockOf({ view: v, scanned: false, leader: false, designPending: false, stepsReady: STEPS_READY, quality })
  return {
    frame: { ...FRAME, title: 'Basket B-0431' },
    state: 'ready',
    refusal: null,
    read,
    view: v,
    bar: stepBarOf(v, 'en'),
    readAt: 0,
    speechLang: 'en-GB',
    scanned: false,
    leader: false,
    stepsReady: STEPS_READY,
    helpReady: HELP_READY,
    designWords: null,
    designPending: false,
    elsewhere: elsewhereOf(v),
    dock: { dock, next: deptOf(v.next.department, 'en'), here: null, canAsk: HELP_READY, busy: false, problem: null },
    qc: dock.kind === 'working' && quality ? { steps: v.quality?.steps ?? [], progress: quality, back: null, busy: false } : null,
    stepsOpen: false,
    askOpen: false,
    photo: null,
    online: true,
    ...extra,
  }
}

describe('the basket page at 390 px', () => {
  for (const locale of LOCALES) {
    it(`draws in ${locale} with no key left; the dock is the frame's foot (on the first screen)`, () => {
      const html = draw(createElement(BasketPageView, { model: pageModel(), onAction: () => undefined }), locale)
      expect(html.match(LEFT_KEY)?.[0] ?? null).toBeNull()
      const foot = html.indexOf('nds-floor-frame-actions')
      expect(foot).toBeGreaterThan(0)
      expect(html.indexOf(CATALOGUE[locale]['floor-basket']!['dock.start']!, foot)).toBeGreaterThan(foot)
      expect(html).toContain('<bdi>B-0431</bdi>')
      expect(html).toContain('SEED-C1')
    })
  }

  it('at Quality the card lists the points and the photos; Passed is held with its reason on screen', () => {
    const html = draw(createElement(BasketPageView, { model: pageModel(atQuality(7)), onAction: () => undefined }), 'en')
    expect(html).toContain('Quality check')
    expect(html).toContain('7 / 8')
    expect(html).toContain('First tick the points and take the photos.')
    expect(html).toContain('aria-disabled="true"')
  })

  it('the step bar says "Change" only once fl6\'s window exists; until fl8 no tile row', () => {
    const html = draw(createElement(BasketPageView, { model: pageModel(basketRead()), onAction: () => undefined }), 'en')
    if (STEPS_READY) expect(html).toContain('Change')
    else expect(html).not.toContain('>Change<')
    if (!HELP_READY) expect(html).not.toContain('fw-bk-tiles')
  })

  it('a dock with Pause and Done keeps them in ONE row', () => {
    const model: BasketDockModel = { dock: { kind: 'working', main: 'done', pause: true, held: false, back: null }, next: deptOf(QUALITY, 'en'), here: null, canAsk: false, busy: false, problem: null }
    const html = draw(createElement(BasketDock, { model, onAction: () => undefined }), 'en')
    expect(html).toContain('fw-bk-dock-row is-two')
    expect(html).toContain('Pause')
    expect(html).toContain('Quality')
  })
})

describe('the basket home at 390 px', () => {
  const homeModel = (extra: Partial<BasketHomeViewModel> = {}): BasketHomeViewModel => ({
    frame: FRAME,
    pick: { current: deptOf(STITCHING, 'en'), open: false, departments: [STITCHING, QUALITY, PACKING].map((look) => deptOf(look, 'en')!), stations: null, problem: null, busy: false },
    state: 'ready',
    lists: homeOf(basketHome(), []),
    locale: 'en',
    readAt: 0,
    flash: null,
    jobs: ['clock', 'incident'],
    ...extra,
  })

  for (const locale of LOCALES) {
    it(`draws in ${locale}: For you, the scan, the baskets here, Coming next, other jobs; no key left`, () => {
      const html = draw(createElement(BasketHomeView, { model: homeModel(), onAction: () => undefined }), locale)
      expect(html.match(LEFT_KEY)?.[0] ?? null).toBeNull()
      const words = CATALOGUE[locale]['floor-basket']!
      const order = ['homePage.forYou', 'homePage.scan', 'homePage.here', 'homePage.next', 'homePage.otherJobs'].map((key) => html.indexOf(words[key]!))
      expect(order.every((at) => at > 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    })
  }

  it('an empty department says what it is and the next step; no department says to pick one', () => {
    const empty = draw(createElement(BasketHomeView, { model: homeModel({ lists: { forYou: [], here: [], next: [] } }), onAction: () => undefined }), 'en')
    expect(empty).toContain('No basket here now. Scan a basket card to start.')
    const none = draw(createElement(BasketHomeView, { model: homeModel({ lists: { forYou: [], here: [], next: [] }, pick: { ...homeModel().pick, current: null } }), onAction: () => undefined }), 'en')
    expect(none).toContain('Pick your department first')
  })
})
