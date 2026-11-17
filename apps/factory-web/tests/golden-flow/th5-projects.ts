import { expect, test, type Page } from '@playwright/test'
import { BRAND_ALPHA, BRAND_BETA, type BrandFixture } from '../../src/lib/testing/two-brands'
import { expectNothingOf, pageWords } from './_harness/brand-scan'
import { seen, type Desk, type Flow } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { ensureBrand, signInToPortal, type PortalDesk } from './_harness/two-brands'
import { day, pickDate } from './_harness/ui'
import { words } from './_harness/words'

/**
 * B-TH-254 — UI golden flow TH-5 (threads plan; PROJ.record, PROJ.portal; wall W38, T00 at the screen level — the screens' twin of
 * the API's golden flow B-TH-074, golden-flow/threads/th5.pg.vitest.test.ts). On the local stack the browser golden flow starts (its
 * own throwaway database, every outside service FAKE); it needs no other stage before it and runs after th1b-request too (the two
 * brands are made once: ensureBrand):
 *   S   the sales office makes the seeded P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal
 *       buyer; the buyer opens the seeded supplier P2's portal with an order desk; every portal person signs in through the screens
 *   P1  sales starts a project for Brand Alpha from its style SEED-JKT-01 (New project at the address the style's menu opens:
 *       `?new=1&link=Style:<id>` — "Will link: SEED-JKT-01"): name, Outside company (said once: "only Brand Alpha and our team"),
 *       target date, goal; Create opens the project's page (PRJ-…, the style linked)
 *   P2  sales adds a colleague (the production manager) and Brand Alpha's portal buyer (People › Add a colleague, Add <company>
 *       people), and links A's sample round SEED-SR-0001 from Products › Samples (the table, the row ticked with `x`, "Add 1 to
 *       project": "1 linked")
 *   P3  sales writes an office note and a message "In the portal only" to Brand Alpha in the project's thread
 *   P4  the colleague finds it on Today › My projects and opens it: the note and the message
 *   P5  Brand Alpha's buyer opens it from Samples & tech packs › Projects: its name, Active, the target date, the message — never
 *       the office note, the goal or the office's PRJ number — and answers; sales reads the answer
 *   P6  sales closes it (Done, the outcome told to Brand Alpha): the closed banner with Reopen; an admin (threads.manage) sees the
 *       band's Reopen and NO Reopen in the thread's head (a closed project's thread opens only with the project); Brand Alpha reads
 *       the outcome line and "closed"
 *   T00 Brand Beta (home, Samples & tech packs, the address of A's project → "Project not found") and the supplier's order desk
 *       (home, the address of A's project → "Project not found"): every page passes the DOM name scan — no name, code, contact,
 *       number or id of Brand Alpha, nor the project's name, PRJ number, id, goal, note, messages or outcome.
 * Writes outside the screens (no screen does them): the brands' set-up (names, contact, address, portal, invitation) as sales, the
 * supplier portal and its order desk's invitation as the buyer, with their step-ups; reads only for the ids the addresses need and
 * the assertions.
 */

const PROJECTS = words('products-projects')
const RECORD = words('products-projects-record')
const PEOPLE = words('products-projects-people')
const LINKED = words('products-projects-linked')
const PORTAL = words('portal-projects')
const SAMPLES = words('portal-samples')
const BOX = words('record-thread-composer')
const HEAD = words('record-thread-head')
const HOME = words('home')
const DS = words('ds-words')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A catalogue sentence as a regular expression: its placeholders match anything. */
const shaped = (text: string) => new RegExp(escape(text).replace(/\\\{[a-zA-Z]+\\\}/g, '.+'))

const PROJECT_NAME = 'Alpha FW27 airbag line (made up)'
const GOAL = 'Made-up goal the office keeps: three airbag jackets on one block, proto to salesman samples.'
const NOTE = 'Made-up office note: the airbag supplier quotes 12 weeks, keep it from the brand.'
const TO_ALPHA = 'Made-up to Brand Alpha: the first proto of the airbag line leaves on Friday.'
const FROM_ALPHA = 'Made-up from Brand Alpha: please keep the yellow piping on all three jackets.'
const OUTCOME = 'Made-up outcome: the airbag line is approved, three styles to production in March.'
/** Brand Alpha's seeded style and fit round (seed/product.ts, seed/samples: tenant-wide, the brand P1's). */
const STYLE_CODE = 'SEED-JKT-01'
const ROUND_NUMBER = 'SEED-SR-0001'
const DESK = { name: 'Dario Desk', email: 'desk.th5@supplier-p2.example.com' }

