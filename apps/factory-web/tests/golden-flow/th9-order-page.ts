import { expect, test, type Locator, type Page } from '@playwright/test'
import * as shipmentsDomain from '@nexus/factory-domain/shipping/shipments'
import { BRAND_ALPHA, BRAND_BETA } from '../../src/lib/testing/two-brands'
import { expectNothingOf } from './_harness/brand-scan'
import { seen, type Desk, type Flow } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { ensureBrand, signInToPortal, type PortalDesk } from './_harness/two-brands'
import { answerOf, byApi, day, dialog, press, routerActivity } from './_harness/ui'
import { startsWith, words } from './_harness/words'

/**
 * F-OP-129 — UI golden flow TH-9: THE ORDER PAGE AT THE END (order page plan N1–N6; 10-order-page §2, §5, §7, §8, §13; review R-4,
 * R-6, R-7, R-9, R-11). Runs right after 16-close (stages.ts AFTER_STAGES) or alone on a fresh stack (`--stages th9-order-page`): it
 * makes its own world once — the seeded P1 as Brand Alpha and P3 as Brand Beta with their portal buyers (two-brands.ts), one order for
 * A typed by Sales (set-up), and the seeds' orders of P1 (SEED-SO-0002, SEED-SO-0003 with released garments; SEED-SO-W39-01 waiting
 * for a yes, SEED-SO-W39-02 with a change that asks the yes again). Then, through the order page's screens, at 1440 × 900:
 *   1  the yes in place: SEED-SO-W39-01's credit yes confirmed with the code (the Owner, else Finance, its approver); SEED-SO-W39-02's
 *      change refused in place with a reason and words (its yes is stale by design: the page says so and offers the no); a yes the
 *      Owner asked is held for her ("another person decides", rule 42) and Finance confirms it. Lane rule (Sales = no price): the
 *      acts with prices are the Owner's or Finance's; Sales keeps the no-price ones (the quantity change of step 3, D1);
 *   2  make a work order in place (the planner, the Production tab): a DRAFT of the new order; the production lane releases it
 *      (set-up: 10-work-order's flow);
 *   3  amend (Sales, edit mode): the strip says what each work order does — the released one waits for production, the new pieces
 *      follow now as a new DRAFT; Apply; the planner decides the waiting change on the order page (Lower to the order);
 *   4  tracking typed, corrected and cleared on SEED-SO-0003's shipment (a carrier booked by hand): "No live tracking";
 *   5  a shipment made elsewhere: the dialog on SEED-SO-0002 — its released garments, the paper DDT, no Nexus DDT number; the live
 *      rules said under the fields;
 *   6  a combined shipment of two orders — before the N6 switch (B-OP-047) held off in words, after it made in place with SEED-SO-0003
 *      added, "Also carries" on both orders; customer B's orders never offered;
 *   7  the files viewer walk by keys (→ / ←, Esc back to the card);
 *   8  two customers: B's portal answers A's orders with the neutral refusal; A's pages hold nothing of B; the page at rest asks little.
 * Not here, said in the report: cut pieces (the floor's flow: the extra-pieces outcome is held by the design case
 * f-op-129-strip-outcome, B-OP-071 O1 and the unit tests of F-OP-107), the record of a shipment made elsewhere whose garments the seeds
 * date in the story's days ahead (B-OP-071 O4 records one), and the invoices of a shared shipment that left (B-OP-045).
 */

const OD = words('orders')
const PROD = words('production')
const APPROVALS = words('approvals')
const DEPTH = words('warehouse-shipments-depth')
const POPUPS = words('record-thread-popups')
const PO = words('portal-orders')
const SHIP = words('shipments')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A catalogue sentence's words before its first placeholder (the key's raw text). */
const lead = (text: string) => text.split(/\{[a-zA-Z]+\}/)[0]!.trim()
const notHere = (description: string) => test.info().annotations.push({ type: 'not here', description })

/** B-OP-047 deletes MULTI_ORDER_OFF: until then a second order on a shipment is held off in its words (Warehouse's `shipOrders.later`). */
const N6_ON = !('MULTI_ORDER_OFF' in shipmentsDomain)

