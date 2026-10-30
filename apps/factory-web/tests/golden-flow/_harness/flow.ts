import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { words } from './words'

/**
 * The browser golden flow's world on the browser side (B-W1-06): the stack's control endpoint (stack.ts), the people
 * and their office contexts (one browser context per person, desktop size, signed in through the sign-in screen with
 * the password and the authenticator code), the link contexts (the customer and the supplier on a phone, opening the
 * link the FAKE mailbox holds), the floor contexts (one tablet each, 1024×768), what every context asked the API (for
 * the end checks), screenshots and traces outside the repository, and the flow's state (ids and numbers) that the
 * stages hand on. Every context speaks English (`factory_locale=en`, people and workers with locale en).
 */

type Json = Record<string, any>
export type ContextKind = 'office' | 'link' | 'floor'

/** The office people of the flow and their role templates (the API golden flow's nine). */
export const ROLES = {
  sales: 'sales',
  finance: 'finance',
  planner: 'planner',
  buyer: 'buyer',
  warehouse: 'warehouse',
  manager: 'production_manager',
  inspector: 'quality_inspector',
  supervisor: 'floor_supervisor',
  admin: 'admin',
} as const
export type PersonKey = keyof typeof ROLES
const NAMES: Record<PersonKey, string> = {
  sales: 'Sara Sales',
  finance: 'Franco Finance',
  planner: 'Paola Planner',
  buyer: 'Bruno Buyer',
  warehouse: 'Walter Warehouse',
  manager: 'Marta Manager',
  inspector: 'Ines Inspector',
  supervisor: 'Silvio Supervisor',
  admin: 'Ada Admin',
}

export const TENANT = 'golden'
export const COMPANY = 'SCA'

export interface Person {
  readonly key: PersonKey
  readonly id: string
  readonly email: string
  readonly password: string
  readonly role: string
}

/** What one context asked the API through the web (`/api/…`), for the end checks. */
export interface Capture {
  readonly stage: string
  readonly kind: ContextKind
  readonly context: string
  readonly method: string
  readonly path: string
  readonly status: number
  readonly requestId: string | null
  /** The write's Idempotency-Key: a repeat with the same key answers from the first one's receipt (and its audit rows). */
  readonly idempotencyKey: string | null
  readonly body?: unknown
}

export interface Desk {
  readonly person: Person
  readonly context: BrowserContext
  readonly page: Page
  /** Opens an office page of company A: `/w/SCA<path>`. */
  go(path: string): Promise<void>
}

export interface Visitor {
  readonly name: string
  readonly context: BrowserContext
  readonly page: Page
}

/** A FACTORY_BGF_ value the runner passes (scripts/factory/browser-golden-flow.mjs). */
const required = (name: string, value: string | undefined): string => {
  if (!value) throw new Error(`${name} is not set: run the flow with node scripts/factory/browser-golden-flow.mjs`)
  return value
}

export class Flow {
  readonly web = required('FACTORY_BGF_WEB', process.env.FACTORY_BGF_WEB)
  readonly controlUrl = required('FACTORY_BGF_CONTROL', process.env.FACTORY_BGF_CONTROL)
  readonly adminUrl = required('FACTORY_BGF_ADMIN_URL', process.env.FACTORY_BGF_ADMIN_URL)
  readonly out = required('FACTORY_BGF_OUT', process.env.FACTORY_BGF_OUT)
  /** What the stages made (ids, numbers, versions), handed from stage to stage. */
  readonly state: Json = {}
  readonly captures: Capture[] = []
  readonly problems: string[] = []
  readonly companyId: string
  /** When the flow began (kept across an --attach run: the end checks look at what the run made since). */
  readonly startedAt: Date
  stage = '00'
  private shots = 0
  private readonly people = new Map<PersonKey, Person>()
  private readonly desks = new Map<PersonKey, Desk>()
  private readonly visitors = new Map<string, Visitor>()
  private readonly contexts: { name: string; context: BrowserContext }[] = []
  private readonly closing: (() => Promise<void>)[] = []

  private constructor(
    readonly browser: Browser,
    ready: Json,
  ) {
    this.companyId = ready.companies.A.id
    const saved = process.env.FACTORY_BGF_RESUME === '1' && existsSync(`${this.out}/state.json`) ? (JSON.parse(readFileSync(`${this.out}/state.json`, 'utf8')) as Json) : null
    Object.assign(this.state, saved?.state ?? {})
    // An --attach run adds to what the earlier runs on this stack captured (the end checks read all of it).
    if (saved && existsSync(`${this.out}/captures.json`)) this.captures.push(...(JSON.parse(readFileSync(`${this.out}/captures.json`, 'utf8')) as Capture[]))
    this.startedAt = new Date(saved?.startedAt ?? Date.now())
    mkdirSync(`${this.out}/shots`, { recursive: true })
    mkdirSync(`${this.out}/traces`, { recursive: true })
  }