/** The page shows nothing of `brand` nor the run's own words of it; a screenshot for the record. */
async function scanned(flow: Flow, page: Page, brand: BrandFixture, extra: readonly string[], where: string): Promise<void> {
  await expectNothingOf(page, brand, extra, where)
  await flow.shot(page, where.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
}

/** A fresh office step-up (the next authenticator code) before a signing act of the set-up. */
async function steppedUp(flow: Flow, office: Desk): Promise<void> {
  await flow.write(office.page, 'POST', '/auth/office/step-up', { code: await flow.code(office.person) })
}

/** The buyer opens P2's supplier portal and invites its order desk (the API golden flow's setUpDesk; writes outside the screens). */
async function setUpDesk(flow: Flow, buyer: Desk, supplierId: string): Promise<void> {
  const { page } = buyer
  const tab = await flow.read(page, `/partners/${supplierId}`)
  await steppedUp(flow, buyer)
  await flow.write(page, 'POST', `/partners/${supplierId}/settings`, { portalOn: true, version: tab.settings?.version ?? 0 })
  await steppedUp(flow, buyer)
  await flow.write(page, 'POST', `/partners/${supplierId}/people`, { email: DESK.email, displayName: DESK.name, locale: 'en', kind: 'SUPPLIER', roleKey: 'supplier-orders', capabilities: ['comment'], companyId: flow.companyId })
}

export default defineStage({
  proves:
    'sales makes a project for customer A from its style, adds a colleague and customer A’s buyer, links A’s sample round, writes a note and a portal message; the colleague finds it on Today; customer A reads the message (never the note or the PRJ number) and answers; closed, the thread head offers no Reopen; customer B’s and the supplier’s pages pass the DOM name scan and A’s project is “not found” for them',
  async run(flow) {
    const sales = await flow.desk('sales')
    const alphaId = await flow.seedId('party:P1')
    const betaId = await flow.seedId('party:P3')
    const supplierId = await flow.seedId('party:P2')
    // The colleague exists before "Add a colleague" lists the people who may read the project.
    const manager = await flow.person('manager')
    type Run = { id: string; number: string; styleId: string; roundId: string; supplierCode: string }
    const run = {} as Run

    Object.assign(
      run,
      await flow.step('the sales office makes P1 Brand Alpha and P3 Brand Beta; the buyer opens P2’s supplier portal with an order desk', async () => {
        await ensureBrand(flow, sales, BRAND_ALPHA, alphaId)
        await ensureBrand(flow, sales, BRAND_BETA, betaId)
        const buyer = await flow.desk('buyer')
        await setUpDesk(flow, buyer, supplierId)
        await flow.settle()
        const styles = (await flow.read(sales.page, `/product/styles?q=${encodeURIComponent(STYLE_CODE)}&status=OPEN&limit=50`)).styles as { id: string; code: string }[]
        const rounds = (await flow.read(sales.page, `/sales/samples/rounds?tile=ALL&q=${encodeURIComponent(ROUND_NUMBER)}&limit=200`)).rows as { id: string; number: string }[]
        const styleId = styles.find((style) => style.code === STYLE_CODE)?.id
        const roundId = rounds.find((round) => round.number === ROUND_NUMBER)?.id
        expect(styleId, `the seeded style ${STYLE_CODE}`).toBeTruthy()
        expect(roundId, `the seeded round ${ROUND_NUMBER}`).toBeTruthy()
        const supplierCode = (await flow.read(buyer.page, `/parties/${supplierId}`)).party.code as string
        return { styleId: styleId!, roundId: roundId!, supplierCode }
      }),
    )

    // Not a kept step: a run attached to a kept stack (FACTORY_BGF_RESUME) signs every portal person in again in its new browser.
    const { alpha, beta, desk } = await test.step('each portal person signs in through the portal’s screens (the mailed link, Continue, the first visit)', async () => {
      const supplier = { ...BRAND_BETA, key: 'supplier' as unknown as BrandFixture['key'], code: run.supplierCode, portalPerson: DESK } satisfies BrandFixture
      return {
        alpha: await signInToPortal(flow, BRAND_ALPHA, alphaId),
        beta: await signInToPortal(flow, BRAND_BETA, betaId),
        desk: await signInToPortal(flow, supplier, supplierId),
      }
    })

    Object.assign(
      run,
      await flow.step('sales starts a project for Brand Alpha from its style: the outside company said once, the style linked at once', async () => {
        const { page } = sales
        await sales.go(`/products/projects?new=1&link=Style:${run.styleId}&linkLabel=${encodeURIComponent(STYLE_CODE)}`)
        const dialog = page.getByRole('dialog', { name: PROJECTS('new.title') })
        await seen(dialog, 60_000)
        await seen(dialog.getByText(PROJECTS('new.willLink', { record: STYLE_CODE })))
        await dialog.getByRole('textbox', { name: PROJECTS('field.name'), exact: true }).fill(PROJECT_NAME)
        const party = dialog.getByRole('combobox', { name: PROJECTS('field.partyId'), exact: true })
        await expect(party.locator(`option[value="${alphaId}"]`)).toHaveCount(1, { timeout: 60_000 })
        await party.selectOption(alphaId)
        await seen(dialog.getByText(shaped(PROJECTS('new.setOnceParty'))))
        await pickDate(dialog, PROJECTS('field.targetDate'), day(60))
        await dialog.getByRole('textbox', { name: PROJECTS('field.goal'), exact: true }).fill(GOAL)
        await dialog.getByRole('button', { name: PROJECTS('new.submit') }).click()
        await page.waitForURL(/\/products\/projects\/[0-9a-f-]{36}(\?|#|$)/, { timeout: 60_000 })
        const id = /\/products\/projects\/([0-9a-f-]{36})/.exec(page.url())?.[1]
        expect(id, `the project's page (${page.url()})`).toBeTruthy()
        const read = await flow.read(page, `/projects/${id}`)
        expect(read.project).toMatchObject({ name: PROJECT_NAME, status: 'ACTIVE', party: { id: alphaId }, lead: { id: sales.person.id } })
        expect((read.links.records as { recordType: string; recordId: string }[]).map((entry) => [entry.recordType, entry.recordId])).toEqual([['Style', run.styleId]])
        const number = read.project.number as string
        expect(number).toMatch(/^PRJ-/)
        await seen(page.getByText(number).first(), 60_000)
        await flow.settle()
        await flow.shot(page, 'office-project-made')
        return { id: id!, number }
      }),
    )

    await flow.step('sales adds the production manager and Brand Alpha’s buyer (People), and links A’s sample round from Samples', async () => {
      const { page } = sales
      await sales.go(`/products/projects/${run.id}`)
      // Our team: Add a colleague → the colleagues who may read the project (they are told).
      await page.getByRole('button', { name: PEOPLE('add.team'), exact: true }).click()
      const team = page.getByRole('dialog', { name: shaped(PEOPLE('add.teamTitle')) })
      await seen(team, 60_000)
      await team.getByRole('searchbox', { name: PEOPLE('add.search') }).fill('Marta')
      await team.getByRole('button', { name: PEOPLE('add.pickLabel', { name: 'Marta Manager' }) }).click()
      await team.waitFor({ state: 'hidden', timeout: 60_000 })
      // Brand Alpha's people: exactly its portal people (never another company's).
      await page.getByRole('button', { name: shaped(PEOPLE('add.outside')) }).click()
      const outside = page.getByRole('dialog', { name: shaped(PEOPLE('add.outsideTitle')) })
      await seen(outside, 60_000)
      await outside.getByRole('button', { name: PEOPLE('add.pickLabel', { name: BRAND_ALPHA.portalPerson.name }) }).click()
      await outside.waitFor({ state: 'hidden', timeout: 60_000 })
      await seen(page.getByText(BRAND_ALPHA.portalPerson.name).first())
      await flow.settle()
      const people = (await flow.read(page, `/projects/${run.id}`)).people
      expect((people.office.people as { userId: string }[]).map((entry) => entry.userId)).toContain(manager.id)
      expect(people.outside.people as unknown[]).toHaveLength(1)

      // Products › Samples, as a table narrowed to the round: `j` focuses its row, `x` ticks it, "Add 1 to project".
      await sales.go(`/products/samples?mode=table&tile=ALL&q=${encodeURIComponent(ROUND_NUMBER)}`)
      await seen(page.getByText(ROUND_NUMBER).first(), 60_000)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
      await page.keyboard.press('j')
      await page.keyboard.press('x')
      await page.getByRole('button', { name: LINKED('addTo.buttonCount', { count: 1 }) }).click()
      const add = page.getByRole('dialog', { name: LINKED('addTo.titleSampleRound', { count: 1 }) })
      await seen(add, 60_000)
      await add.getByRole('searchbox', { name: LINKED('addTo.search') }).fill('airbag')
      await add.getByRole('radio', { name: new RegExp(escape(PROJECT_NAME)) }).check()
      await add.getByRole('button', { name: LINKED('addTo.submit'), exact: true }).click()
      const result = page.getByRole('dialog', { name: LINKED('addTo.result.title', { project: `${run.number} · ${PROJECT_NAME}` }) })
      await seen(result, 60_000)
      await seen(result.getByText(LINKED('addTo.result.linked', { count: 1 })))
      await flow.shot(page, 'office-round-added')
      await result.getByRole('button', { name: LINKED('addTo.result.done'), exact: true }).click()
      await flow.settle()
      const links = (await flow.read(page, `/projects/${run.id}`)).links.records as { recordType: string; recordId: string }[]
      expect(links.map((entry) => entry.recordType).sort()).toEqual(['SampleRound', 'Style'])
      expect(links.find((entry) => entry.recordType === 'SampleRound')?.recordId).toBe(run.roundId)
      await sales.go(`/products/projects/${run.id}`)
      await seen(page.getByRole('heading', { name: LINKED('block.heading', { count: 2 }) }), 60_000)
      await flow.shot(page, 'office-people-and-links')
    })

    await flow.step('sales writes an office note and a message to Brand Alpha in the portal, in the project’s thread', async () => {
      const { page } = sales
      await sales.go(`/products/projects/${run.id}`)
      const modes = page.getByRole('radiogroup', { name: BOX('modeLabel') })
      await seen(modes, 60_000)
      await modes.getByRole('radio', { name: BOX('mode.note'), exact: true }).click()
      await page.getByRole('combobox', { name: BOX('mode.note'), exact: true }).fill(NOTE)
      await page.getByRole('button', { name: BOX('send.note'), exact: true }).click()
      await seen(page.getByText(NOTE).first(), 60_000)
      await modes.getByRole('radio', { name: BOX('mode.portal'), exact: true }).click()
      await page.getByRole('combobox', { name: BOX('mode.portal'), exact: true }).fill(TO_ALPHA)
      await page.getByRole('button', { name: shaped(BOX('send.portal')) }).click()
      await seen(page.getByText(TO_ALPHA).first(), 60_000)
      await flow.settle()
      await flow.shot(page, 'office-thread')
    })

    await flow.step('the colleague finds it on Today › My projects and opens it: the office note and the message', async () => {
      const desk = await flow.desk('manager')
      const { page } = desk
      await desk.go('/home/today')
      await seen(page.getByRole('heading', { name: HOME('myProjects.title'), exact: true }), 60_000)
      const mine = page.getByRole('list', { name: HOME('myProjects.title') })
      await mine.getByRole('link', { name: new RegExp(escape(PROJECT_NAME)) }).first().click()
      await page.waitForURL(new RegExp(`/products/projects/${run.id}`), { timeout: 60_000 })
      await seen(page.getByText(NOTE).first(), 60_000)
      await seen(page.getByText(TO_ALPHA).first())
      await flow.shot(page, 'manager-today-project')
    })

    await flow.step('Brand Alpha’s buyer opens it from Samples & tech packs: the message, never the note, the goal or the PRJ number; it answers', async () => {
      const { page } = alpha
      await alpha.go('/samples')
      await page.getByRole('link', { name: SAMPLES('projects.openOf', { name: PROJECT_NAME }) }).click()
      await page.waitForURL(new RegExp(`/projects/${run.id}`), { timeout: 60_000 })
      await seen(page.getByRole('heading', { name: PROJECT_NAME, exact: true }), 60_000)
      await seen(page.getByText(PORTAL('status.ACTIVE'), { exact: true }).first())
      await seen(page.getByText(shaped(PORTAL('summary.target'))).first())
      await seen(page.getByText(TO_ALPHA).first(), 60_000)
      const shown = await pageWords(page)
      for (const hidden of [NOTE, GOAL, run.number]) expect(shown, `customer A's project page shows ${hidden}`).not.toContain(hidden)
      await page.getByRole('textbox', { name: DS('partnerThread.composer'), exact: true }).fill(FROM_ALPHA)
      await page.getByRole('button', { name: DS('partnerThread.send'), exact: true }).click()
      await seen(page.getByText(FROM_ALPHA).first(), 60_000)
      await flow.settle()
      await flow.shot(page, 'alpha-project')
      // Its Home lists the project by name, never by the office's number.
      await alpha.go('')
      await seen(page.getByRole('heading', { name: words('portal-customer-home')('title'), exact: true }), 60_000)
      expect(await pageWords(page)).not.toContain(run.number)
      // The office reads the answer.
      await sales.go(`/products/projects/${run.id}`)
      await seen(sales.page.getByText(FROM_ALPHA).first(), 60_000)
    })

    await flow.step('sales closes it (Done, told to Brand Alpha); an admin sees Reopen on the band and none in the thread’s head; A reads the outcome', async () => {
      const { page } = sales
      await sales.go(`/products/projects/${run.id}`)
      await page.getByRole('button', { name: RECORD('band.moreLabel') }).first().click()
      await page.getByRole('menuitem', { name: RECORD('band.more.close') }).click()
      const close = page.getByRole('dialog', { name: RECORD('close.title', { number: run.number }) })
      await seen(close, 60_000)
      await close.getByRole('radio', { name: new RegExp(`^${escape(PROJECTS('outcome.DONE'))}`) }).check()
      await close.getByRole('textbox', { name: RECORD('close.noteLabel'), exact: true }).fill(OUTCOME)
      await close.getByRole('checkbox', { name: shaped(RECORD('close.tell')) }).check()
      await close.getByRole('button', { name: RECORD('close.submit'), exact: true }).click()
      await close.waitFor({ state: 'hidden', timeout: 60_000 })
      await seen(page.getByText(shaped(RECORD('closed.banner'))).first(), 60_000)
      await seen(page.getByRole('button', { name: RECORD('band.more.reopen'), exact: true }).first())
      await flow.settle()
      expect((await flow.read(page, `/projects/${run.id}`)).project).toMatchObject({ status: 'CLOSED', outcome: 'DONE', threadStatus: 'CLOSED' })
      await flow.shot(page, 'office-closed')

      // The admin holds threads.manage: the thread's head says "Closed by …" with no Reopen of its own — the band's Reopen reopens
      // the project and its thread in one command (the API refuses to open a closed project's thread alone).
      const admin = await flow.desk('admin')
      await admin.go(`/products/projects/${run.id}`)
      const head = admin.page.getByRole('group', { name: HEAD('label', { record: run.number }) })
      await seen(head, 60_000)
      // "Closed by Sara Sales, 17 Nov" (or "Closed, 17 Nov" when the thread names nobody).
      await seen(head.getByText(new RegExp(`${shaped(HEAD('closed.by')).source}|${shaped(HEAD('closed.noName')).source}`)).first())
      await expect(head.getByRole('button', { name: HEAD('act.reopen'), exact: true })).toHaveCount(0)
      await seen(admin.page.getByRole('button', { name: RECORD('band.more.reopen'), exact: true }).first())
      await flow.shot(admin.page, 'admin-closed-head')

      await alpha.go(`/projects/${run.id}`)
      await seen(alpha.page.getByText(OUTCOME).first(), 60_000)
      await seen(alpha.page.getByText(PORTAL('status.CLOSED'), { exact: true }).first())
      await seen(alpha.page.getByText(PORTAL('summary.closed')).first())
      expect(await pageWords(alpha.page)).not.toContain(run.number)
      await flow.shot(alpha.page, 'alpha-closed')
    })

    await flow.step('T00 / W38: Brand Beta and the supplier’s order desk see nothing of Brand Alpha or its project; its address is “not found”', async () => {
      const project = [run.number, run.id, PROJECT_NAME, GOAL, NOTE, TO_ALPHA, FROM_ALPHA, OUTCOME, run.roundId, ROUND_NUMBER]
      // Customer B also never sees Brand Alpha's style (the supplier may read a style code on its own orders: left out, as the API flow).
      const forBeta = [...project, STYLE_CODE, run.styleId]
      const notFound = async (who: PortalDesk, where: string, extra: readonly string[]) => {
        await who.go(`/projects/${run.id}`)
        await seen(who.page.getByText(PORTAL('missing.title')).first(), 60_000)
        await seen(who.page.getByText(PORTAL('missing.body')).first())
        await scanned(flow, who.page, BRAND_ALPHA, extra, where)
      }

      await beta.go('')
      await seen(beta.page.getByRole('heading', { name: words('portal-customer-home')('title'), exact: true }), 60_000)
      await scanned(flow, beta.page, BRAND_ALPHA, forBeta, 'beta home')
      await beta.go('/samples')
      await seen(beta.page.getByText(SAMPLES('title')).first(), 60_000)
      await expect(beta.page.getByRole('link', { name: SAMPLES('projects.openOf', { name: PROJECT_NAME }) })).toHaveCount(0)
      await scanned(flow, beta.page, BRAND_ALPHA, forBeta, 'beta samples and tech packs')
      await notFound(beta, 'beta address of A project', forBeta)

      await desk.go('')
      await seen(desk.page.getByRole('heading', { name: words('portal-supplier-orders')('home.glance') }), 60_000)
      await scanned(flow, desk.page, BRAND_ALPHA, project, 'supplier home')
      await notFound(desk, 'supplier address of A project', project)
    })
  },
})
