import { existsSync, mkdirSync } from 'node:fs'
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type { Flow } from './flow'
import { answerOf, dialog, press } from './ui'

/**
 * The floor of the browser golden flow (B-W1-06): the tablets (one browser context each, 1024×768, its own device
 * cookie and IndexedDB queue) enrolled through the office (Admin › Devices: the admin makes the set-up link, the tablet
 * opens it), the floor workers made in Admin › Users (badge and temporary PIN, a fresh code for the step-up), and the
 * worker's sign-in on the tablet: the badge scanned like a scanner (a fast burst + Enter), the PIN on the pad, a PIN of
 * their own the first time, then the worker notice read and acknowledged. Everything in English (the worker's language).
 *
 * The admin does the set-up: the floor_supervisor template holds neither companies.view, sites.view nor roles.view, so
 * Devices and Users hold "Enrol a device" and "Add floor worker" for it ("Add a site first") — a gap of the role, not of
 * the screens (noted in the stage reports).
 */

export interface TabletSpec {
  /** The station's code (CUT-01 …), or null for the site's warehouse tablet (no station). */
  readonly station: string | null
  readonly name: string
}
export interface WorkerSpec {
  readonly name: string
  /** Role cards to tick in "Add floor worker" (their names start with these words). */
  readonly roles: readonly string[]
  /** The PIN the worker chooses at the first sign-in. */
  readonly pin: string
}
export interface FloorWorker extends WorkerSpec {
  readonly key: string
  readonly id: string
  readonly badge: string
  readonly tempPin: string
}
export interface Tablet {
  readonly key: string
  readonly context: BrowserContext
  readonly page: Page
}

export const TABLETS = {
  WH: { station: null, name: 'Warehouse tablet A1' },
  CUT: { station: 'CUT-01', name: 'Tablet · Cutting table 1' },
  SEW: { station: 'SEW-01', name: 'Tablet · Sewing station 1' },
  QC: { station: 'QC-01', name: 'Tablet · Inspection bench 1' },
  PACK: { station: 'PACK-01', name: 'Tablet · Packing bench 1' },
} as const satisfies Record<string, TabletSpec>

export const WORKERS = {
  wh: { name: 'Walter Wh Golden', roles: ['Operator'], pin: '481537' },
  cutter: { name: 'Carla Cutter Golden', roles: ['Operator'], pin: '592648' },
  sewer: { name: 'Sergio Sewer Golden', roles: ['Operator'], pin: '603759' },
  qc: { name: 'Quinto Qc Golden', roles: ['Operator'], pin: '714860' },
  packer: { name: 'Pia Packer Golden', roles: ['Operator'], pin: '825971' },
  bench: { name: 'Ilaria Bench Golden', roles: ['Floor inspector', 'Team leader'], pin: '936182' },
} as const satisfies Record<string, WorkerSpec>

const tablets = new Map<string, Tablet>()

function floorState(flow: Flow): { tablets: Record<string, { deviceId: string }>; workers: Record<string, FloorWorker>; signedOnce: string[] } {
  return (flow.state.floor ??= { tablets: {}, workers: {}, signedOnce: [] })
}

/** The tablet `key`, enrolled once through Admin › Devices; its cookies and queue kept for an --attach run. */
export async function tablet(flow: Flow, key: keyof typeof TABLETS): Promise<Tablet> {
  const known = tablets.get(key)
  if (known) return known
  const saved = `${flow.out}/tablets/${key}.json`
  const state = floorState(flow)
  const enrolled = state.tablets[key] && process.env.FACTORY_BGF_RESUME === '1' && existsSync(saved)
  const { context, page } = await flow.tabletContext(key, enrolled ? saved : undefined)
  const made: Tablet = { key, context, page }
  tablets.set(key, made)
  flow.onClose(async () => {
    mkdirSync(`${flow.out}/tablets`, { recursive: true })
    await context.storageState({ path: saved, indexedDB: true }).catch(() => {})
  })
  if (!enrolled) await enrol(flow, made, TABLETS[key])
  return made
}