/** The made-up words of this stage. */
const PO_REF = `${BRAND_ALPHA.customerRef}-TH9`
const TRACKING = ['T-TH9-TRK-0001', 'T-TH9-TRK-0002'] as const
const TRACK_LINK = 'https://track.example.com/T-TH9-TRK-0002'
const PAPER_DDT = 'T-TH9-77/2026'
const AMEND_REASON = 'Made-up: Brand Alpha wants one more 50 and one fewer 52.'
const REFUSE_WORDS = 'Made-up: asked about an older version of the order; ask it again on this one.'

type Json = Record<string, any>
type Made = { id: string; number: string }

/** The order page's band yes: "Confirm the order" (a sales order) or "Approve: <kind>" (another kind of request). */
const YES = new RegExp(`^(${escape(OD('approval.confirm'))}|${escape(lead(OD('approval.approveKind')))})`)
const DONE = new RegExp(`^(${escape(OD('approval.confirmed'))}|${escape(OD('approval.approved'))})`)

async function orderOf(flow: Flow, page: Page, number: string): Promise<Made> {
  const list = await flow.read(page, `/sales/orders?q=${encodeURIComponent(number)}`)
  const row = ((list.orders ?? list.items ?? []) as Json[]).find((entry) => entry.number === number)
  expect(row, `the order ${number} (the seeds')`).toBeDefined()
  return { id: row!.id as string, number }
}
const statusOf = async (flow: Flow, page: Page, orderId: string): Promise<string> => ((await flow.read(page, `/sales/orders/${orderId}`)).order.status as string)
const tabs = (page: Page): Locator => page.getByRole('navigation', { name: OD('record.tabsLabel'), exact: true })
/** A Shipments row of the order page by its shipment number. */
const shipmentRow = (page: Page, number: string): Locator => page.getByRole('row').filter({ hasText: number })

/**
 * The waiting order's yes in place by the first of `desks` it is allowed to (the Owner first; a request addressed to Finance may be
 * Finance's alone), with the person's code when asked; the band's notice after.
 */
async function yesInPlace(flow: Flow, desks: readonly Desk[], orderId: string): Promise<Desk> {
  for (const desk of desks) {
    const { page } = desk
    await desk.go(`/sales/orders/${orderId}?tab=overview`)
    const yes = page.getByRole('button', { name: YES }).first()
    await seen(yes, 60_000)
    if (!(await yes.isEnabled())) continue
    await answerOf(page, 'POST', /^\/approvals\/tasks\/[^/]+\/approve$/, async () => {
      await press(yes)
      await flow.stepUp(page, desk.person)
    })
    await seen(page.getByText(DONE).first(), 60_000)
    return desk
  }
  throw new Error(`the yes of ${orderId} is held for every desk asked (${desks.map((desk) => desk.person.key).join(', ')})`)
}

/** The tracking dialog of a Shipments row: the number and its typed link (F-OP-135), saved or cleared. */
async function typeTracking(page: Page, number: string, tracking: string | null, link: string | null): Promise<void> {
  const row = shipmentRow(page, number)
  await seen(row, 60_000)
  await press(row.getByRole('button', { name: OD('ship.trackingOpen'), exact: true }))
  const box = dialog(page)
  await seen(box)
  await box.getByRole('textbox', { name: DEPTH('transport.trackingNumber') }).fill(tracking ?? '')
  if (link !== null) await box.getByRole('textbox', { name: DEPTH('transport.trackingLink') }).fill(link)
  await press(box.getByRole('button', { name: tracking === null ? DEPTH('transport.clearTracking') : DEPTH('transport.saveTracking'), exact: true }))
  await expect(box).toBeHidden({ timeout: 30_000 })
}

/** Opens an address of A's record in B's portal and waits for its neutral words; the page holds nothing of A. */
async function refusedToBeta(beta: PortalDesk, path: string, ofAlpha: readonly string[], where: string): Promise<void> {
  await beta.go(path)
  await seen(beta.page.getByText(PO('record.missing')).first(), 60_000)
  await expectNothingOf(beta.page, BRAND_ALPHA, ofAlpha, where)
}