  static async open(browser: Browser): Promise<Flow> {
    const answer = await fetch(`${required('FACTORY_BGF_CONTROL', process.env.FACTORY_BGF_CONTROL)}/ready`)
    if (!answer.ok) throw new Error(`the stack's control endpoint answers ${answer.status}`)
    return new Flow(browser, (await answer.json()) as Json)
  }

  // ---- the stack ---------------------------------------------------------------------------------------------------------

  async control<T = Json>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const answer = await fetch(`${this.controlUrl}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
    const parsed = (await answer.json()) as Json
    if (!answer.ok) throw new Error(`control ${method} ${path}: ${parsed.error ?? answer.status}`)
    return parsed as T
  }

  /** A seed row's id (seedUuid of the `golden` namespace), e.g. `site:A1`, `party:P2`. */
  async seedId(key: string): Promise<string> {
    return (await this.control<{ id: string }>('GET', `/id?key=${encodeURIComponent(key)}`)).id
  }

  /** Waits until the worker has handled everything the screens set off; a handler that failed its last try fails the stage. */
  async settle(): Promise<void> {
    const { failures } = await this.control<{ failures: string[] }>('POST', '/settle', {})
    expect(failures, 'the worker’s handlers that failed their last try').toEqual([])
  }

  /** The link the FAKE mailbox holds for an address (the newest after `after` mails to it). */
  async linkSentTo(to: string, after = 0): Promise<{ url: string; token: string; templateKey: string; index: number }> {
    return this.control('GET', `/link?to=${encodeURIComponent(to)}&after=${after}`)
  }

  async mailsTo(to: string): Promise<number> {
    return (await this.control<{ mails: unknown[] }>('GET', `/mails?to=${encodeURIComponent(to)}`)).mails.length
  }

  // ---- people ------------------------------------------------------------------------------------------------------------

  async person(key: PersonKey): Promise<Person> {
    let found = this.people.get(key)
    if (!found) {
      found = await this.control<Person>('POST', '/people', { key, role: ROLES[key], displayName: NAMES[key] })
      this.people.set(key, found)
    }
    return found
  }

  /** The person's next authenticator code (the stack computes it from the secret it set up; never stored here). */
  async code(person: Person): Promise<string> {
    return (await this.control<{ code: string }>('POST', '/totp', { email: person.email })).code
  }

  /** The person's office context, signed in through the sign-in screen (password, then the authenticator code). */
  async desk(key: PersonKey): Promise<Desk> {
    const known = this.desks.get(key)
    if (known) return known
    const person = await this.person(key)
    const context = await this.newContext(`office-${key}`, 'office', { viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const desk: Desk = {
      person,
      context,
      page,
      go: async (path) => {
        await page.goto(`/w/${COMPANY}${path}`)
      },
    }
    await this.signIn(desk)
    this.desks.set(key, desk)
    return desk
  }

  async signIn(desk: Desk): Promise<void> {
    const t = words('auth')
    const { page, person } = desk
    await page.goto('/sign-in')
    await page.getByLabel(t('signIn.company'), { exact: true }).fill(TENANT)
    await page.getByLabel(t('signIn.email'), { exact: true }).fill(person.email)
    await page.getByLabel(t('signIn.password'), { exact: true }).fill(person.password)
    await page.getByRole('button', { name: t('signIn.submit'), exact: true }).click()
    const code = page.getByLabel(t('code.app'), { exact: true })
    await code.waitFor({ state: 'visible' })
    await code.fill(await this.code(person))
    await page.getByRole('button', { name: t('code.submit'), exact: true }).click()
    await page.waitForURL(/\/w\/[^/]+/, { timeout: 60_000 })
  }

  /**
   * Answers the office step-up (the design system's StepUpModal: "Two-factor code") with the person's next code, when it
   * opens within `waitMs`. Returns whether it was asked.
   */
  async stepUp(page: Page, person: Person, waitMs = 8_000): Promise<boolean> {
    const field = page.getByLabel('Two-factor code')
    try {
      await field.waitFor({ state: 'visible', timeout: waitMs })
    } catch {
      return false
    }
    await field.fill(await this.code(person))
    await field.press('Enter')
    await field.waitFor({ state: 'hidden', timeout: 30_000 })
    return true
  }

  // ---- links and tablets ---------------------------------------------------------------------------------------------------

  /** A link's visitor (the customer, the supplier): a phone-sized context of its own that opens the mailed link. */
  async visitor(name: string, url: string): Promise<Visitor> {
    const context = await this.newContext(`link-${name}-${this.visitors.size + 1}`, 'link', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    await page.goto(url.replace(/^https?:\/\/[^/]+/, this.web))
    const visitor = { name, context, page }
    this.visitors.set(`${name}-${this.visitors.size + 1}`, visitor)
    return visitor
  }

  /** A tablet's context (its own cookies: its own device token), 1024×768, with its IndexedDB queue. */
  async tabletContext(name: string, storageState?: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await this.newContext(`floor-${name}`, 'floor', { viewport: { width: 1024, height: 768 }, hasTouch: true, ...(storageState ? { storageState } : {}) })
    return { context, page: await context.newPage() }
  }

  /** Work for the end of the run, before the contexts close (a tablet keeps its state for an --attach run). */
  onClose(work: () => Promise<void>): void {
    this.closing.push(work)
  }

  private async newContext(name: string, kind: ContextKind, options: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
    const context = await this.browser.newContext({ baseURL: this.web, locale: 'en-GB', timezoneId: 'Europe/Rome', colorScheme: 'light', ...options })
    await context.addCookies([{ name: 'factory_locale', value: 'en', url: this.web }])
    await context.tracing.start({ screenshots: true, snapshots: true, title: name })
    this.contexts.push({ name, context })
    context.on('response', (response) => {
      const url = new URL(response.url())
      if (!url.pathname.startsWith('/api/')) return
      const method = response.request().method()
      const type = response.headers()['content-type'] ?? ''
      const status = response.status()
      const path = `${url.pathname.slice(4)}${url.search}`
      const record = (body?: unknown) =>
        this.captures.push({ stage: this.stage, kind, context: name, method, path, status, requestId: response.headers()['x-request-id'] ?? null, idempotencyKey: response.request().headers()['idempotency-key'] ?? null, ...(body === undefined ? {} : { body }) })
      // Floor and link answers are kept whole: the end checks look for cost, margin and price fields in them. Of the office
      // answers only the sign-in's (its first step, the password, writes nothing and asks for the code).
      if ((kind !== 'office' || url.pathname === '/api/auth/office/sign-in') && type.includes('application/json')) {
        response.json().then(record, () => record())
      } else record()
    })
    context.on('page', (page) => this.watch(name, page))
    return context
  }

  private watch(name: string, page: Page): void {
    page.on('pageerror', (error) => this.problems.push(`${this.stage} ${name}: page error: ${error.message}`))
  }

  // ---- calls, shots, state -----------------------------------------------------------------------------------------------

  /** A read through the web's API proxy with the context's own session (assertions only; the screens do the work). */
  async read(page: Page, path: string, headers: Record<string, string> = {}): Promise<Json> {
    const answer = await page.request.get(`/api${path}`, { headers: { 'x-factory-company': COMPANY, ...headers } })
    expect(answer.status(), `GET ${path}: ${await answer.text()}`).toBe(200)
    return (await answer.json()) as Json
  }

  /** A write through the proxy (only where a stage says no screen does it), with the CSRF header and an Idempotency-Key. */
  async write(page: Page, method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown, status = 200): Promise<Json> {
    const csrf = (await page.context().cookies(this.web)).find((cookie) => cookie.name === '__Host-factory_csrf')?.value ?? ''
    const answer = await page.request.fetch(`/api${path}`, { method, data: body, headers: { 'x-factory-company': COMPANY, 'x-csrf-token': csrf, 'idempotency-key': `bgf-${randomUUID()}` } })
    expect(answer.status(), `${method} ${path}: ${await answer.text()}`).toBe(status)
    return (await answer.json()) as Json
  }

  /** A screenshot of the page, named after the stage, kept outside the repository. */
  async shot(page: Page, name: string): Promise<void> {
    this.shots += 1
    await page.screenshot({ path: `${this.out}/shots/${this.stage}-${String(this.shots).padStart(3, '0')}-${name}.png`, fullPage: true }).catch(() => {})
  }

  /**
   * One named step of a stage (Playwright's report shows it; a failing step leaves a screenshot of every open page). Its
   * result is kept in the state: an --attach run (FACTORY_BGF_RESUME) skips the steps that passed and hands back what
   * they returned, so work on a later step does not walk the earlier ones again.
   */
  async step<T>(title: string, work: () => Promise<T>): Promise<T> {
    const key = `${this.stage} / ${title}`
    const done = (this.state.steps ??= {}) as Record<string, { value: unknown }>
    if (process.env.FACTORY_BGF_RESUME === '1' && key in done) return done[key]!.value as T
    return test.step(title, async () => {
      try {
        const value = await work()
        done[key] = { value: value ?? null }
        this.save()
        return value
      } catch (error) {
        for (const { name, context } of this.contexts) {
          for (const [index, page] of context.pages().entries()) {
            await page.screenshot({ path: `${this.out}/shots/${this.stage}-FAILED-${name}-${index}.png`, fullPage: true }).catch(() => {})
          }
        }
        throw error
      }
    })
  }

  save(): void {
    writeFileSync(`${this.out}/state.json`, JSON.stringify({ stage: this.stage, startedAt: this.startedAt.toISOString(), state: this.state, problems: this.problems }, null, 2))
  }

  async close(): Promise<void> {
    for (const work of this.closing) await work().catch(() => {})
    this.save()
    writeFileSync(`${this.out}/captures.json`, JSON.stringify(this.captures))
    for (const { name, context } of this.contexts) {
      await context.tracing.stop({ path: `${this.out}/traces/${name}.zip` }).catch(() => {})
      await context.close().catch(() => {})
    }
  }
}

/** Waits for a locator to be visible and returns it (a short form for the stages). */
export async function seen(locator: Locator, timeout = 30_000): Promise<Locator> {
  await locator.first().waitFor({ state: 'visible', timeout })
  return locator.first()
}