async function enrol(flow: Flow, tablet: Tablet, spec: TabletSpec): Promise<void> {
  const admin = await flow.desk('admin')
  const { page } = admin
  await admin.go('/admin/devices?enrol=1')
  const form = dialog(page)
  await form.getByRole('combobox', { name: 'Site', exact: true }).selectOption({ label: 'Seed plant A1' })
  if (spec.station) {
    const station = form.getByRole('combobox', { name: 'Station', exact: true })
    const label = (await station.locator('option').allInnerTexts()).find((text) => text.trim().startsWith(`${spec.station} · `))
    if (!label) throw new Error(`no station ${spec.station} in the enrolment dialog`)
    await station.selectOption({ label: label.trim() })
  }
  const name = form.getByRole('textbox', { name: 'Name', exact: true })
  await name.fill(spec.name)
  const answer = await answerOf(page, 'POST', /^\/auth\/floor\/devices$/, () => press(form.getByRole('button', { name: 'Create enrolment code' })))
  const url = new URL(answer.enrolment.url as string)
  floorState(flow).tablets[tablet.key] = { deviceId: answer.device.id as string }
  await tablet.page.goto(`/floor/enrol${url.hash}`)
  await press(tablet.page.getByRole('button', { name: 'Continue' }))
  await press(tablet.page.getByRole('button', { name: 'Continue' }))
  await expect(tablet.page.getByText('Ready').first()).toBeVisible()
  await press(tablet.page.getByRole('button', { name: 'Go to sign-in' }))
  await expect(form.getByText(/is ready$/).first()).toBeVisible({ timeout: 30_000 })
  await press(form.getByRole('button', { name: 'Done' }))
  await flow.shot(tablet.page, `enrolled-${tablet.key}`)
}