export default defineStage({
  proves:
    'the order page at the end: the yes in place (a waiting order confirmed, a stale change refused with its reason; a yes the Owner asked is held for her); a work order made in place; edit mode’s strip says which work order follows now and which waits, Apply, the planner decides the waiting one on the order page; tracking typed, corrected and cleared ("No live tracking"); the made-elsewhere dialog with its paper DDT and its live rules; a combined shipment of two orders (held off in words until the N6 switch); the files viewer walk by keys; customer B never offered or shown A’s orders, A’s ids answer B’s neutral refusal',
  async run(flow: Flow) {
    const sales = await flow.desk('sales')
    const alphaId = await flow.seedId('party:P1')
    const betaId = await flow.seedId('party:P3')

    const world = await flow.step('set-up: P1 as Brand Alpha and P3 as Brand Beta with their portal buyers; an order for A (the Owner’s, with its prices); the seeds’ orders of P1', async () => {
      await ensureBrand(flow, sales, BRAND_ALPHA, alphaId)
      await ensureBrand(flow, sales, BRAND_BETA, betaId)
      // Lane rule (Sales = no price): an order typed with its prices is the Owner's; Sales keeps the no-price acts (step 3).
      const made = await flow.write(
        (await flow.desk('owner')).page,
        'POST',
        '/sales/orders/manual',
        {
          companyId: flow.companyId,
          partyId: alphaId,
          customerRef: PO_REF,
          promiseDate: day(60),
          depositPct: null,
          lines: [{ styleId: await flow.seedId('product:style:JKT-01'), colourwayId: await flow.seedId('product:colourway:JKT-01:BLK'), sizes: [{ size: '50', quantity: 4 }, { size: '52', quantity: 4 }] }],
        },
        201,
      )
      const seeded = {
        so2: await orderOf(flow, sales.page, 'SEED-SO-0002'),
        so3: await orderOf(flow, sales.page, 'SEED-SO-0003'),
        w3901: await orderOf(flow, sales.page, 'SEED-SO-W39-01'),
        w3902: await orderOf(flow, sales.page, 'SEED-SO-W39-02'),
      }
      const betaOrders = ((await flow.read(sales.page, `/sales/orders?partyId=${betaId}&limit=100`)).orders ?? []) as Json[]
      return { order: { id: made.order.id as string, number: made.order.number as string, status: made.order.status as string }, ...seeded, betaNumbers: betaOrders.map((row) => row.number as string) }
    })
    const ofAlpha = [world.order.number, world.order.id, world.so2.number, world.so2.id, world.so3.number, world.so3.id, PO_REF, ...TRACKING, PAPER_DDT]

    await flow.step('1 · the yes in place: SEED-SO-W39-01 confirmed with the code; SEED-SO-W39-02’s change refused in place with its reason (its yes is stale); a yes the Owner asked is held for her', async () => {
      const owner = await flow.desk('owner')
      const finance = await flow.desk('finance')
      // A yes the Owner asked (the new order when a rule or the customer's credit holds it): held for its asker (rule 42, the Owner
      // included), decided by another person.
      if (world.order.status === 'PENDING_APPROVAL') {
        await owner.go(`/sales/orders/${world.order.id}?tab=overview`)
        const own = owner.page.getByRole('button', { name: YES })
        await seen(owner.page.getByText(OD('approval.selfAsked')).first(), 60_000)
        if ((await own.count()) > 0) await expect(own.first(), 'nobody approves their own request').toBeDisabled()
        await yesInPlace(flow, [finance], world.order.id)
      } else notHere('a yes the Owner asked: the new order was confirmed as typed (no rule held it); the held yes is the design case f-op-101-self-asked')

      // SEED-SO-W39-01 waits for its credit yes (asked of Finance): the Owner when the engine lets her, else Finance.
      const decided = await yesInPlace(flow, [owner, finance], world.w3901.id)
      await flow.shot(decided.page, 'yes-confirmed')

      // SEED-SO-W39-02's change asks the Owner's role about an older version of the order (the seeds' made-up fingerprint: STALE by
      // design, op-19): the page says the yes cannot be given and offers the no, given in place with a reason and words.
      const { page } = owner
      await owner.go(`/sales/orders/${world.w3902.id}?tab=overview`)
      const yes = page.getByRole('button', { name: YES }).first()
      await seen(yes, 60_000)
      const stale = page.getByText(OD('approval.refused.STALE')).first()
      await press(yes)
      await flow.stepUp(page, owner.person)
      await expect(page.getByText(DONE).first().or(stale)).toBeVisible({ timeout: 60_000 })
      if (await stale.isVisible().catch(() => false)) {
        await press(page.getByRole('button', { name: OD('approval.refuse'), exact: true }).first())
        const box = dialog(page)
        const why = box.getByRole('combobox', { name: OD('approval.no.reason') })
        await seen(why, 60_000)
        await why.selectOption({ index: 1 })
        await box.getByRole('textbox', { name: startsWith(OD('approval.no.words')) }).fill(REFUSE_WORDS)
        await answerOf(page, 'POST', /^\/approvals\/tasks\/[^/]+\/reject$/, () => press(box.getByRole('button', { name: OD('approval.refuseGo'), exact: true })))
        await seen(page.getByText(OD('approval.refusedDone')).first(), 60_000)
        await flow.shot(page, 'yes-refused')
      }
      await flow.settle()
      await expect.poll(() => statusOf(flow, owner.page, world.w3901.id), { timeout: 60_000 }).toBe('CONFIRMED')
      const after = (await flow.read(owner.page, `/sales/orders/${world.w3902.id}`)).order as Json
      expect(((after.openApprovals ?? []) as Json[]).filter((row) => row.kind === 'SALES_ORDER_CHANGE'), 'the change’s yes is decided').toEqual([])
    })

    const workOrder = await flow.step('2 · make a work order in place: the planner on the Production tab → New work order → its DRAFT; released by the production lane', async () => {
      const planner = await flow.desk('planner')
      await planner.go(`/sales/orders/${world.order.id}?tab=production`)
      const make = planner.page.getByRole('button', { name: new RegExp(`^(${escape(OD('step.makeWorkOrders'))}|${escape(lead(OD('wo.makeNext')))})`) }).first()
      await seen(make, 60_000)
      const box = dialog(planner.page)
      const created = await answerOf(planner.page, 'POST', /^\/production\/work-orders$/, async () => {
        await press(make)
        await seen(box.getByText(PROD('new.title')).first())
        await press(box.getByRole('button', { name: PROD('new.create'), exact: true }))
      })
      const made = created.workOrder as Json
      expect(made.status).toBe('DRAFT')
      await seen(planner.page.getByText(made.number as string).first(), 60_000)
      await flow.shot(planner.page, 'work-order-made')
      // Its release is the production lane's own flow (10-work-order walks it through the screens).
      byApi('the release of the work order made here (10-work-order releases one through its screens)')
      const check = await flow.read(planner.page, `/production/work-orders/${made.id}/release-check`)
      const blockers = (check.blockers ?? []) as Json[]
      const fresh = (await flow.read(planner.page, `/production/work-orders/${made.id}`)).workOrder as Json
      await flow.write(planner.page, 'POST', `/production/work-orders/${made.id}/release`, { version: fresh.version, ...(blockers.length > 0 ? { materialOverride: { reason: 'Made-up: the leather arrives before cutting.' } } : {}) })
      return { id: made.id as string, number: made.number as string }
    })

    await flow.step('3 · amend in edit mode (Sales): the strip says the released work order waits and the new pieces follow now; Apply; the planner decides the waiting change in place', async () => {
      const { page } = sales
      await sales.go(`/sales/orders/${world.order.id}?tab=lines`)
      const more = page.getByRole('button', { name: OD('record.more'), exact: true }).first()
      await seen(more, 60_000)
      await more.click()
      await page.getByRole('menuitem', { name: startsWith(OD('action.amend')) }).first().click()
      await page.waitForURL(/[?&]tab=lines/)
      // One more 50 (a new DRAFT follows now), one fewer 52 (the released work order waits for production).
      await page.getByRole('textbox', { name: /, size 50$/ }).first().fill('5')
      await page.getByRole('textbox', { name: /, size 52$/ }).first().fill('3')
      const reason = page.getByRole('textbox', { name: startsWith(OD('amend.reason')) })
      if ((await reason.count()) > 0) await reason.first().fill(AMEND_REASON)
      const strip = page.locator('.fw-so-strip-line')
      await seen(strip.filter({ hasText: OD('edit.strip.wo.waits') }).first(), 60_000)
      await expect(strip.filter({ hasText: OD('edit.strip.wo.waits') }).first()).toContainText(workOrder.number)
      await seen(strip.filter({ hasText: OD('edit.strip.wo.now') }).first())
      await flow.shot(page, 'strip-sales')
      const applied = await answerOf(page, 'POST', /^\/sales\/orders\/[^/]+\/amendments$/, () => press(page.getByRole('button', { name: OD('amend.apply'), exact: true })))
      expect((applied.workOrders.waiting as Json[]).map((entry) => entry.workOrderId)).toEqual([workOrder.id])
      expect((applied.workOrders.applied as Json[]).map((entry) => entry.route)).toEqual(['NEW_DRAFT'])
      await seen(page.getByText(startsWith(lead(OD('edit.done.both')))).first(), 60_000)
      await flow.settle()

      // The planner decides it on the order page (F-OP-116, A14): under the work order's row "Change waits: 4 → 3 · Apply… /
      // Leave as is…"; Apply… opens the ONE review window (Approvals' WorkOrderChangeReview as is) → Lower to the order.
      const planner = await flow.desk('planner')
      await planner.go(`/sales/orders/${world.order.id}?tab=production`)
      const waits = startsWith(lead(OD('wo.changeWaits')))
      const line = planner.page.getByText(waits).first()
      await seen(line, 60_000)
      const beside = line.locator('xpath=..')
      await expect(beside.getByRole('button', { name: OD('wo.changeLeave'), exact: true })).toBeVisible()
      await press(beside.getByRole('button', { name: OD('wo.changeApply'), exact: true }))
      const review = dialog(planner.page)
      await seen(review, 60_000)
      await answerOf(planner.page, 'POST', /^\/production\/work-order-changes\/[^/]+\/apply$/, async () => {
        await press(review.getByRole('button', { name: APPROVALS('workOrderChange.apply.LOWER_TO_ORDER'), exact: true }))
        await flow.stepUp(planner.page, planner.person)
      })
      await seen(planner.page.getByText(OD('wo.changeApplied', { number: workOrder.number })).first(), 60_000)
      await flow.settle()
      await expect(planner.page.getByText(waits)).toHaveCount(0, { timeout: 60_000 })
      await flow.shot(planner.page, 'change-decided')
    })

    await flow.step('4 · tracking typed, corrected and cleared on SEED-SO-0003’s shipment (a carrier booked by hand): "No live tracking"', async () => {
      const warehouse = await flow.desk('warehouse')
      const { page } = warehouse
      const shipments = ((await flow.read(page, `/sales/orders/${world.so3.id}`)).order.chain.shipments ?? []) as Json[]
      const typed = shipments.find((row) => row.mayTypeTracking?.allowed === true)
      if (!typed) {
        notHere('a shipment of SEED-SO-0003 whose number may be typed here (its carrier booked by hand): none in this world')
        return
      }
      await warehouse.go(`/sales/orders/${world.so3.id}?tab=shipments`)
      await typeTracking(page, typed.number, TRACKING[0], null)
      await seen(shipmentRow(page, typed.number).getByText(TRACKING[0]), 60_000)
      await seen(shipmentRow(page, typed.number).getByText(OD('ship.noLive')))
      await flow.shot(page, 'tracking-typed')
      await typeTracking(page, typed.number, TRACKING[1], TRACK_LINK)
      await seen(shipmentRow(page, typed.number).getByText(TRACKING[1]), 60_000)
      await expect(shipmentRow(page, typed.number).getByText(TRACKING[0])).toHaveCount(0)
      // The typed link beside the number: Track ›, the carrier's page in a new tab.
      await expect(shipmentRow(page, typed.number).getByRole('link', { name: startsWith(lead(OD('ship.track'))) }).first()).toHaveAttribute('href', TRACK_LINK)
      await typeTracking(page, typed.number, null, null)
      await expect(shipmentRow(page, typed.number).getByText(TRACKING[1])).toHaveCount(0, { timeout: 60_000 })
      await flow.settle()
    })

    await flow.step('5 · a shipment made elsewhere: the dialog on SEED-SO-0002 — its released garments, the paper DDT, no Nexus DDT number, the live rules', async () => {
      const warehouse = await flow.desk('warehouse')
      const { page } = warehouse
      await warehouse.go(`/sales/orders/${world.so2.id}?tab=shipments`)
      await press(page.getByRole('button', { name: OD('elsewhere.title'), exact: true }).first())
      const box = dialog(page)
      await seen(box.getByText(OD('elsewhere.noNexusDdt')), 60_000)
      await seen(box.getByText(OD('elsewhere.lines')).first())
      // One garment of the black 52 (released, on no shipment), the paper DDT as printed.
      const more = box.getByRole('button', { name: startsWith(lead(OD('elsewhere.plus'))) }).first()
      if ((await more.count()) === 0) {
        await seen(box.getByText(OD('elsewhere.noneReleased')))
        notHere('the record: nothing of SEED-SO-0002 is released and on no shipment in this world')
        await page.keyboard.press('Escape')
        return
      }
      await more.click()
      await box.getByRole('textbox', { name: startsWith(OD('elsewhere.ddtNumber')) }).fill(PAPER_DDT)
      await flow.shot(page, 'elsewhere-dialog')
      // The seeds date their releases in the story's days ahead: the live rule says so and holds Record ("Not before the garments
      // were released"). A world whose garments were released before today records it (B-OP-071 O4 does, behind a hold too).
      const record = box.getByRole('button', { name: startsWith(lead(OD('elsewhere.record_one'))) }).first()
      const beforeRelease = box.getByText(startsWith(lead(OD('elsewhere.beforeRelease')))).first()
      await expect(record).toBeVisible()
      if (await beforeRelease.isVisible().catch(() => false)) {
        await expect(record, 'held while the garments are released after the day it left').toBeDisabled()
        notHere('the record itself: the seeds’ garments are released in the story’s days ahead (B-OP-071 O4 records one)')
        await page.keyboard.press('Escape')
        return
      }
      await answerOf(page, 'POST', /^\/shipping\/shipments\/elsewhere$/, () => press(record), /^201$/)
      await seen(page.getByText(OD('elsewhere.chip', { ddt: PAPER_DDT })).first(), 60_000)
      await flow.settle()
    })

    await flow.step('6 · a combined shipment of two orders: before the switch held off in words; after it, SEED-SO-0002 added in place, "Also carries" on both; B’s orders never offered', async () => {
      const warehouse = await flow.desk('warehouse')
      const { page } = warehouse
      await warehouse.go(`/sales/orders/${world.so3.id}?tab=shipments`)
      await press(page.getByRole('button', { name: OD('step.createShipment'), exact: true }).first())
      const box = dialog(page)
      const others = box.getByRole('group', { name: SHIP('new.together.add', { customer: BRAND_ALPHA.legalName }) })
      await seen(others, 60_000)
      // Customer B's orders are never offered, before the switch or after it.
      for (const number of world.betaNumbers) await expect(box.getByText(number, { exact: true })).toHaveCount(0)
      await expectNothingOf(page, BRAND_BETA, world.betaNumbers, 'create shipment: the other orders offered')
      const other = others.getByRole('checkbox', { name: new RegExp(escape(world.so2.number)) }).first()
      await seen(other)
      if (!N6_ON) {
        // Held off until B-OP-047: offered with its words, never ticked (aria-disabled: it keeps its focus).
        await seen(others.getByText(DEPTH('shipOrders.later')).first())
        await expect(other).toHaveAttribute('aria-disabled', 'true')
        await flow.shot(page, 'shared-held-off')
        await page.keyboard.press('Escape')
        return
      }
      await other.check()
      const next = box.getByRole('button', { name: SHIP('new.next'), exact: true })
      if (await next.isVisible().catch(() => false)) await press(next)
      const all = box.getByRole('button', { name: SHIP('new.all'), exact: true })
      if (await all.isVisible().catch(() => false)) await all.click()
      const made = await answerOf(page, 'POST', /^\/shipping\/shipments$/, () => press(box.getByRole('button', { name: startsWith(lead(SHIP('new.create_other'))) }).first()), /^201$/)
      const shipment = made.shipment as Json
      await flow.settle()
      for (const [orderId, otherNumber] of [[world.so3.id, world.so2.number], [world.so2.id, world.so3.number]] as const) {
        await warehouse.go(`/sales/orders/${orderId}?tab=shipments`)
        await seen(shipmentRow(page, shipment.number as string), 60_000)
        await seen(shipmentRow(page, shipment.number as string).getByText(OD('ship.alsoCarries', { number: otherNumber })))
      }
      await flow.shot(page, 'shared-on-both')
    })

    await flow.step('7 · the files viewer walk by keys: → and ← over the order’s files, Esc back to the card', async () => {
      const { page } = sales
      await sales.go(`/sales/orders/${world.w3902.id}?tab=files`)
      const cards = page.locator('.fw-rtv-card-open')
      await page.waitForTimeout(2_000)
      const count = await cards.count()
      if (count < 2) {
        notHere(`the walk: SEED-SO-W39-02 shows ${count} file card(s) here (two at least to walk)`)
        return
      }
      await cards.first().click()
      const viewer = dialog(page)
      await seen(viewer.getByText(POPUPS('viewer.counter', { n: 1, count })).first(), 60_000)
      await page.keyboard.press('ArrowRight')
      await seen(viewer.getByText(POPUPS('viewer.counter', { n: 2, count })).first())
      await page.keyboard.press('ArrowLeft')
      await seen(viewer.getByText(POPUPS('viewer.counter', { n: 1, count })).first())
      await flow.shot(page, 'files-viewer')
      await page.keyboard.press('Escape')
      await expect(viewer).toBeHidden({ timeout: 30_000 })
      await expect(cards.first(), 'the focus is back on the card').toBeFocused()
    })

    await flow.step('8 · two customers: B’s portal answers A’s orders with the neutral refusal; A’s pages hold nothing of B; the page at rest asks little', async () => {
      const beta = await signInToPortal(flow, BRAND_BETA, betaId)
      for (const order of [world.order, world.so2, world.so3]) {
        await refusedToBeta(beta, `/orders/${order.id}`, ofAlpha, `beta address of ${order.number}`)
        await refusedToBeta(beta, `/open/SalesOrder/${order.id}`, ofAlpha, `beta open ${order.number}`)
      }
      // A's order page holds nothing of B, tab after tab.
      for (const tab of ['overview', 'lines', 'production', 'shipments', 'money', 'files']) {
        await sales.go(`/sales/orders/${world.order.id}?tab=${tab}`)
        await seen(tabs(sales.page), 60_000)
        await expectNothingOf(sales.page, BRAND_BETA, world.betaNumbers, `A's order · ${tab}`)
      }
      // The order page at rest (fx-12): no loop of router requests.
      await sales.go(`/sales/orders/${world.order.id}?tab=overview`)
      await seen(tabs(sales.page), 60_000)
      await sales.page.waitForTimeout(3_000)
      const quiet = await routerActivity(sales.page, 8_000, async () => {})
      expect(quiet.mostOneAddress, quiet.lines.join('\n')).toBeLessThanOrEqual(2)
      expect(quiet.documents, quiet.lines.join('\n')).toBe(0)
      // A's portal shows its own order (the made-up reference), never B.
      const alpha = await signInToPortal(flow, BRAND_ALPHA, alphaId)
      await alpha.go(`/orders/${world.order.id}`)
      await seen(alpha.page.getByText(PO_REF).first(), 60_000)
      await expectNothingOf(alpha.page, BRAND_BETA, world.betaNumbers, 'alpha portal order')
    })
  },
})