/** The floor worker `key`, made once in Admin › Users with a badge and a temporary PIN (the admin answers the step-up). */
export async function worker(flow: Flow, key: keyof typeof WORKERS): Promise<FloorWorker> {
  const state = floorState(flow)
  if (state.workers[key]) return state.workers[key]!
  const spec = WORKERS[key]
  const admin = await flow.desk('admin')
  const { page } = admin
  await admin.go('/admin/users?audience=floor&new=worker')
  const form = dialog(page)
  await form.getByRole('combobox', { name: 'Site', exact: true }).selectOption({ label: 'Seed plant A1' })
  await form.getByRole('combobox', { name: 'Language on the tablet', exact: true }).selectOption({ label: 'English' })
  for (const role of spec.roles) await form.getByRole('checkbox', { name: new RegExp(`^${role}\\b`) }).check()
  // The name last: the form settles its site and roles first (a name typed at once is lost while it loads).
  const name = form.getByRole('textbox', { name: 'Name', exact: true })
  await expect(async () => {
    await name.fill(spec.name)
    await expect(name).toHaveValue(spec.name, { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  const made = await answerOf(page, 'POST', /^\/auth\/floor\/workers$/, async () => {
    await press(form.getByRole('button', { name: 'Add worker' }))
    await flow.stepUp(page, admin.person, 6_000)
  })
  const id = (made.worker?.id ?? made.id) as string
  await admin.go(`/admin/users/floor/${id}?tab=badge`)
  await press(page.getByRole('button', { name: 'Issue badge' }).first())
  const badge = await answerOf(page, 'POST', /\/badges$/, async () => {
    await press(dialog(page).getByRole('button', { name: 'Issue badge' }))
    await flow.stepUp(page, admin.person, 3_000)
  })
  await dialog(page).getByRole('checkbox', { name: 'I printed the badge' }).check()
  await press(dialog(page).getByRole('button', { name: 'Done' }))
  await press(page.getByRole('button', { name: 'Reset PIN' }).first())
  const reset = await answerOf(page, 'POST', /\/pin-reset$/, async () => {
    await press(dialog(page).getByRole('button', { name: 'Reset PIN' }))
    await flow.stepUp(page, admin.person, 3_000)
  })
  await dialog(page).getByRole('checkbox', { name: 'I gave the PIN to the worker' }).check()
  await press(dialog(page).getByRole('button', { name: 'Done' }))
  const made_: FloorWorker = { key, ...spec, id, badge: badge.code as string, tempPin: reset.pin as string }
  state.workers[key] = made_
  flow.save()
  return made_
}

/** The tablet's Home (its tiles), from wherever it is; a floor step starts here. */
export async function home(page: Page): Promise<void> {
  await page.goto('/floor')
  await expect(page.getByRole('group', { name: 'What you can do here' })).toBeVisible({ timeout: 60_000 })
}

/** Opens a tile of Home by the start of its name (a tile's name is its label and its hint), and lets the task settle. */
export async function tile(page: Page, label: string): Promise<void> {
  await home(page)
  await press(page.getByRole('group', { name: 'What you can do here' }).getByRole('button', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first())
  await page.waitForURL((url) => url.pathname !== '/floor')
  await page.locator('input.nds-floor-scan-input:visible').first().waitFor()
  await quiet(page)
}

/** Waits until the page has asked the API nothing for a moment (a task reads its lists as it opens). */
export async function quiet(page: Page, ms = 700): Promise<void> {
  let inflight = 0
  let last = Date.now()
  const start = (request: import('@playwright/test').Request) => {
    if (request.url().includes('/api/')) (inflight += 1), (last = Date.now())
  }
  const end = (request: import('@playwright/test').Request) => {
    if (request.url().includes('/api/')) (inflight = Math.max(0, inflight - 1)), (last = Date.now())
  }
  page.on('request', start)
  page.on('requestfinished', end)
  page.on('requestfailed', end)
  try {
    const until = Date.now() + 20_000
    while ((inflight > 0 || Date.now() - last < ms) && Date.now() < until) await page.waitForTimeout(100)
  } finally {
    page.off('request', start)
    page.off('requestfinished', end)
    page.off('requestfailed', end)
  }
}

/**
 * A scan into the screen's scan field: the code lands at once and Enter follows, as a wedge scanner sends it (`burst`:
 * typed key by key, fast, for the badge field, which refuses a typed code).
 */
export async function scan(page: Page, code: string, options: { burst?: boolean; field?: string; orWedge?: boolean } = {}): Promise<void> {
  const field = options.field ? page.getByRole('textbox', { name: options.field, exact: true }) : page.locator('input.nds-floor-scan-input:visible').first()
  if (options.orWedge && !(await field.isVisible())) {
    // No scan field on screen (a card is open): the screen's wedge reader takes a scanner's burst anywhere.
    await page.keyboard.type(code, { delay: 5 })
    await page.keyboard.press('Enter')
    return
  }
  await field.waitFor({ state: 'visible' })
  await field.focus()
  if (options.burst) await page.keyboard.type(code, { delay: 5 })
  else await field.fill(code)
  await field.press('Enter')
}

/**
 * A scan that must take the screen somewhere (`until` shows): sent again while it does not, as a worker scans again when
 * a freshly opened screen was not listening yet.
 */
export async function scanUntil(page: Page, code: string, until: Locator, options: { field?: string; orWedge?: boolean } = {}): Promise<void> {
  await expect(async () => {
    await scan(page, code, options)
    await expect(until.first()).toBeVisible({ timeout: 4_000 })
  }).toPass({ timeout: 45_000 })
}

/** Digits on the pad, as a hand types them (fast keys would read as a scanner's burst). */
export async function typePin(page: Page, pin: string): Promise<void> {
  for (const digit of pin) {
    await page.keyboard.press(digit)
    await page.waitForTimeout(150)
  }
}

/** The worker signs in on the tablet; the first time with the temporary PIN, a PIN of their own, the notice read. */
export async function signIn(flow: Flow, tablet: Tablet, who: FloorWorker): Promise<void> {
  const { page } = tablet
  const state = floorState(flow)
  await page.goto('/floor')
  const home = page.getByRole('group', { name: 'What you can do here' })
  const badgeStep = page.getByText('Scan your badge').first()
  await expect(home.or(badgeStep).first()).toBeVisible({ timeout: 60_000 })
  if (await home.isVisible()) {
    const chip = page.getByRole('button', { name: /: sign out, switch person or language$/ })
    if ((await chip.getAttribute('aria-label').catch(() => null))?.startsWith(who.name) || (await chip.innerText().catch(() => '')).includes(who.name)) {
      if ((await page.locator('[aria-description="Read the notice first"]').count()) > 0) {
        await page.goto('/floor/notice')
        await acknowledgeNotice(page)
      }
      return
    }
    // Someone else is signed in: they sign out first (the operator chip's menu).
    await chip.click()
    await page.getByRole('menuitem', { name: 'Sign out' }).or(page.getByRole('button', { name: 'Sign out', exact: true })).first().click()
    await expect(badgeStep).toBeVisible()
  }
  await scan(page, who.badge, { burst: true })
  await expect(page.getByText('Type your PIN').first()).toBeVisible()
  const first = !state.signedOnce.includes(who.key)
  await typePin(page, first ? who.tempPin : who.pin)
  if (first) {
    await expect(page.getByText('Type a new PIN').first()).toBeVisible()
    await typePin(page, who.pin)
    await expect(page.getByText('Type the new PIN again').first()).toBeVisible()
    await typePin(page, who.pin)
    state.signedOnce.push(who.key)
    flow.save()
  }
  const notice = page.getByRole('button', { name: 'I have read it' }).or(page.getByRole('button', { name: 'Next', exact: true })).first()
  await expect(home.or(notice).first()).toBeVisible({ timeout: 30_000 })
  if (!(await home.isVisible())) await acknowledgeNotice(page)
  await expect(home).toBeVisible()
}

/** The worker notice, page by page, then "I have read it" (the scans wait for it). */
async function acknowledgeNotice(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'I have read it' }).or(page.getByRole('button', { name: 'Next', exact: true })).first()).toBeVisible()
  for (let turn = 0; turn < 30 && !(await page.getByRole('button', { name: 'I have read it' }).isVisible()); turn++) await press(page.getByRole('button', { name: 'Next', exact: true }))
  await answerOf(page, 'POST', /^\/privacy\/floor\/notice\/acknowledge$/, () => press(page.getByRole('button', { name: 'I have read it' })))
  await press(page.getByRole('button', { name: 'Go to Home' }))
  await expect(page.getByRole('group', { name: 'What you can do here' })).toBeVisible()
}

/** Every queued floor action of the tablet recorded by the office (the dev build's queue; the screen says the same). */
export async function drained(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const queue = (window as unknown as { __nexusFloorQueue?: { getSnapshot(): { ready: boolean; sending: boolean; items: { state: string }[] } } }).__nexusFloorQueue
      const snapshot = queue?.getSnapshot()
      return Boolean(snapshot?.ready && !snapshot.sending && snapshot.items.every((item) => item.state === 'recorded' || item.state === 'discarded'))
    },
    undefined,
    { timeout: 60_000 },
  )
}

/** How many actions wait in the tablet's queue. */
export async function waiting(page: Page): Promise<number> {
  return page.evaluate(() => {
    const queue = (window as unknown as { __nexusFloorQueue?: { getSnapshot(): { items: { state: string }[] } } }).__nexusFloorQueue
    return queue?.getSnapshot().items.filter((item) => item.state === 'waiting').length ?? -1
  })
}
