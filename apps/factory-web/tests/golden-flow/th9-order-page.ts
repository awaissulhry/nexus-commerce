import { expect, test, type Locator, type Page } from '@playwright/test'
import { BRAND_ALPHA, BRAND_BETA } from '../../src/lib/testing/two-brands'
import { expectNothingOf } from './_harness/brand-scan'
import { seen, type Desk, type Flow } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { ensureBrand, signInToPortal, type PortalDesk } from './_harness/two-brands'
import { answerOf, byApi, day, dialog, pickDate, press, routerActivity } from './_harness/ui'
import { chooseFromMenu, pdf } from './_harness/ui' // F-OF T.2: a card's ⋯, the made-up files of step 16
import { startsWith, words } from './_harness/words'
// F-MS-106 (set the stage by hand): the customer's own stage and count words, and the domain's held words (no catalogue key has them).
import { COUNT_TO_FOLLOW_WORDS } from '@nexus/factory-domain/production-brand/portal-read'
import { STAGE_SET_REFUSAL_WORDS } from '@nexus/factory-domain/production-brand/stage-set'
import { READY_UNRELEASED_WORDS } from '@nexus/factory-domain/production-brand/stage-set' // F-SC-W5: Ready to ship by hand, warned
import { STAGE_WORDS } from '@nexus/factory-domain/production-brand/words'
// F-PT T.2 (order PRODUCTION tab): step 12's world, made through the real API (th9-production-world.ts, no stage of its own).
import { askState, productionWorld, WORLD_WORDS } from './th9-production-world'
// F-OC T.2 (order CHANGES tab): the request mail the customer's ask sends (the FAKE mailbox holds it).
import { APPROVAL_MAIL_TEMPLATES } from '@nexus/factory-domain/approvals-out/mail'
// F-OM T.2 (order MONEY tab): step 14's world, made through the real API (th9-money-world.ts, no stage of its own).
import { MONEY_WORDS, moneyWorld, scheduleOf } from './th9-money-world'

/**
 * F-OP-129 — UI golden flow TH-9: THE ORDER PAGE AT THE END (order page plan N1–N6; 10-order-page §2, §5, §7, §8, §13; review R-4,
 * R-6, R-7, R-9, R-11). Runs right after 16-close (stages.ts AFTER_STAGES) or alone on a fresh stack (`--stages th9-order-page`): it
 * makes its own world once — the seeded P1 as Brand Alpha and P3 as Brand Beta with their portal buyers (two-brands.ts), one order for
 * A typed by the Owner while a made-up rule asks Finance's yes of every typed order (set-up, as B-OP-071 O2), and the seeds' orders
 * of P1 (SEED-SO-0002, SEED-SO-0003 with released garments; SEED-SO-W39-01 waiting for a yes, SEED-SO-W39-02 with a change that asks
 * the yes again). Then, through the order page's screens, at 1440 × 900:
 *   1  the yes in place: the order the Owner typed waits — held for her ("another person decides", rule 42), confirmed in place by
 *      Finance with the code; SEED-SO-W39-01's credit yes is Finance's (the Owner reads who decides) and held in its stale words
 *      for Finance with the no as its door (the seeds give every request a made-up fingerprint, op-fx4); SEED-SO-W39-02's change
 *      refused in place with a reason and words (its yes is stale by design: the page says so and offers the no). Lane rule (Sales =
 *      no price): the acts with prices are the Owner's or Finance's; Sales keeps the no-price ones (the quantity change of step 3, D1);
 *   2  make a work order in place (the planner, the Production tab): a DRAFT of the new order; the production lane releases it
 *      (set-up: 10-work-order's flow);
 *   3  Lines changed in place (Sales, F-OL-05): Review and save says what each work order does — the released one waits for
 *      production, the new pieces follow now as a new DRAFT; Save changes; the planner decides the waiting change on the order page;
 *   4  tracking typed, corrected and cleared on SEED-SO-0003's shipment (a carrier booked by hand): "No live tracking";
 *   5  a shipment made elsewhere: the dialog on SEED-SO-0002 — its released garments, the paper DDT, no Nexus DDT number; the live
 *      rules said under the fields;
 *   6  a combined shipment of two orders (B-OP-047: N6 on) made in place on SEED-SO-0003 with SEED-SO-0002 added, "Also carries" on
 *      both orders; customer B's orders never offered;
 *   7  the files viewer walk by keys (→ / ←, Esc back to the card);
 *   8  two customers: B's portal answers A's orders with the neutral refusal; A's pages hold nothing of B; the page at rest asks little;
 *   9  F-OO-215 (order overview lane): SEED-SO-0002's Overview, sections 1–6 — the headline (SO2_HEADLINE), the strips and the moves
 *      row, a line's ⋯, the People rows, Next dates (Decide… when a refused date waits; Requested in its small dialog), Requests &
 *      changes whose groups add up to "Changes (N) ›" and the Changes badge, Linked records' counts = the tab badges;
 *  10  F-OO-215: sections 8 and 7 — a custom value saved beside Order facts sends the order's version (B-OO-014) and the page reads the
 *      order again (the office note saved next goes through at the new version); the sheet's edit at the version read before is stale.
 *  11  F-MS-106 (set the stage by hand) — F-SC-W5 (stage control B, the Owner's pick: full control): SEED-SO-W39-02, the Owner's own
 *      case (In production, no work order, no production state yet): the Planner clicks Sewing on the strip — the ONE dialog opens with
 *      Sewing picked — and sets it (System or scanners down, a note): the headline "In production · Sewing", the hand row with who and
 *      why, the History line, the Orders sheet's hand mark (ms-fx1: in Where it is on the customer page's Work tab, as Sales); P1's
 *      buyer reads a plain Sewing (no count is claimed), may still mark it Urgent (nothing cut), never "by hand"; the Planner clicks
 *      Ready to ship — the dialog warns quality has not released every piece — and sets it; Change… opens on Ready as it stands, held
 *      while nothing differs, and another reason alone is taken (the buyer told nothing); Change… down to Cutting says it is told as
 *      a correction — the buyer reads "Cutting · Count to follow"; on the Production tab a step of the stage bar opens the same dialog;
 *      Clear… says what the customer was told (the API's notice) → Preparing again; Sales sees the door held in words and the strip
 *      as its one link, and a Confirmed order shows the door held.
 *  12  F-PT (order PRODUCTION tab, T.2): the tab at the end, on the order of steps 1–3 — its world made by the API (supervisor, a
 *      production hold, Ask for an update as the tab sends it, the supervisor's reply in the thread, the promise moved twice): Sales'
 *      Ask for an update opens the ready ask; the reply answered it (C1) — Production now's "Latest update" quotes it; Dates & plan's
 *      promise history shows the moves and its We promised door opens the ONE promise dialog with its honest hint; the planner lifts
 *      the hold from Problems & holds (the strip's own Lift…, the ONE lift dialog); a Read-only person reads the tab with no act.
 *  13  F-OC (order CHANGES tab, T.2; L5, R1, B-OC-001, B-OC-002): the tab at the end, on the same order — Sales lowers a size on
 *      Lines and saves with the tick on: the customer is asked on the revision (POST /approvals-out, one ask), by e-mail to its orders
 *      contact (the FAKE mailbox holds the request mail and its link) and the notice says so; Waiting on Brand Alpha draws the revised
 *      order asked (never an amount); the brand's buyer, who may approve, confirms the new version in its portal with a typed name;
 *      the row is gone and What changed says "Customer said yes" on that revision; the planner decides the work-order change the
 *      save left waiting from Waiting › Still to do (Decide…, the ONE review window); a Read-only person reads the tab with no act.
 *      Step 9 also follows "Changes (N) ›" to the tab: its Waiting groups add up to the same N (ONE list).
 *  14  F-OM (order MONEY tab, T.2; L1, L3, B-OM-016, B-OM-017, B-OM-020): the tab at the end, on two orders of Brand Alpha made by the
 *      API (th9-money-world.ts) — Finance accepts the deposit short (bank charges) from its row's ⋯: it counts as paid and the band
 *      offers the planner Make work orders; the balance moved by hand says "Set by hand"; the margin shows the commission set by hand
 *      and the target; Accept the difference… from Price check's ⋯ → "Accepted by hand"; Undo this payment… on the other order's
 *      part payment; Sales reads words, never an amount, no money door, no Price check, no Margin; Read-only finds no act. B's buyer
 *      and A's Money: step 8 (?tab=money answers the neutral refusal).
 *  15  F-OS (order SHIPMENTS tab, T.2; plan D3–D6; 18-lead-settles L1, L8): the tab at the end, on the seeds' orders of P1 — on
 *      SEED-SO-0003, step 6's shared draft split into 3 in place (Warehouse's own Split, groups[]), a garment moved from it onto a
 *      new one, one new one merged into the other ("Merged into …"); SEED-SO-0002 taken off it in one go; a draft that travels
 *      without a DDT (a reason, "Set by hand") and its DDT put back; Tracking numbers… per parcel where a parcel may take one; on
 *      SEED-SO-0101's own-van shipment the expected arrival set by hand and Mark delivered… (no reason: our van) — the order follows;
 *      on SEED-SH-0001's carrier labels Mark delivered… with a reason ("Set by hand"); Sales and Read-only read every cell with no
 *      door; A's buyer reads the typed parcel numbers in the portal (B's portal refuses A's orders: step 8). Each part the world
 *      cannot give (no PACKED hand-booked shipment, no parcel without a label) is said in the report.
 *  16  F-OF (order FILES tab, T.2; 18-lead-settles L1–L9): the tab at the end, on SEED-SO-0002 — the Owner adds two files to Line 1 with
 *      Add files…; asks a person for a file (the Factory designer when the stack holds the role, else the Planner; said); as that
 *      person: Upload for this ask; back: "arrived to check" → Ask again… (why) → uploaded again → Accept… with "Share with {customer}"
 *      → A's buyer reads it in the portal's Documents; Rename… a file (a new version) → Versions… → Restore v1; Delete… the wrong file
 *      (why; the whole document); Sales reads the rows with the priced ask counted, never named; Read-only finds no Add, no Ask, and a
 *      card's ⋯ without Rename…. Step 7 (the viewer walk) is unchanged.
 * Not here, said in the report: cut pieces (the floor's flow: the extra-pieces outcome is held by the design case
 * lines-review-outcome, B-OP-071 O1 and the unit tests of F-OP-107), the record of a shipment made elsewhere whose garments the seeds
 * date in the story's days ahead (B-OP-071 O4 records one), and the invoices of a shared shipment that left (B-OP-045).
 */

const OD = words('orders')
const PROD = words('production')
const CF = words('admin-fields') // F-OO-215: the custom fields panel's words
const APPROVALS = words('approvals')
const DEPTH = words('warehouse-shipments-depth')
const POPUPS = words('record-thread-popups')
const PO = words('portal-orders')
const SHIP = words('shipments')
// F-OS-301 (order SHIPMENTS tab): the tab's own words (Tracking numbers…, the consignment number, Save the numbers).
const OS = words('order-shipments')
// F-MS-106: the portal's production list and the order's History.
const PPROD = words('portal-production')
const FEED = words('record-thread-feed')
// F-PT T.2: the lift dialog's and the note dialog's own words.
const PWO = words('production-work-orders')
const NOTES = words('production-notes')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A catalogue sentence's words before its first placeholder (the key's raw text). */
const lead = (text: string) => text.split(/\{[a-zA-Z]+\}/)[0]!.trim()
const notHere = (description: string) => test.info().annotations.push({ type: 'not here', description })

/** The made-up words of this stage. */
// op-fx4: a reference of this stage's own, not Brand Alpha's fixture one: th1a-sheet (later in the run) calls P1 Brand Beta and
// scans its rows for Brand Alpha's markers, the fixture's reference among them.
const PO_REF = 'T-TH9-PO-0001'
const TRACKING = ['T-TH9-TRK-0001', 'T-TH9-TRK-0002'] as const
const TRACK_LINK = 'https://track.example.com/T-TH9-TRK-0002'
const PAPER_DDT = 'T-TH9-77/2026'
const AMEND_REASON = 'Made-up: Brand Alpha wants two more 50 and one fewer 52.'
const DSW = words('ds-words') // F-OL-06: the DS bar's own words (its region)
const REFUSE_WORDS = 'Made-up: asked about an older version of the order; ask it again on this one.'
const LIFT_REASON = 'Made-up: the lining roll came in (TH9).' // F-PT T.2
// ---- F-OF T.2 (order FILES tab): step 16's words and files (made up; nobody of the floor named) ----
const FV = words('record-thread-files-view')
const FA = words('file-asks')
const RF = words('record-files')
const FILES_WORDS = {
  ask: 'Made-up: the pattern PDF for size 52, with seam allowances (TH9 step 16).',
  again: 'Made-up: the seam allowance is missing on the back panel (TH9 step 16).',
  priced: 'Made-up: the costed tech pack for the customer (TH9 step 16).',
  wrong: 'Made-up: uploaded to the wrong order (TH9 step 16).',
} as const
const FILES = { spec: pdf('T-TH9 size spec SEED-JKT-02'), wrong: pdf('T-TH9 wrong file'), first: pdf('T-TH9 pattern size 52 first'), second: pdf('T-TH9 pattern size 52 second') } as const
const SPEC_RENAMED = 't-th9-size-spec-seed-jkt-02-final.pdf'
// ---- end F-OF T.2
const CHANGE_REASON = 'Made-up: Brand Alpha wants one fewer 52 (TH9 step 13).' // F-OC T.2
// ---- F-OS T.2 (order SHIPMENTS tab): step 15's made-up words (office only; nobody of the floor named) ----
const SHIP_WORDS = Object.freeze({
  move: 'Made-up: one garment goes with the other draft (TH9 step 15).',
  takeOff: 'Made-up: SEED-SO-0002 leaves on its own date (TH9 step 15).',
  noDdt: 'Made-up: an immediate invoice travels with these goods (TH9 step 15).',
  ddtBack: 'Made-up: the DDT is issued after all (TH9 step 15).',
  labelled: 'Made-up: the customer confirmed the delivery by phone; the carrier never scanned it (TH9 step 15).',
  parcel: (seq: number) => `T-TH9-PCL-000${seq}`,
  eta: 'Made-up: the driver gave the day of the round (TH9 step 15).', // os-fx6
})
// ---- F-OO-215 (order overview lane): SEED-SO-0002's Overview ----
/**
 * SEED-SO-0002's headline as the seed gives it: its status words (its stage follows them, "Partly shipped · …"). B-OO-016 (Owner D9,
 * his pick A): the seed gives SEED-SO-0002 the status its facts give, PARTLY_SHIPPED (SEED-WO-0001 released, SEED-SH-0001 left with
 * part of it). Every other check of steps 9 and 10 asserts behaviour, never this status.
 */
const SO2_HEADLINE = OD('status.PARTLY_SHIPPED')
/** This stage's own order custom field (for every customer, office only) and its made-up values. */
const FIELD = { code: 'th9ui_box_note', labelEn: 'Box note TH9 (made up)', labelIt: 'Nota scatola TH9 (inventata)' } as const
const FIELD_VALUE = 'Made-up: two jackets per box, TH9 page'
const SHEET_VALUE = 'Made-up: from the sheet at the old version, TH9'
const OFFICE_NOTE = 'Made-up: call before delivery, TH9 office note.'
// ---- end F-OO-215
// ---- F-MS-106: the office's note beside the stage set by hand (never the customer's to read; never a person of the floor) ----
const HAND_NOTE = 'Made-up: the sewing room tablets were offline all morning, TH9.'

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
    // F-OO-111: the yes banner steps back on Overview (section 1's strip has the same doors, step 9): read on Lines, where it stays.
    await desk.go(`/sales/orders/${orderId}?tab=lines`)
    const yes = page.getByRole('button', { name: YES }).first()
    // op-fx4 (F-OP-101's doors): a reader who is not its approver reads who decides and gets no yes; the asker's yes is held.
    const notTheirs = page.getByText(new RegExp(`${escape(lead(OD('approval.whoDecides')))}|${escape(OD('approval.selfAsked'))}`))
    await seen(yes.or(notTheirs), 60_000)
    if (!(await yes.isVisible()) || !(await yes.isEnabled())) continue
    await answerOf(page, 'POST', /^\/approvals\/tasks\/[^/]+\/approve$/, async () => {
      await press(yes)
      await flow.stepUp(page, desk.person)
    })
    await seen(page.getByText(DONE).first(), 60_000)
    return desk
  }
  throw new Error(`the yes of ${orderId} is held for every desk asked (${desks.map((desk) => desk.person.key).join(', ')})`)
}

/**
 * The tracking dialog of a Shipments row: the number and its typed link (F-OP-135), saved or cleared. F-OS-301: the row's button is
 * "Tracking numbers…"; a shipment with parcels names its number "Consignment number (tracking, AWB or B/L)" and saves with "Save the
 * numbers" (one without parcels keeps "Tracking number" and Save).
 */
async function typeTracking(page: Page, number: string, tracking: string | null, link: string | null): Promise<void> {
  const row = shipmentRow(page, number)
  await seen(row, 60_000)
  await press(row.getByRole('button', { name: OS('ships.act.tracking'), exact: true }))
  const box = dialog(page)
  await seen(box)
  await box.getByRole('textbox', { name: OS('door.tracking.consignment'), exact: true }).or(box.getByRole('textbox', { name: DEPTH('transport.trackingNumber'), exact: true })).fill(tracking ?? '')
  if (link !== null) await box.getByRole('textbox', { name: DEPTH('transport.trackingLink'), exact: true }).fill(link)
  await press(tracking === null ? box.getByRole('button', { name: DEPTH('transport.clearTracking'), exact: true }) : box.getByRole('button', { name: OS('door.tracking.go'), exact: true }).or(box.getByRole('button', { name: DEPTH('transport.saveTracking'), exact: true })))
  await expect(box).toBeHidden({ timeout: 30_000 })
}

// ---- F-OO-215: the Overview's cards and the tab badges, as a reader finds them ----
/** An Overview card by its heading (the cards without a class of their own: Progress, Linked records, Order facts). */
const cardOf = (page: Page, title: string): Locator => page.locator('.fw-so-overview .nds-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
/** A tab's badge (its count), or null when the tab draws none. */
async function badgeOf(page: Page, tab: string): Promise<number | null> {
  const count = tabs(page).getByRole('link', { name: startsWith(OD(`tab.${tab}`)) }).first().locator('.nds-tab-count')
  return (await count.count()) > 0 ? Number((await count.innerText()).trim()) : null
}
/** The first number of a text ("5 · 2 in work" → 5), or null. */
const leadingNumber = (text: string): number | null => {
  const match = /^\s*(\d+)/.exec(text)
  return match ? Number(match[1]) : null
}
/** Opens a door (a dialog) and closes it with Escape — or, held, notes its words in the report; never pressed when held. */
async function openAndClose(page: Page, door: Locator, what: string): Promise<void> {
  await seen(door, 60_000)
  if ((await door.getAttribute('aria-disabled')) === 'true') {
    notHere(`${what}: held for this reader — ${(await door.getAttribute('aria-description')) ?? 'no words'}`)
    return
  }
  await press(door)
  const box = dialog(page)
  await seen(box, 60_000)
  await page.keyboard.press('Escape')
  await expect(box).toBeHidden({ timeout: 30_000 })
}
// ---- end F-OO-215

// ---- F-OC T.2: the brand's buyer may answer a yes ("Can approve"), as a customer that re-confirms its revised orders ----
async function buyerMayApprove(flow: Flow, office: Desk, partyId: string): Promise<void> {
  const access = await flow.read(office.page, `/partners/${partyId}`)
  const person = ((access.people ?? []) as Json[]).find((entry) => String(entry.email).toLowerCase() === BRAND_ALPHA.portalPerson.email.toLowerCase())
  expect(person, `${BRAND_ALPHA.tradeName}'s buyer is invited`).toBeTruthy()
  if ((person!.capabilities as string[]).includes('approve')) return
  byApi('the buyer’s "Can approve" (the customer page’s people window gives it; its own flow walks it)')
  await flow.write(office.page, 'POST', '/auth/office/step-up', { code: await flow.code(office.person) })
  await flow.write(office.page, 'PATCH', `/partners/${partyId}/people/${person!.id}`, { capabilities: [...new Set([...(person!.capabilities as string[]), 'approve'])], version: person!.version })
}
// ---- end F-OC T.2

/** Opens an address of A's record in B's portal and waits for its neutral words; the page holds nothing of A. */
async function refusedToBeta(beta: PortalDesk, path: string, ofAlpha: readonly string[], where: string): Promise<void> {
  await beta.go(path)
  await seen(beta.page.getByText(PO('record.missing')).first(), 60_000)
  await expectNothingOf(beta.page, BRAND_ALPHA, ofAlpha, where)
}

export default defineStage({
  proves:
    'the order page at the end: the Files tab at the end (F-OF T.2): Add files… to a line, an ask for a file uploaded, asked again, accepted and shared (the portal shows it), a file renamed and its v1 restored from Versions…, a wrong file deleted with a reason, Sales with the priced ask counted, Read-only with no act; the yes in place (a waiting order confirmed, a stale change refused with its reason; a yes the Owner asked is held for her); a work order made in place; edit mode’s strip says which work order follows now and which waits, Apply, the planner decides the waiting one on the order page; tracking typed, corrected and cleared ("No live tracking"); the made-elsewhere dialog with its paper DDT and its live rules; a combined shipment of two orders made in place (B-OP-047); the files viewer walk by keys; customer B never offered or shown A’s orders, A’s ids answer B’s neutral refusal; SEED-SO-0002’s Overview sections 1–8 (F-OO-215): the headline, strips and moves, a line’s ⋯, People, Next dates, Requests & changes = the Changes badge, Linked records = the tab badges, a custom value saved beside Order facts at the order’s version (the sheet’s edit at the old version stale), the office note saved after it; the Production tab at the end (F-PT T.2): the ready ask, the supervisor’s reply answering it (“Latest update”), the promise history and its door, a hold lifted from Problems & holds, Read-only with no act; the Changes tab at the end (F-OC T.2): a save with the tick asks the customer by e-mail (the FAKE mailbox), Waiting on the customer draws the revised order, the customer’s yes in its portal empties it and What changed says “Customer said yes”, the planner decides the waiting work-order change from Waiting, Read-only with no act; the Money tab at the end (F-OM T.2): a deposit accepted short (bank charges) counts as paid and the band offers Make work orders, the balance "Set by hand", the margin’s hand cost and target, a price difference accepted by hand, a part payment undone, Sales with words and no amount, Read-only with no act; the Shipments tab at the end (F-OS T.2): split into several, a garment moved and a draft merged ("Merged into …"), an order taken off a shared draft in one go, a draft that travels without a DDT and its DDT put back, tracking numbers per parcel, the expected arrival set by hand and Mark delivered on our van (the order follows), Mark delivered over carrier labels with a reason ("Set by hand"), Sales and Read-only with no door',
  async run(flow: Flow) {
    const sales = await flow.desk('sales')
    const alphaId = await flow.seedId('party:P1')
    const betaId = await flow.seedId('party:P3')

    const world = await flow.step('set-up: P1 as Brand Alpha and P3 as Brand Beta with their portal buyers; a made-up rule asks Finance’s yes; an order for A (the Owner’s, with its prices); the seeds’ orders of P1', async () => {
      await ensureBrand(flow, sales, BRAND_ALPHA, alphaId)
      await ensureBrand(flow, sales, BRAND_BETA, betaId)
      // op-fx4: the seeds' requests for a yes carry a made-up fingerprint (STALE for every approver: SEED-SO-W39-01's credit yes as
      // SEED-SO-W39-02's change), so the yes in place is proven on a fresh request, as B-OP-071 O2 does: a made-up rule — every order
      // typed for company A waits for Finance's yes — switched on before the Owner types hers, off again once decided (step 1).
      const owner = await flow.desk('owner')
      const finance = ((await flow.read(owner.page, '/auth/roles')).roles as Json[]).find((role) => role.key === 'finance')
      expect(finance, 'the finance role').toBeDefined()
      await flow.write(owner.page, 'POST', '/auth/office/step-up', { code: await flow.code(owner.person) })
      const created = (await flow.write(owner.page, 'POST', '/approvals/rules', { kind: 'SALES_ORDER', companyId: flow.companyId, name: 'Made-up: every typed order waits for Finance', condition: { combinator: 'and', rows: [{ id: 'r1', field: 'orderValue', operator: 'gt', value: '1' }] }, approver: { roleId: finance!.id }, sequence: 3, dueHours: 24 }, 201)).rule as Json
      await flow.write(owner.page, 'PUT', `/approvals/rules/${created.id}`, { version: created.version, active: true })
      // Lane rule (Sales = no price): an order typed with its prices is the Owner's; Sales keeps the no-price acts (step 3).
      const made = await flow.write(
        owner.page,
        'POST',
        '/sales/orders/manual',
        {
          companyId: flow.companyId,
          partyId: alphaId,
          customerRef: PO_REF,
          promiseDate: day(60),
          depositPct: null,
          // op-fx4: SEED-JKT-02 (the production seed's jacket of P1, its revision RELEASED with label, routing and BOM): step 2 releases
          // the work order made here; the product seed's SEED-JKT-01 stays a DRAFT revision, so its work order could never be released.
          lines: [{ styleId: await flow.seedId('production:style:JKT-02'), colourwayId: await flow.seedId('production:colourway:JKT-02:BLK'), unitPrice: '100', sizes: [{ size: '50', quantity: 4 }, { size: '52', quantity: 4 }] }],
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
      return { order: { id: made.order.id as string, number: made.order.number as string, status: made.order.status as string }, rule: created.id as string, ...seeded, betaNumbers: betaOrders.map((row) => row.number as string) }
    })
    const ofAlpha = [world.order.number, world.order.id, world.so2.number, world.so2.id, world.so3.number, world.so3.id, PO_REF, ...TRACKING, PAPER_DDT]

    await flow.step('1 · the yes in place: the Owner’s typed order held for her, confirmed by Finance with the code; SEED-SO-W39-01’s stale credit yes held for Finance; SEED-SO-W39-02’s change refused in place with its reason', async () => {
      const owner = await flow.desk('owner')
      const finance = await flow.desk('finance')
      // The yes the Owner asked (the set-up's made-up rule holds her typed order): held for its asker (rule 42, the Owner included),
      // confirmed in place by Finance with the code; the rule off again.
      expect(world.order.status, 'the made-up rule holds the typed order').toBe('PENDING_APPROVAL')
      // F-OO-111: the yes banner is read on Lines (it steps back on Overview, where section 1's strip has the same doors).
      await owner.go(`/sales/orders/${world.order.id}?tab=lines`)
      const own = owner.page.getByRole('button', { name: YES })
      await seen(owner.page.getByText(OD('approval.selfAsked')).first(), 60_000)
      if ((await own.count()) > 0) await expect(own.first(), 'nobody approves their own request').toBeDisabled()
      const decided = await yesInPlace(flow, [finance], world.order.id)
      await flow.shot(decided.page, 'yes-confirmed')
      await expect.poll(() => statusOf(flow, owner.page, world.order.id), { timeout: 60_000 }).toBe('CONFIRMED')
      const rule = (await flow.read(owner.page, `/approvals/rules/${world.rule}`)).rule as Json
      await flow.write(owner.page, 'POST', '/auth/office/step-up', { code: await flow.code(owner.person) })
      await flow.write(owner.page, 'PUT', `/approvals/rules/${world.rule}`, { version: rule.version, active: false })

      // SEED-SO-W39-01 waits for its credit yes, Finance's: the Owner reads who decides (no yes of hers); Finance reads the yes held in
      // its stale words (the seeds' made-up fingerprint) and the no as its door — not decided here.
      await owner.go(`/sales/orders/${world.w3901.id}?tab=lines`) // F-OO-111: the banner's "Who decides" stays on Lines
      await seen(owner.page.getByText(OD('approval.whoDecides', { who: 'Finance' })).first(), 60_000)
      await expect(owner.page.getByRole('button', { name: YES }), 'the Owner is not its approver').toHaveCount(0)
      await finance.go(`/sales/orders/${world.w3901.id}?tab=lines`) // F-OO-111
      await expect(finance.page.getByRole('button', { name: OD('approval.refuse'), exact: true }).first(), 'its no is Finance’s door').toBeEnabled({ timeout: 60_000 })
      await expect(finance.page.getByRole('button', { name: YES }).first(), 'its yes is stale: held').toBeDisabled()
      await flow.shot(finance.page, 'yes-stale-held')

      // SEED-SO-W39-02's change asks the Owner's role about an older version of the order (the seeds' made-up fingerprint: STALE by
      // design, op-19): the page holds the yes in the stale words before any press (op-fx4: the read says so, F-OP-101) and offers
      // the no, given in place with a reason and words.
      const { page } = owner
      // End check fix wave: this yes is the old change's (SALES_ORDER_CHANGE), which no banner ever holds (depth/model.ts
      // BANNER_YES_KINDS: the order's own and the credit's only): it is decided on its waiting row, place REQUEST, which Overview's
      // Requests & changes draws among the rows waiting on us (every one shown, F-OO-205). Lines draws no such row.
      await owner.go(`/sales/orders/${world.w3902.id}?tab=overview`)
      const yes = page.getByRole('button', { name: YES }).first()
      await seen(yes, 60_000)
      const refuse = page.getByRole('button', { name: OD('approval.refuse'), exact: true }).first()
      await expect(refuse, 'its no is the Owner’s door').toBeEnabled({ timeout: 60_000 })
      await expect(yes, 'its yes is stale: held').toBeDisabled()
      await expect(yes).toHaveAttribute('aria-description', OD('approval.refused.STALE'))
      await press(refuse)
      const box = dialog(page)
      const why = box.getByRole('combobox', { name: OD('approval.no.reason') })
      await seen(why, 60_000)
      await why.selectOption({ index: 1 })
      await box.getByRole('textbox', { name: startsWith(OD('approval.no.words')) }).fill(REFUSE_WORDS)
      await answerOf(page, 'POST', /^\/approvals\/tasks\/[^/]+\/reject$/, () => press(box.getByRole('button', { name: OD('approval.refuseGo'), exact: true })))
      await seen(page.getByText(OD('approval.refusedDone')).first(), 60_000)
      await flow.shot(page, 'yes-refused')
      await flow.settle()
      const after = (await flow.read(owner.page, `/sales/orders/${world.w3902.id}`)).order as Json
      expect(((after.openApprovals ?? []) as Json[]).filter((row) => row.kind === 'SALES_ORDER_CHANGE'), 'the change’s yes is decided').toEqual([])
    })

    const workOrder = await flow.step('2 · make a work order in place: the planner on the Production tab (Work orders’ own Make work orders) → New work order → its DRAFT; released by the production lane', async () => {
      const planner = await flow.desk('planner')
      await planner.go(`/sales/orders/${world.order.id}?tab=production`)
      // F-PT-104 (T.2): the button is the Work orders section's own (#work-orders), in its head — the same words as before.
      const make = planner.page.locator('#work-orders').getByRole('button', { name: new RegExp(`^(${escape(OD('step.makeWorkOrders'))}|${escape(lead(OD('wo.makeNext')))})`) }).first()
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

    await flow.step('3 · Lines changed in place (Sales): Review and save says the released work order waits and the new pieces follow now; Save changes; the planner decides the waiting change in place', async () => {
      const { page } = sales
      await sales.go(`/sales/orders/${world.order.id}?tab=lines`)
      // F-OL-06 (Order LINES lane): no edit mode — the boxes are in the table, each named "{colour}, size {size}". Two more 50 (a new
      // DRAFT follows now), one fewer 52 (the released work order waits for production): one piece more, so the amount changes.
      const table = page.locator('.fw-lt')
      const size50 = table.getByRole('textbox', { name: /, size 50$/ }).first()
      const size52 = table.getByRole('textbox', { name: /, size 52$/ }).first()
      await seen(size50, 60_000)
      await expect(size50).toHaveValue('4')
      await size50.fill('6')
      await size52.fill('3')
      // The mark beside each changed cell ("was 4") and the bar: ONE line changed, "1 change not saved".
      await expect(table.getByText(OD('lines.cell.was', { value: 4 }), { exact: true })).toHaveCount(2)
      const bar = page.getByRole('region', { name: DSW('editModeBar.region'), exact: true })
      await seen(bar.getByText(OD('save.count', { count: 1 }), { exact: true }))
      // Sales sees no money while changing: no price column, no line total, no totals, no currency anywhere on the tab.
      await expect(table.getByRole('columnheader', { name: OD('lines.col.unitPrice'), exact: true })).toHaveCount(0)
      await expect(table.getByRole('columnheader', { name: OD('lines.col.lineTotal'), exact: true })).toHaveCount(0)
      await expect(table).not.toContainText('€')
      await seen(table.getByText(OD('lines.head.salesHow'), { exact: true }))
      await flow.shot(page, 'lines-changing-sales')
      await press(bar.getByRole('button', { name: OD('save.review'), exact: true }))
      const reviewWindow = dialog(page)
      await seen(reviewWindow, 60_000)
      const production = reviewWindow.getByRole('region', { name: OD('review.production'), exact: true })
      await seen(production.getByText(OD('edit.strip.wo.waits'), { exact: false }).first(), 60_000)
      await expect(production.getByText(OD('edit.strip.wo.waits'), { exact: false }).first()).toContainText(workOrder.number)
      await seen(production.getByText(OD('edit.strip.wo.now'), { exact: false }).first())
      // Review and save for Sales: the pieces 8 → 9, "The amount changes" — never an amount, never which way it moved.
      await seen(reviewWindow.getByText(OD('review.pieces', { before: 8, after: 9, delta: '+1' }), { exact: true }))
      await seen(reviewWindow.getByText(OD('review.amountNeutral'), { exact: true }))
      await expect(reviewWindow).not.toContainText('€')
      const why = reviewWindow.getByRole('textbox', { name: startsWith(OD('review.whyWords')) })
      if ((await why.count()) > 0) await why.first().fill(AMEND_REASON)
      // The tick: on by default (the amount changes, as Sales reads it), said in words; taken off here (the ask is the approvals
      // lane's flow), and then the words say the customer is not asked.
      const ask = reviewWindow.getByRole('checkbox', { name: startsWith(lead(OD('review.ask'))) })
      await expect(ask).toBeChecked()
      await seen(reviewWindow.getByText(OD('review.askChanges'), { exact: true }))
      await ask.uncheck()
      await seen(reviewWindow.getByText(OD('review.askOff'), { exact: true }))
      await flow.shot(page, 'review-sales')
      const applied = await answerOf(page, 'POST', /^\/sales\/orders\/[^/]+\/amendments$/, () => press(reviewWindow.getByRole('button', { name: OD('review.save'), exact: true })))
      expect((applied.workOrders.waiting as Json[]).map((entry) => entry.workOrderId)).toEqual([workOrder.id])
      expect((applied.workOrders.applied as Json[]).map((entry) => entry.route)).toEqual(['NEW_DRAFT'])
      // Not ticked: nothing asked of the customer (no re-acceptance), and no REVISED_ORDER question sent.
      expect(applied.amendment).toMatchObject({ reacceptance: 'NOT_NEEDED' })
      // The toast names what followed and what waits; the bar is gone, the boxes say the saved pieces.
      const changed = (applied.workOrders.applied as Json[]).map((entry) => entry.number).filter(Boolean).join(', ')
      await seen(page.getByText(OD('save.done.both', { changed, waits: workOrder.number }), { exact: true }).first(), 60_000)
      await expect(bar).toHaveCount(0)
      await expect(size50).toHaveValue('6')
      await expect(size52).toHaveValue('3')
      await flow.settle()

      // The planner decides it on the order page (F-OP-116, A14) — F-PT-105 (T.2): in Work orders' ONE strip "Waiting for a
      // decision", each change one row with its Decide…, which opens the ONE review window (Approvals' WorkOrderChangeReview as is)
      // → Lower to the order.
      const planner = await flow.desk('planner')
      await planner.go(`/sales/orders/${world.order.id}?tab=production`)
      const strip = planner.page.locator('#work-orders .fw-pt-dec')
      await seen(strip.getByText(OD('productionTab.wo.decisions'), { exact: true }), 60_000)
      const waiting = strip.locator('.fw-pt-dec-row').first()
      await press(waiting.getByRole('button', { name: OD('productionTab.wo.decide'), exact: true }))
      const review = dialog(planner.page)
      await seen(review, 60_000)
      await answerOf(planner.page, 'POST', /^\/production\/work-order-changes\/[^/]+\/apply$/, async () => {
        await press(review.getByRole('button', { name: APPROVALS('workOrderChange.apply.LOWER_TO_ORDER'), exact: true }))
        await flow.stepUp(planner.page, planner.person)
      })
      await seen(planner.page.getByText(OD('wo.changeApplied', { number: workOrder.number })).first(), 60_000)
      await flow.settle()
      // Decided: the strip is gone (nothing waits on this order any more).
      await expect(planner.page.locator('#work-orders .fw-pt-dec')).toHaveCount(0, { timeout: 60_000 })
      await flow.shot(planner.page, 'change-decided')
    })

    await flow.step('4 · tracking typed, corrected and cleared on a packed shipment of SEED-SO-0003 or SEED-SO-0002 (a carrier booked by hand): "No live tracking"', async () => {
      const warehouse = await flow.desk('warehouse')
      const { page } = warehouse
      // os-fx7 (W-01): Tracking numbers… is drawn only on a CARRIER shipment PACKED or SHIPPED with a parcel no label tracks — never
      // on a draft. A PACKED one here: a number the customer has not seen yet changes without a reason (after the goods left it asks why).
      const drawn = (row: Json): boolean => row.mayTypeTracking?.allowed === true && row.transportBy === 'CARRIER' && row.status === 'PACKED' && (((row.parcels ?? []) as Json[]).length === 0 || ((row.parcels ?? []) as Json[]).some((parcel) => parcel.source !== 'LABEL'))
      let typed: Json | null = null
      let typedOrder = world.so3.id
      for (const orderId of [world.so3.id, world.so2.id]) {
        const found = (((await flow.read(page, `/sales/orders/${orderId}`)).order.chain.shipments ?? []) as Json[]).find(drawn)
        if (found && !typed) {
          typed = found
          typedOrder = orderId
        }
      }
      if (!typed) {
        notHere('a packed shipment of SEED-SO-0003 or SEED-SO-0002 whose number may be typed here (its carrier booked by hand): none in this world')
        return
      }
      await warehouse.go(`/sales/orders/${typedOrder}?tab=shipments`)
      await typeTracking(page, typed.number, TRACKING[0], null)
      await seen(shipmentRow(page, typed.number).getByText(TRACKING[0]), 60_000)
      await seen(shipmentRow(page, typed.number).getByText(OD('ship.noLive')))
      await flow.shot(page, 'tracking-typed')
      await typeTracking(page, typed.number, TRACKING[1], TRACK_LINK)
      await seen(shipmentRow(page, typed.number).getByText(TRACKING[1]), 60_000)
      await expect(shipmentRow(page, typed.number).getByText(TRACKING[0])).toHaveCount(0)
      // The typed link beside the number: Track ›, the carrier's page in a new tab (op-fx4: named by its label, "Track shipment <n> on
      // the carrier's site" — the screen reader's words; "Track ›" is what it shows).
      const track = shipmentRow(page, typed.number).getByRole('link', { name: OD('ship.trackLink', { number: typed.number }), exact: true }).first()
      await expect(track).toHaveAttribute('href', TRACK_LINK)
      await expect(track).toHaveText(OD('ship.track'))
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
      // op-fx4: the garments come with the dialog's own read — wait for them, or for the words that none is free.
      await seen(more.or(box.getByText(OD('elsewhere.noneReleased'))), 60_000)
      if (!(await more.isVisible())) {
        notHere('the record: nothing of SEED-SO-0002 is released and on no shipment in this world')
        await page.keyboard.press('Escape')
        return
      }
      await more.click()
      await box.getByRole('textbox', { name: startsWith(OD('elsewhere.ddtNumber')) }).fill(PAPER_DDT)
      // op-fx4: a carrier booked by hand is named (else Record is held for the empty field, whatever the dates say).
      await box.getByRole('textbox', { name: OD('ship.col.carrier'), exact: true }).fill('Made-up Courier')
      await flow.shot(page, 'elsewhere-dialog')
      // The seeds date their releases in the story's days ahead: the live rule says so and holds Record ("Not before the garments
      // were released"). A world whose garments were released before today records it (B-OP-071 O4 does, behind a hold too).
      const record = box.getByRole('button', { name: startsWith(lead(OD('elsewhere.record_one'))) }).first()
      const beforeRelease = box.getByText(startsWith(lead(OD('elsewhere.beforeRelease')))).first()
      await expect(record).toBeVisible()
      // op-fx4: the rule comes with the dialog's preview ("Checking what the shipment would say…"): wait for it, or for Record free.
      await seen(beforeRelease.or(box.getByRole('button', { name: startsWith(lead(OD('elsewhere.record_one'))), disabled: false })), 60_000)
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

    await flow.step('6 · a combined shipment of two orders (B-OP-047): SEED-SO-0002 added in place, "Also carries" on both; B’s orders never offered', async () => {
      const warehouse = await flow.desk('warehouse')
      const { page } = warehouse
      await warehouse.go(`/sales/orders/${world.so3.id}?tab=shipments`)
      await press(page.getByRole('button', { name: OD('step.createShipment'), exact: true }).first())
      const box = dialog(page)
      const others = box.getByRole('group', { name: SHIP('new.together.add', { customer: BRAND_ALPHA.legalName }) })
      await seen(others, 60_000)
      // Customer B's orders are never offered.
      for (const number of world.betaNumbers) await expect(box.getByText(number, { exact: true })).toHaveCount(0)
      await expectNothingOf(page, BRAND_BETA, world.betaNumbers, 'create shipment: the other orders offered')
      const other = others.getByRole('checkbox', { name: new RegExp(escape(world.so2.number)) }).first()
      await seen(other)
      // B-OP-047: it may join (the same address, currency and terms): offered free, never held.
      await expect(other).not.toHaveAttribute('aria-disabled', 'true')
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

    // ---- F-OO-215 (order overview lane, plan sections 1–8): SEED-SO-0002's Overview, read by Sales (orders.manage, no prices) ----------
    await flow.step('9 · SEED-SO-0002’s Overview, sections 1–6: the headline, the strips and the moves row, a line’s ⋯, People, Next dates (Decide…, Requested), Requests & changes = the Changes badge, Linked records = the tab badges', async () => {
      const { page } = sales
      await sales.go(`/sales/orders/${world.so2.id}?tab=overview`)
      await seen(page.locator('.fw-so-overview'), 60_000)

      // 1 · Where it is now: the headline (status · stage, SO2_HEADLINE first), the strips (at most 4 shown, each at most 3 real
      // buttons, its words), the order's own moves (More ▾ named for the order, every move there held with words or live).
      const where = page.locator('.fw-so-where')
      await expect(where.locator('.fw-so-headline')).toHaveText(startsWith(SO2_HEADLINE), { timeout: 60_000 })
      const strips = where.getByRole('list', { name: OD('where.strips'), exact: true })
      if ((await strips.count()) > 0) {
        const shown = strips.locator('li.fw-so-strip')
        const count = await shown.count()
        expect(count, 'at most four strips in view').toBeLessThanOrEqual(4)
        for (let index = 0; index < count; index += 1) {
          expect(await shown.nth(index).getByRole('button').count(), `strip ${index + 1}: at most three buttons`).toBeLessThanOrEqual(3)
          expect((await shown.nth(index).locator('.fw-so-strip-said').innerText()).trim(), `strip ${index + 1} says why`).not.toBe('')
        }
      } else notHere('the strips: nothing holds SEED-SO-0002 in this world (no hold, no yes, no deposit waits)')
      const moves = where.getByRole('group', { name: OD('where.moves'), exact: true })
      if ((await moves.count()) > 0) {
        const more = moves.getByRole('button', { name: OD('where.moreOf', { number: world.so2.number }), exact: true })
        if ((await more.count()) > 0) {
          await press(more)
          await seen(page.getByRole('menuitem').first())
          await page.keyboard.press('Escape')
        }
      } else notHere('the moves row: SEED-SO-0002 offers this reader no move of its own here (a final order, or read-only)')
      await flow.shot(page, 'overview-where')

      // 2 · Progress by line: a line's ⋯ offers the line's own moves (each the band's dialog, held with words when it may not run).
      const lineMoves = cardOf(page, OD('overview.progress')).getByRole('button', { name: startsWith(lead(OD('progress.moves'))) }).first()
      if ((await lineMoves.count()) > 0) {
        await press(lineMoves)
        const moveWords = (['make', 'close', 'reopen', 'change', 'discuss'] as const).map((move) => escape(OD(`progress.move.${move}`)))
        await seen(page.getByRole('menuitem', { name: new RegExp(`^(${moveWords.join('|')})`) }).first())
        await page.keyboard.press('Escape')
      } else notHere('a line’s ⋯: no line of SEED-SO-0002 offers this reader a move')

      // 3 · People: one list — the supervisor, the backup, who answers the customer (a name and why, or "No owner yet": never "—"),
      // where it is made; or, for a reader who does not follow production, the card says who sees it.
      const people = page.locator('.fw-so-people')
      const supervisorRow = people.locator('li').filter({ has: page.locator('.fw-so-ov-label', { hasText: OD('people.supervisor') }) })
      await seen(supervisorRow.first().or(people.getByText(OD('overview.people.held'))), 60_000)
      if ((await supervisorRow.count()) > 0) {
        for (const label of [OD('overview.people.backup'), OD('overview.people.answers'), OD('overview.people.where')]) await seen(people.locator('.fw-so-ov-label', { hasText: label }).first())
        const answers = people.locator('li').filter({ has: page.locator('.fw-so-ov-label', { hasText: OD('overview.people.answers') }) }).first()
        expect((await answers.innerText()).replace(OD('overview.people.answers'), '').trim(), 'who answers the customer is named (or "No owner yet"), never "—"').not.toMatch(/^—/)
      }

      // 4 · Next dates: Decide… on a new date the customer refused (the ONE promise dialog), Requested by customer's Change… in its
      // small dialog (an amendment: opened and closed here, nothing written).
      const dates = page.locator('.fw-so-dates')
      await seen(dates, 60_000)
      const decide = dates.getByRole('button', { name: OD('dates.decide'), exact: true })
      if ((await decide.count()) > 0) await openAndClose(page, decide.first(), 'Next dates’ Decide…')
      else notHere('Decide…: no new date of SEED-SO-0002 was refused by the customer in this world')
      const requested = dates.locator('li').filter({ hasText: OD('dates.requestedByCustomer') }).getByRole('button', { name: OD('doors.change'), exact: true })
      await openAndClose(page, requested.first(), 'Requested by customer’s Change…')

      // 5 · Requests & changes: its groups (on us · on the customer · still to do) add up to "Changes (N) ›", which is the Changes badge.
      const requests = page.locator('.fw-so-rq')
      await seen(requests, 60_000)
      const changesLink = requests.getByRole('link', { name: new RegExp(`^${escape(lead(OD('requests.changesCount')))}\\s*\\d+\\)`) })
      await seen(changesLink, 60_000)
      const changes = Number(/\((\d+)\)/.exec(await changesLink.innerText())![1])
      const heads = await requests.locator('.fw-so-rq-group > h3').allInnerTexts()
      const groups = heads.map((head) => Number(/·\s*(\d+)\s*$/.exec(head)?.[1] ?? NaN))
      expect(groups.every((count) => Number.isInteger(count)), `each group says its count: ${heads.join(' | ')}`).toBe(true)
      expect(groups.reduce((sum, count) => sum + count, 0), `the groups add up to Changes (${changes})`).toBe(changes)
      expect(await badgeOf(page, 'changes'), 'the Changes badge is the card’s number').toBe(changes)
      // The walk's seed says 1 / 1 / 1 and Changes (3) on main; what this world shows is noted (behaviour is asserted above).
      test.info().annotations.push({ type: 'SEED-SO-0002 requests', description: `${heads.join(' · ') || 'none'} · Changes (${changes})` })

      // 6 · Linked records: one count rule — the Work orders and Shipments rows' number is the Production / Shipments badge.
      const linked = cardOf(page, OD('overview.linked.title'))
      await seen(linked, 60_000)
      for (const [label, tab] of [[OD('overview.linked.workOrders'), 'production'], [OD('overview.linked.shipments'), 'shipments']] as const) {
        const row = linked.locator('li.fw-so-ov-row').filter({ has: page.locator('.fw-so-ov-label', { hasText: label }) })
        const badge = await badgeOf(page, tab)
        if ((await row.count()) === 0) {
          // None yet (the quiet line): no number on the card, and none (or 0) on the tab.
          expect(badge ?? 0, `${label}: none on the card, none on the ${tab} tab`).toBe(0)
          continue
        }
        // The row is label | value | doors: its value ("5 · 2 in work · …", a link to the tab) starts with the live count.
        const shown = leadingNumber(await row.first().locator(':scope > *').nth(1).innerText())
        expect(shown, `${label}: the card says a number`).not.toBeNull()
        expect(badge, `${label}: the card's number is the ${tab} badge`).toBe(shown)
      }
      await expectNothingOf(page, BRAND_BETA, world.betaNumbers, 'SEED-SO-0002 overview')
      await flow.shot(page, 'overview-so2')
      // F-OC T.2: "Changes (N) ›" opens the Changes tab, whose Waiting groups (on us · on the customer · still to do) add up to the
      // same N — the card, the badge and the tab are ONE list.
      await press(changesLink)
      const waiting = page.locator('#waiting')
      await seen(waiting, 60_000)
      await expect(page).toHaveURL(/[?&]tab=changes/)
      const tabHeads = await waiting.locator('.fw-oc-grp-h > h3').allInnerTexts()
      const tabGroups = tabHeads.map((head) => Number(/·\s*(\d+)\s*$/.exec(head)?.[1] ?? NaN))
      expect(tabGroups.every((count) => Number.isInteger(count)), `each Waiting group says its count: ${tabHeads.join(' | ')}`).toBe(true)
      expect(tabGroups.reduce((sum, count) => sum + count, 0), `the Changes tab's Waiting adds up to Changes (${changes})`).toBe(changes)
    })

    await flow.step('10 · SEED-SO-0002’s Overview, sections 8 and 7: a custom value saved beside Order facts at the order’s version (the sheet at the old version is stale), then the office note saved at the new one', async () => {
      const { page } = sales
      // Set-up: this stage's order custom field, for every customer, office only (th4-sheet makes one through Admin › Fields & lists).
      const owner = await flow.desk('owner')
      const known = ((await flow.read(owner.page, '/fields/editor?recordType=ORDER')).fields ?? []) as Json[]
      if (!known.some((field) => field.code === FIELD.code)) {
        byApi('this stage’s order custom field (th4-sheet makes one through Admin › Fields & lists)')
        await flow.write(owner.page, 'POST', '/auth/office/step-up', { code: await flow.code(owner.person) })
        await flow.write(owner.page, 'POST', '/fields', { recordType: 'ORDER', type: 'TEXT', shownInPortal: false, ...FIELD }, 201)
      }
      await sales.go(`/sales/orders/${world.so2.id}?tab=overview`)

      // 8 · Custom fields: the pair's second card, beside Order facts (the order page only: never at the body's end).
      const fields = page.getByRole('region', { name: CF('cf.title'), exact: true })
      await seen(fields, 60_000)
      await expect(page.locator('.fw-so-ov-pair').filter({ has: fields }).getByRole('heading', { name: OD('overview.facts.title'), exact: true })).toBeVisible()
      await expect(page.getByRole('region', { name: CF('cf.title'), exact: true })).toHaveCount(1)
      const before = (await flow.read(page, `/sales/orders/${world.so2.id}`)).order.version as number
      await press(fields.getByRole('button', { name: CF('cf.edit'), exact: true }))
      await fields.getByRole('textbox', { name: startsWith(FIELD.labelEn) }).fill(FIELD_VALUE)
      // The save sends the order's version as read (B-OO-014) and moves it by one.
      const sent = page.waitForRequest((request) => request.method() === 'PUT' && /\/fields\/values\/ORDER\/[^/?]+$/.test(new URL(request.url()).pathname), { timeout: 60_000 })
      // F-OO-213: the page reads the order again once the save moved its version (no live message says it).
      const reread = page.waitForResponse(async (response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/sales/orders/${world.so2.id}` && response.status() === 200 && ((await response.json().catch(() => null)) as Json | null)?.order?.version === before + 1, { timeout: 60_000 })
      const saved = await answerOf(page, 'PUT', /^\/fields\/values\/ORDER\/[^/]+$/, () => press(fields.getByRole('button', { name: startsWith(CF('cf.save')) }).first()))
      expect((await sent).postDataJSON(), 'the save sends the order’s version').toMatchObject({ recordVersion: before })
      expect(saved.recordVersion, 'the order’s version moved with its value').toBe(before + 1)
      await reread // the page holds the order at its new version: the next command (the office note) is sent at it
      await seen(fields.getByText(FIELD_VALUE), 60_000)
      await flow.shot(page, 'custom-value-saved')

      // The Orders sheet's edit at the version it read before the page's save: stale, the page's value stays (the lost update, fixed).
      byApi('the Orders sheet’s apply at the version read before the page’s save (th4-sheet walks the sheet’s screens)')
      const late = await flow.write(page, 'POST', '/views/bulk/apply', { listKey: 'sales.orders', rows: [{ id: world.so2.id, version: before, changes: { [`cf:${FIELD.code}`]: SHEET_VALUE } }] })
      expect((late.results as Json[])[0], 'the sheet at the old version').toMatchObject({ ok: false, refusal: { code: 'stale' } })
      const values = (await flow.read(page, `/fields/values/ORDER/${world.so2.id}`)).values as Json[]
      expect(values.find((value) => value.code === FIELD.code)?.value, 'the page’s value stays').toBe(FIELD_VALUE)

      // 7 · Order facts: the office note, saved through the sheet's own write at the version the page holds NOW — the page read the
      // order again after the custom value moved it (F-OO-213), so this is not refused as changed.
      const facts = cardOf(page, OD('overview.facts.title'))
      const noteRow = facts.locator('li.fw-so-fact-note')
      await seen(noteRow, 60_000)
      await press(noteRow.getByRole('button', { name: OD('doors.change'), exact: true }))
      const box = dialog(page)
      await seen(box.getByText(OD('facts.note.title', { number: world.so2.number })), 60_000)
      await box.getByRole('textbox', { name: startsWith(OD('facts.note.label')) }).fill(OFFICE_NOTE)
      const applied = await answerOf(page, 'POST', /^\/views\/bulk\/apply$/, () => press(box.getByRole('button', { name: OD('facts.note.go'), exact: true })))
      expect((applied.results as Json[])[0], 'the note at the page’s version').toMatchObject({ ok: true })
      await seen(page.getByText(OD('facts.note.saved')).first(), 60_000)
      await seen(noteRow.getByText(OFFICE_NOTE), 60_000)
      expect((await flow.read(page, `/sales/orders/${world.so2.id}`)).order.version, 'the note moved the version once more').toBe(before + 2)
      await flow.shot(page, 'office-note-saved')
      await flow.settle()
    })
    // ---- end F-OO-215

    // ---- F-MS-106 (set the stage by hand: the browser end test; review R1, R3, R4, R8, R13, R17; Owner D1–D9) -----------------------
    await flow.step('11 · the stage set by hand on SEED-SO-W39-02 (the Owner’s case, stage control B): the Planner clicks Sewing on the strip and sets it — headline, the hand row, the list’s mark, the History; P1 reads a plain Sewing, may still mark it Urgent; Ready to ship clicked — warned — and set; Change… of the reason alone; Change… down to Cutting (a correction) reads "Count to follow"; the Production tab’s stage bar opens the same dialog; Clear… → Preparing; held for Sales (the strip its one link) and on a Confirmed order', async () => {
      const planner = await flow.desk('planner')
      const { page } = planner
      const order = world.w3902
      const where = page.locator('.fw-so-where')
      const headline = where.locator('.fw-so-headline')
      const handRow = where.locator('.fw-so-hand')
      const stageWord = (code: 'PREPARING' | 'CUTTING' | 'SEWING' | 'QUALITY' | 'READY') => PROD(`parts.stage.${code}`)
      // F-SC-W5: a step of the stages, as a button (its name: "Set the stage of SEED-SO-W39-02 to Sewing…").
      const step = (scope: Locator, code: 'PREPARING' | 'CUTTING' | 'SEWING' | 'QUALITY' | 'READY') => scope.getByRole('button', { name: OD('where.manual.stepAria', { number: order.number, stage: stageWord(code) }), exact: true })
      const picked = (box: Locator, code: 'PREPARING' | 'CUTTING' | 'SEWING' | 'QUALITY' | 'READY') => expect(box.getByRole('radio', { name: startsWith(stageWord(code)) })).toBeChecked({ timeout: 30_000 })
      const hand = /^\/production\/brand-orders\/[^/]+\/stage$/
      const fresh = (await flow.read(page, `/sales/orders/${order.id}`)).order as Json
      expect(fresh.status, 'SEED-SO-W39-02 is in production').toBe('IN_PRODUCTION')
      // Set-up: P1 shares its production progress (+ Progress) for this step, so its buyer reads a stage's count words — the limits
      // card's own write (customer page; th-stages walk the card); put back as it was at the step's end.
      byApi('P1’s production share level for this step (the customer page’s limits card)')
      const owner = await flow.desk('owner')
      const shareLevel = async (level: string): Promise<void> => {
        const limits = (await flow.read(owner.page, `/partners/${alphaId}/production`)).production as Json
        await flow.write(owner.page, 'POST', '/auth/office/step-up', { code: await flow.code(owner.person) })
        await flow.write(owner.page, 'PUT', `/partners/${alphaId}/production`, { productionLevel: level, version: limits.version })
      }
      const sharedBefore = ((await flow.read(owner.page, `/partners/${alphaId}/production`)).production as Json).level as string
      if (sharedBefore === 'STATUS') await shareLevel('PROGRESS')

      // F-SC-W5: a click on Sewing in the strip under the headline opens the ONE dialog with Sewing picked (the door "Set the stage by
      // hand…" stays beside the quiet line: the keyboard path). System or scanners down, the office's note; the lines say the customer
      // reads a plain stage and is told after the 10-minute window (R3b), and the cut-offs stay the floor's.
      await planner.go(`/sales/orders/${order.id}?tab=overview`)
      await expect(headline).toHaveText(`${OD('status.IN_PRODUCTION')} · ${stageWord('PREPARING')}`, { timeout: 60_000 })
      const door = where.getByRole('button', { name: OD('where.manual.open'), exact: true })
      await seen(door, 60_000)
      await expect(door, 'a Planner may set it').not.toHaveAttribute('aria-disabled', 'true', { timeout: 60_000 })
      // The strip's steps are buttons for a Planner (no link): every stage but Preparing, the one the customer reads.
      await expect(where.locator('.fw-prp-strip-go'), 'no link for who may set the stage').toHaveCount(0, { timeout: 60_000 })
      await expect(where.locator('.fw-prp-strip-pick')).toHaveCount(4)
      await press(step(where, 'SEWING'))
      const box = dialog(page)
      await seen(box.getByText(OD('where.manual.title', { number: order.number })), 60_000)
      await picked(box, 'SEWING')
      await box.getByRole('combobox', { name: OD('where.manual.reason'), exact: true }).selectOption('OUTAGE')
      await box.getByRole('textbox', { name: startsWith(PROD('raise.note')) }).fill(HAND_NOTE)
      for (const line of [OD('where.manual.customer'), OD('where.manual.told', { minutes: 10 }), OD('where.manual.cuts')]) await seen(box.getByText(line, { exact: true }))
      await flow.shot(page, 'hand-stage-dialog')
      const set = await answerOf(page, 'PUT', hand, () => press(box.getByRole('button', { name: OD('where.manual.go'), exact: true })))
      expect(set, 'made at Preparing and set to Sewing by hand (R1)').toMatchObject({ floor: 'PREPARING', stage: 'SEWING', byHand: { stage: 'SEWING', reasonCode: 'OUTAGE', note: HAND_NOTE } })
      const who = set.byHand.setBy.name as string
      await expect(box).toBeHidden({ timeout: 30_000 })

      // The headline and the hand row: who and why, the office's note, no work order records it (it stands until cleared).
      await expect(headline).toHaveText(`${OD('status.IN_PRODUCTION')} · ${stageWord('SEWING')}`, { timeout: 60_000 })
      await seen(handRow, 60_000)
      for (const text of [OD('where.manual.tag'), OD('where.manual.by', { who }), OD('where.manual.reasons.OUTAGE'), OD('where.manual.noWork'), HAND_NOTE]) await expect(handRow, text).toContainText(text)
      await flow.shot(page, 'hand-stage-set')

      // The History says it (the order's own row of the act), after a fresh read of the page.
      await planner.go(`/sales/orders/${order.id}?tab=overview`)
      await seen(page.locator('aside.fw-rcf-dock').getByText(new RegExp(escape(FEED('verb.setStageByHand')))).first(), 60_000)

      // ms-fx1: the Orders sheet's hand mark, read where its "Where it is" column is drawn at first — the customer page's Work tab (the
      // same sheet and cell, WhereItIsCell; Sales › Orders' own default view has no such column, it is offered in Customise). Searched
      // for this one order, as Sales (an office fact: the mark only, never who or why): its row's Where it is cell says the same
      // Sewing with its small hand mark (its words for a screen reader, the tip).
      await sales.go(`/sales/customers/${alphaId}?tab=work&q=${encodeURIComponent(order.number)}`)
      const whereCell = sales.page.locator(`.ag-row[row-id="${order.id}"] .ag-cell[col-id="whereItIs"]`).first()
      await seen(whereCell, 60_000)
      await expect(whereCell).toContainText(stageWord('SEWING'), { timeout: 60_000 })
      await expect(whereCell).toContainText(OD('list.byHand.mark'), { timeout: 60_000 })
      await flow.shot(sales.page, 'hand-stage-list')

      // P1's buyer: a plain Sewing on its order — no count is claimed (the floor counts sewing only on a work order: never "0 of 8
      // sewn"), never "by hand", the reason, the note or who; its own "Mark urgent" is still offered (nothing cut: R8).
      const alpha = await signInToPortal(flow, BRAND_ALPHA, alphaId)
      const portalText = async () => (await alpha.page.locator('main').innerText().catch(() => '')) || (await alpha.page.locator('body').innerText())
      const saysNothingOfTheHand = async (place: string) => {
        const text = await portalText()
        for (const word of ['by hand', HAND_NOTE, who, OD('where.manual.reasons.OUTAGE')]) expect(text, `${place}: ${word}`).not.toContain(word)
        // R13: a stage's count of 0 reads "Count to follow", never "0 of 8 cut" (the count words of factory-domain portal-read).
        expect(text, `${place}: no "0 of N" count`).not.toMatch(/\b0 of \d+ (cut|sewn|checked|packed)\b/)
      }
      await alpha.go(`/orders/${order.id}`)
      await seen(alpha.page.getByText(STAGE_WORDS.SEWING.en, { exact: true }).first(), 60_000)
      await saysNothingOfTheHand('P1’s order at Sewing')
      await flow.shot(alpha.page, 'hand-stage-portal-sewing')
      await alpha.go('/production')
      const ref = fresh.customerRef as string | null
      if (ref) {
        const menu = alpha.page.getByRole('button', { name: new RegExp(`^${escape(lead(PPROD('row.menu')))}\\s*${escape(ref)}`) }).first()
        await seen(menu, 60_000)
        await press(menu)
        await seen(alpha.page.getByRole('menuitem', { name: PPROD('row.open'), exact: true }))
        const mark = alpha.page.getByRole('menuitem', { name: startsWith(PPROD('row.markUrgent')) }).first()
        if ((await mark.count()) > 0) {
          await expect(mark, 'never held for a cut that did not happen').not.toContainText(PPROD('held.cut'))
          if ((await mark.getAttribute('aria-disabled')) === 'true') notHere(`P1’s Mark urgent on SEED-SO-W39-02: held for another reason — ${(await mark.innerText()).trim()}`)
        } else notHere('P1’s Mark urgent on SEED-SO-W39-02: urgency is off for P1 in this world')
        await alpha.page.keyboard.press('Escape')
      } else notHere('P1’s production list row of SEED-SO-W39-02: it has no reference of the customer to find it by')
      await saysNothingOfTheHand('P1’s production list')

      // F-SC-W5: Ready to ship by hand — clicked on the strip while Sewing stands (a Change… with Ready picked): the dialog warns that
      // quality has not released every piece (a warning, never a hold); the reason and note set stay; set — the headline reads it.
      await planner.go(`/sales/orders/${order.id}?tab=overview`)
      await expect(headline).toHaveText(`${OD('status.IN_PRODUCTION')} · ${stageWord('SEWING')}`, { timeout: 60_000 })
      await press(step(where, 'READY'))
      const ready = dialog(page)
      await seen(ready.getByText(OD('where.manual.changeTitle', { number: order.number })), 60_000)
      await picked(ready, 'READY')
      await seen(ready.getByText(READY_UNRELEASED_WORDS.en, { exact: true }))
      await flow.shot(page, 'hand-stage-ready-warned')
      const readied = await answerOf(page, 'PUT', hand, () => press(ready.getByRole('button', { name: OD('where.manual.changeGo'), exact: true })))
      expect(readied, 'Ready to ship by hand: only the stage moves').toMatchObject({ floor: 'PREPARING', stage: 'READY', byHand: { stage: 'READY', reasonCode: 'OUTAGE' } })
      await expect(headline).toHaveText(`${OD('status.IN_PRODUCTION')} · ${stageWord('READY')}`, { timeout: 60_000 })
      expect((await flow.read(page, `/sales/orders/${order.id}`)).order.status, 'the order status never changes').toBe('IN_PRODUCTION')
      await alpha.go(`/orders/${order.id}`)
      await seen(alpha.page.getByText(new RegExp(`^${escape(STAGE_WORDS.READY.en)}`)).first(), 60_000)
      await saysNothingOfTheHand('P1’s order at Ready to ship')

      // F-SC-W6: Change… (the hand row's own door, the keyboard path) opens on Ready to ship as it stands — held while nothing differs
      // (the domain's words); another reason alone is taken at the same stage, and the customer is told nothing (it still reads Ready).
      await planner.go(`/sales/orders/${order.id}?tab=overview`)
      const changeDoor = where.getByRole('button', { name: OD('where.manual.changeAria', { number: order.number }), exact: true })
      await press(changeDoor)
      const reword = dialog(page)
      await seen(reword.getByText(OD('where.manual.changeTitle', { number: order.number })), 60_000)
      await picked(reword, 'READY')
      const changeGo = reword.getByRole('button', { name: OD('where.manual.changeGo'), exact: true })
      await expect(changeGo, 'nothing differs yet').toHaveAttribute('aria-description', STAGE_SET_REFUSAL_WORDS.NOTHING_TO_CHANGE.en, { timeout: 30_000 })
      await reword.getByRole('combobox', { name: OD('where.manual.reason'), exact: true }).selectOption('FEW_PEOPLE')
      await seen(reword.getByText(OD('where.manual.same', { customer: STAGE_WORDS.READY.en }), { exact: true }))
      const reworded = await answerOf(page, 'PUT', hand, () => press(changeGo))
      expect(reworded, 'the reason alone changed: the same stage').toMatchObject({ floor: 'PREPARING', stage: 'READY', byHand: { stage: 'READY', reasonCode: 'FEW_PEOPLE' } })
      await expect(reword).toBeHidden({ timeout: 30_000 })
      await expect(handRow).toContainText(OD('where.manual.reasons.FEW_PEOPLE'), { timeout: 60_000 })
      await alpha.go(`/orders/${order.id}`)
      await seen(alpha.page.getByText(new RegExp(`^${escape(STAGE_WORDS.READY.en)}`)).first(), 60_000)
      for (const word of [OD('where.manual.reasons.FEW_PEOPLE')]) expect(await alpha.page.locator('body').innerText(), word).not.toContain(word)

      // Change… down to Cutting (the same door; Cutting picked over the pre-picked Ready) — a move back, told as a correction only if
      // the stage it leaves was told; the buyer reads "Cutting · Count to follow" (R13: nothing cut yet).
      await planner.go(`/sales/orders/${order.id}?tab=overview`)
      await press(changeDoor)
      const change = dialog(page)
      await seen(change.getByText(OD('where.manual.changeTitle', { number: order.number })), 60_000)
      await change.getByRole('radio', { name: startsWith(stageWord('CUTTING')) }).check()
      await seen(change.getByText(OD('where.manual.back', { customer: STAGE_WORDS.CUTTING.en, minutes: 10 }), { exact: true }))
      const changed = await answerOf(page, 'PUT', hand, () => press(change.getByRole('button', { name: OD('where.manual.changeGo'), exact: true })))
      expect(changed).toMatchObject({ floor: 'PREPARING', stage: 'CUTTING', byHand: { stage: 'CUTTING', reasonCode: 'FEW_PEOPLE' } })
      await expect(headline).toHaveText(`${OD('status.IN_PRODUCTION')} · ${stageWord('CUTTING')}`, { timeout: 60_000 })
      await alpha.go(`/orders/${order.id}`)
      await seen(alpha.page.getByText(`${STAGE_WORDS.CUTTING.en} · ${COUNT_TO_FOLLOW_WORDS.en}`, { exact: true }).first(), 60_000)
      await saysNothingOfTheHand('P1’s order at Cutting')
      await flow.shot(alpha.page, 'hand-stage-portal-cutting')

      // F-SC-W5: the Production tab — a step of Production now's stage bar opens the SAME dialog, on that step (closed unsent).
      await planner.go(`/sales/orders/${order.id}?tab=production`)
      const now = page.locator('#now')
      await press(step(now, 'SEWING'), 60_000)
      const fromBar = dialog(page)
      await seen(fromBar.getByText(OD('where.manual.changeTitle', { number: order.number })), 60_000)
      await picked(fromBar, 'SEWING')
      await flow.shot(page, 'hand-stage-production-step')
      await press(fromBar.getByRole('button', { name: OD('common.cancel'), exact: true }))
      await expect(fromBar).toBeHidden({ timeout: 30_000 })

      // Clear… → back to the floor's stage, Preparing — a move down, told by the one rule: what the customer was told of Cutting is the
      // API's notice (the keeper's markers, ms-fx1), so the dialog's line is read from it — told: the correction after the window; its
      // notice still waiting: not told yet, never now; never told: not told now (then what it reads, with no notice).
      await planner.go(`/sales/orders/${order.id}?tab=overview`)
      // pt-sc-fx1: the hand row's Clear… door (the floor's own step on the strip has a name of its own and opens the same confirm).
      await expect(step(where, 'PREPARING'), 'the floor\'s step is not a Set').toHaveCount(0)
      await seen(where.getByRole('button', { name: OD('where.manual.stepFloorAria', { number: order.number, stage: stageWord('PREPARING') }), exact: true }))
      await press(handRow.getByRole('button', { name: OD('where.manual.clearAria', { number: order.number }), exact: true }))
      const clear = dialog(page)
      await seen(clear.getByText(OD('where.manual.clearTitle'), { exact: true }), 60_000)
      const notice = ((await flow.read(page, `/sales/orders/${order.id}/production?parts=headline`)).headline as Json | null)?.stage?.byHand?.notice as { told: boolean; waitsUntil: string | null } | null | undefined
      const goes = notice?.waitsUntil ? Date.parse(notice.waitsUntil) : Number.NaN
      if (notice && (notice.told || (Number.isFinite(goes) && Date.now() >= goes))) await seen(clear.getByText(OD('where.manual.clearCorrection', { customer: STAGE_WORDS.CUTTING.en, minutes: 10 }), { exact: true }))
      else if (notice && Number.isFinite(goes)) await seen(clear.getByText(OD('where.manual.clearUntold', { customer: STAGE_WORDS.CUTTING.en, minutes: 10 }), { exact: true }))
      else if (notice) await seen(clear.getByText(OD('where.manual.clearNever', { customer: STAGE_WORDS.CUTTING.en }), { exact: true }))
      else notHere('the headline sends no notice of the stage set by hand: Clear… says nothing of it (never a guess)')
      if (notice && !notice.told && !(Number.isFinite(goes) && Date.now() >= goes)) await seen(clear.getByText(OD('where.manual.clearFloor', { customer: STAGE_WORDS.PREPARING.en }), { exact: true }))
      const cleared = await answerOf(page, 'DELETE', hand, () => press(clear.getByRole('button', { name: OD('where.manual.clearGo', { stage: stageWord('PREPARING') }), exact: true })))
      expect(cleared).toMatchObject({ floor: 'PREPARING', stage: 'PREPARING', byHand: null })
      await expect(headline).toHaveText(`${OD('status.IN_PRODUCTION')} · ${stageWord('PREPARING')}`, { timeout: 60_000 })
      await expect(handRow).toHaveCount(0, { timeout: 60_000 })
      await seen(where.getByRole('button', { name: OD('where.manual.open'), exact: true }), 60_000)
      await flow.shot(page, 'hand-stage-cleared')

      // Sales sees the door held, in words (Production does this — manual-stage D6), and the strip stays its ONE link (no step is a
      // button); a Confirmed order shows the door held (production has not started).
      await sales.go(`/sales/orders/${order.id}?tab=overview`)
      const salesDoor = sales.page.locator('.fw-so-where').getByRole('button', { name: OD('where.manual.open'), exact: true })
      await seen(salesDoor, 60_000)
      await expect(salesDoor).toHaveAttribute('aria-disabled', 'true')
      await expect(salesDoor).toHaveAttribute('aria-description', OD('wo.heldHold'))
      await seen(sales.page.locator('.fw-so-where .fw-prp-strip-go'), 60_000)
      await expect(sales.page.locator('.fw-so-where .fw-prp-strip-pick')).toHaveCount(0)
      const confirmed = (((await flow.read(page, `/sales/orders?partyId=${alphaId}&status=CONFIRMED&limit=5`)).orders ?? []) as Json[])[0]
      if (confirmed) {
        await planner.go(`/sales/orders/${confirmed.id as string}?tab=overview`)
        const held = where.getByRole('button', { name: OD('where.manual.open'), exact: true })
        await seen(held, 60_000)
        await expect(held).toHaveAttribute('aria-disabled', 'true')
        await expect(held).toHaveAttribute('aria-description', STAGE_SET_REFUSAL_WORDS.NOT_STARTED.en)
        await flow.shot(page, 'hand-stage-held-confirmed')
      } else notHere('a Confirmed order of P1 in this world: none, so its held door is the unit tests’ (where.vitest)')
      if (sharedBefore === 'STATUS') await shareLevel('STATUS')
      await flow.settle()
    })
    // ---- end F-MS-106

    // ---- F-PT T.2 (order PRODUCTION tab, 15-steps T.2; C1, L7, L9): the Production tab at the end -----------------------------------
    await flow.step('12 · the Production tab: Ask for an update opens the ready ask; the supervisor’s reply answered it — "Latest update"; the promise history and the promise door in Dates & plan; a hold lifted from Problems & holds; Read-only reads it with no act', async () => {
      const made = await productionWorld(flow, world.order.id)

      // Sales: Production now's Ask for an update is the ready ask (the note dialog with its own title) — the world sent the same ask
      // by the API, so this one is closed unsent.
      await sales.go(`/sales/orders/${world.order.id}?tab=production`)
      const now = sales.page.locator('#now')
      const ask = now.getByRole('button', { name: OD('productionTab.ask.button'), exact: true })
      await seen(ask, 60_000)
      await press(ask)
      const box = dialog(sales.page)
      await seen(box.getByText(OD('productionTab.ask.title', { number: world.order.number }), { exact: true }).first())
      await press(box.getByRole('button', { name: NOTES('cancel'), exact: true }))
      await expect(dialog(sales.page)).toHaveCount(0)
      // C1 (B-PT-015): the supervisor's reply in the thread answered the ask — the tab's latest update names it and quotes it.
      expect((await askState(flow, world.order.id, made.ask.issueId)).status).toBe('ANSWERED')
      await seen(now.getByText(startsWith(lead(OD('productionTab.now.latest')))).first(), 60_000)
      await seen(now.getByText(WORLD_WORDS.reply).first())
      await flow.shot(sales.page, 'production-now-answered')

      // Dates & plan: the promise history (the newest move open, the earlier one folded); We promised's Change… is the ONE promise
      // dialog with its honest hint (the portal tells the customer; the floor is not told) — closed unsaved (the world moved it).
      const dates = sales.page.locator('#dates')
      const history = sales.page.locator('#promise-moves')
      await seen(history.getByText(OD('productionTab.history.title'), { exact: true }), 60_000)
      await seen(history.getByText(WORLD_WORDS.lineMove).first())
      await seen(history.getByText(OD('productionTab.history.earlier', { count: 1 }), { exact: true }))
      const promised = dates.locator('.fw-pt-tile', { hasText: OD('productionTab.dates.promised') })
      await press(promised.getByRole('button', { name: OD('doors.change'), exact: true }))
      const promise = dialog(sales.page)
      await seen(promise.getByText(OD('productionTab.promise.hint'), { exact: true }))
      await press(promise.getByRole('button', { name: OD('common.cancel'), exact: true }))
      await flow.shot(sales.page, 'production-dates-history')

      // The planner (the hold right): the hold is Problems & holds' strip — Overview's own — with its office note; its Lift the hold…
      // opens the ONE lift dialog; the reason typed, released; the strip goes.
      const planner = await flow.desk('planner')
      await planner.go(`/sales/orders/${world.order.id}?tab=production`)
      const holds = planner.page.locator('#holds')
      const strip = holds.locator('li', { hasText: made.hold.workOrderNumber }).filter({ has: planner.page.getByRole('button', { name: OD('wo.act.lift'), exact: true }) }).first()
      await seen(strip, 60_000)
      await seen(holds.getByText(WORLD_WORDS.holdNote).first())
      await press(strip.getByRole('button', { name: OD('wo.act.lift'), exact: true }))
      const lift = dialog(planner.page)
      await seen(lift.getByText(PWO('liftHold.title')).first(), 60_000)
      await lift.getByRole('textbox', { name: PWO('liftHold.reason') }).fill(LIFT_REASON)
      // fx8: a production hold is lifted through the work order's own lift route (workorders.hold, no step-up) — one work order's
      // POST /production/work-orders/:id/holds/:holdId/lift, or the ONE lift of several (POST /production/work-orders/holds/lift).
      await answerOf(planner.page, 'POST', /^\/production\/work-orders\/(?:[^/]+\/holds\/[^/]+|holds)\/lift$/, () => press(lift.getByRole('button', { name: PWO('liftHold.go'), exact: true })))
      await flow.settle()
      await expect(holds.getByRole('button', { name: OD('wo.act.lift'), exact: true })).toHaveCount(0, { timeout: 60_000 })
      await flow.shot(planner.page, 'production-hold-lifted')

      // L7: Read-only reads the whole tab and finds no act — no Ask, no Lift, no Change…, no Make work orders, no Record.
      const reader = await flow.desk('reader')
      await reader.go(`/sales/orders/${world.order.id}?tab=production`)
      await seen(reader.page.locator('#now'), 60_000)
      await seen(reader.page.locator('#holds'))
      for (const name of [OD('productionTab.ask.button'), OD('wo.act.lift'), OD('doors.change'), OD('step.makeWorkOrders'), OD('productionTab.receipt.open')]) await expect(reader.page.locator('.fw-pt').getByRole('button', { name, exact: true }), name).toHaveCount(0)
      await flow.shot(reader.page, 'production-read-only')
    })
    // ---- end F-PT T.2

    // ---- F-OC T.2 (order CHANGES tab, 15-steps T.2; L5, R1, B-OC-001, B-OC-002, B-OC-011): the Changes tab at the end -------------
    await flow.step('13 · the Changes tab: a Lines save with the tick asks Brand Alpha by e-mail (the FAKE mailbox) → Waiting on Brand Alpha draws the revised order; its buyer says yes in the portal → the row is gone and What changed says "Customer said yes"; the planner decides the waiting work-order change from Waiting; Read-only sees no act', async () => {
      const { page } = sales
      // Who the ask goes to: the confirmation's own rule — the quote's contact, else the first active orders contact with an e-mail
      // (this order was typed: no quote).
      const contacts = ((await flow.read(page, `/parties/${alphaId}`)).party.contacts ?? []) as Json[]
      const to = contacts.find((contact) => contact.status === 'ACTIVE' && !!contact.email && ((contact.roles ?? []) as string[]).includes('ORDERS'))?.email as string | undefined
      expect(to, `${BRAND_ALPHA.tradeName} has an orders contact with an e-mail`).toBeTruthy()
      const mailsBefore = await flow.mailsTo(to!)

      // Sales lowers 52 by one on Lines (the released work order waits for production again) and saves with the tick on.
      await sales.go(`/sales/orders/${world.order.id}?tab=lines`)
      const table = page.locator('.fw-lt')
      const size52 = table.getByRole('textbox', { name: /, size 52$/ }).first()
      await seen(size52, 60_000)
      const before52 = Number(await size52.inputValue())
      expect(before52, 'the 52s step 3 left').toBeGreaterThan(0)
      await size52.fill(String(before52 - 1))
      const bar = page.getByRole('region', { name: DSW('editModeBar.region'), exact: true })
      await press(bar.getByRole('button', { name: OD('save.review'), exact: true }))
      const reviewWindow = dialog(page)
      await seen(reviewWindow, 60_000)
      const why = reviewWindow.getByRole('textbox', { name: startsWith(OD('review.whyWords')) })
      if ((await why.count()) > 0) await why.first().fill(CHANGE_REASON)
      // The tick stays on (the amount changes, as Sales reads it): the customer is asked to accept the new order.
      await expect(reviewWindow.getByRole('checkbox', { name: startsWith(lead(OD('review.ask'))) })).toBeChecked()
      await expect(reviewWindow).not.toContainText('€')
      const askAnswer = page.waitForResponse((entry) => entry.request().method() === 'POST' && new URL(entry.url()).pathname.replace(/^\/api/, '') === '/approvals-out', { timeout: 60_000 })
      const applied = await answerOf(page, 'POST', /^\/sales\/orders\/[^/]+\/amendments$/, () => press(reviewWindow.getByRole('button', { name: OD('review.save'), exact: true })))
      expect(applied.amendment, 'the save asks the customer').toMatchObject({ reacceptance: 'NEEDED' })
      expect(((applied.workOrders.waiting ?? []) as Json[]).map((entry) => entry.workOrderId), 'the released work order waits for production').toContain(workOrder.id)
      // R1 (L5): ONE ask on the REVISION the save made, by e-mail — never on the order.
      const askResponse = await askAnswer
      const asked = (await askResponse.json().catch(() => ({}))) as Json
      expect(askResponse.status(), `POST /approvals-out: ${JSON.stringify(asked).slice(0, 400)}`).toBe(201)
      expect(asked).toMatchObject({ delivery: 'SENT', request: { kind: 'REVISED_ORDER', status: 'OPEN', record: { type: 'SalesOrderAmendment', id: applied.amendment.id } } })
      // The FAKE mailbox holds the request mail with its one-use link, to that contact.
      const mailed = await flow.linkSentTo(to!, mailsBefore)
      expect(mailed.templateKey).toBe(APPROVAL_MAIL_TEMPLATES.request)
      // The notice says where the ask went, once it went (F-OC-304): by e-mail.
      const numbers = (entries: Json[]) => entries.map((entry) => (entry.number as string | null) ?? 'WO-…').join(', ')
      const changed = numbers((applied.workOrders.applied ?? []) as Json[])
      const waits = numbers((applied.workOrders.waiting ?? []) as Json[])
      const which = changed && waits ? 'both' : changed ? 'changed' : waits ? 'waits' : 'plain'
      await seen(page.getByText(OD(`changesTab.saved.${which}Email`, { changed, waits, customer: BRAND_ALPHA.legalName }), { exact: true }).first(), 60_000)
      await flow.settle()

      // Waiting on Brand Alpha: the revised order asked (B-OC-002), in the customer's group, never an amount; What changed: the
      // revision waits for their yes.
      await sales.go(`/sales/orders/${world.order.id}?tab=changes`)
      const theirs = page.locator('#waiting [aria-labelledby="fw-oc-g-customer"]')
      const askedRow = theirs.locator(`#about-ApprovalRequest-${asked.request.id}`)
      await seen(askedRow, 60_000)
      await expect(askedRow).toContainText(/revised order/i)
      await expect(askedRow).not.toContainText('€')
      const revisionRow = page.locator(`#history #change-${applied.amendment.id}`)
      await seen(revisionRow, 60_000)
      await expect(revisionRow).toContainText(OD('changesTab.history.tag.WAITING'))
      await expectNothingOf(page, BRAND_BETA, world.betaNumbers, "A's Changes tab")
      await flow.shot(page, 'changes-waiting-on-customer')

      // The customer answers in its portal: its order's "Review and confirm", Confirm version N, signed with the typed name.
      await buyerMayApprove(flow, await flow.desk('owner'), alphaId)
      const alpha = await signInToPortal(flow, BRAND_ALPHA, alphaId)
      await alpha.go(`/orders/${world.order.id}`)
      const reviewDoor = alpha.page.getByRole('button', { name: PO('reconfirm.review'), exact: true })
      await seen(reviewDoor, 60_000)
      await press(reviewDoor)
      const reconfirm = dialog(alpha.page)
      await seen(reconfirm.getByText(PO('reconfirm.title', { version: applied.amendment.revision })).first(), 60_000)
      await reconfirm.getByRole('radio', { name: startsWith(lead(PO('reconfirm.approve'))) }).check()
      await reconfirm.getByRole('textbox', { name: startsWith(PO('reconfirm.name')) }).fill(BRAND_ALPHA.portalPerson.name)
      await answerOf(alpha.page, 'POST', /^\/portal\/approvals\/[^/]+\/answer$/, () => press(reconfirm.getByRole('button', { name: startsWith(lead(PO('reconfirm.go.APPROVED'))) })))
      await seen(reconfirm.getByText(PO('reconfirm.done.APPROVED', { version: applied.amendment.revision })).first(), 60_000)
      await flow.shot(alpha.page, 'portal-revision-confirmed')
      await flow.settle()

      // The office: the row is gone from Waiting on Brand Alpha; What changed says "Customer said yes" on that revision (B-OC-011).
      await sales.go(`/sales/orders/${world.order.id}?tab=changes`)
      await seen(page.locator('#history'), 60_000)
      await expect(page.locator(`#about-ApprovalRequest-${asked.request.id}`)).toHaveCount(0, { timeout: 60_000 })
      await expect(page.locator(`#history #change-${applied.amendment.id}`)).toContainText(OD('changesTab.history.tag.ACCEPTED'), { timeout: 60_000 })
      await flow.shot(page, 'changes-customer-said-yes')

      // The planner decides the work-order change the save left waiting — from Waiting › Still to do (Decide…, the ONE review window).
      const planner = await flow.desk('planner')
      await planner.go(`/sales/orders/${world.order.id}?tab=changes`)
      const decide = planner.page.locator('#waiting #still-to-do').getByRole('button', { name: OD('productionTab.wo.decide'), exact: true }).first()
      await seen(decide, 60_000)
      await press(decide)
      const decideWindow = dialog(planner.page)
      await seen(decideWindow, 60_000)
      await answerOf(planner.page, 'POST', /^\/production\/work-order-changes\/[^/]+\/apply$/, async () => {
        await press(decideWindow.getByRole('button', { name: APPROVALS('workOrderChange.apply.LOWER_TO_ORDER'), exact: true }))
        await flow.stepUp(planner.page, planner.person)
      })
      await flow.settle()
      await expect(planner.page.locator('#waiting').getByRole('button', { name: OD('productionTab.wo.decide'), exact: true })).toHaveCount(0, { timeout: 60_000 })
      await flow.shot(planner.page, 'changes-change-decided')

      // Read-only reads the whole tab and finds no act: no Decide…, Answer…, Confirm / Refuse…, Ask…, Restore…, Send…, Change the lines ›.
      const reader = await flow.desk('reader')
      await reader.go(`/sales/orders/${world.order.id}?tab=changes`)
      const tab = reader.page.locator('.fw-oc')
      await seen(tab.locator('#waiting'), 60_000)
      await seen(tab.locator('#history'))
      for (const name of [OD('productionTab.wo.decide'), OD('band.answer'), OD('approval.refuse'), OD('changesTab.waiting.manage')]) await expect(tab.getByRole('button', { name, exact: true }), name).toHaveCount(0)
      await expect(tab.getByRole('button', { name: YES }), 'no yes').toHaveCount(0)
      for (const name of [lead(OD('changesTab.agreement.ask')), lead(OD('changesTab.history.restoreOf')), lead(OD('changesTab.agreement.send')), OD('changesTab.freeze.lines')]) await expect(tab.getByRole('button', { name: startsWith(name) }).or(tab.getByRole('link', { name: startsWith(name) })), name).toHaveCount(0)
      await flow.shot(reader.page, 'changes-read-only')
    })
    // ---- end F-OC T.2

    // ---- F-OM T.2 (order MONEY tab, 15-steps T.2; L1, L3, B-OM-016, B-OM-017, B-OM-020): the Money tab at the end ---------------------
    await flow.step('14 · the Money tab: Finance accepts the deposit short (bank charges) → paid, the band offers Make work orders; the balance "Set by hand"; the margin\'s hand cost and target; Accept the difference… → "Accepted by hand"; Undo this payment… on another order; Sales reads words, no amount, no money door; Read-only sees no act', async () => {
      // The world by the API (th9-money-world.ts): T-TH9-MONEY-0001 (the deposit paid short within the tolerance, the balance's day
      // moved by hand, a commission set by hand and a target, the customer's price under ours) and T-TH9-MONEY-0002 (a part payment).
      const money = await moneyWorld(flow)
      const finance = await flow.desk('finance')
      const { page } = finance

      // L1 (B-OM-016): Accept short (bank charges)… — the missing part stays owed (the final invoice). F-OM-fx3 (W-01): short within the
      // company's tolerance, it is the deposit row's ONE act (Record a payment moved to its ⋯).
      await finance.go(`/sales/orders/${money.money.id}?tab=money`)
      const deposit = page.locator(`#about-DepositRequest-${money.money.depositRequestId}`)
      await seen(deposit, 60_000)
      await seen(deposit.getByText(OD('moneyTab.plan.pill.PART'), { exact: true }).first())
      await press(deposit.locator('.fw-om-pr-a').getByRole('button', { name: OD('moneyTab.plan.act.ACCEPT_SHORT'), exact: true }))
      const shortBox = dialog(page)
      await seen(shortBox.getByText(OD('moneyTab.hand.ACCEPT_SHORT.happens.owed'), { exact: true }), 60_000)
      await shortBox.getByRole('textbox', { name: startsWith(OD('moneyTab.hand.reason')) }).fill(MONEY_WORDS.acceptShort)
      await answerOf(page, 'POST', /^\/sales\/orders\/[^/]+\/money-plan$/, async () => {
        await press(shortBox.getByRole('button', { name: startsWith(lead(OD('moneyTab.hand.ACCEPT_SHORT.go'))) }))
        await flow.stepUp(page, finance.person)
      })
      await flow.settle()
      await seen(deposit.getByText(OD('moneyTab.plan.pill.PAID'), { exact: true }).first(), 60_000)
      const accepted = ((await scheduleOf(flow, money.money.id)).requests as Json[]).find((request) => request.id === money.money.depositRequestId)
      expect(accepted, 'the deposit PAID by hand, accepted short').toMatchObject({ status: 'PAID' })
      // The balance's due day moved by hand (the world's MOVE_DUE): its row says "Set by hand".
      await seen(page.locator(`#about-DepositRequest-${money.balance.requestId}`).getByText(OD('moneyTab.plan.setByHand'), { exact: true }).first(), 60_000)
      // The margin: the commission set by hand (Put back beside it), the target in the meter's words, freight said honestly.
      const margin = page.locator('#margin')
      await seen(margin.getByText(OD('moneyTab.margin.kind.COMMISSION'), { exact: true }).first(), 60_000)
      await seen(margin.getByRole('button', { name: OD('moneyTab.margin.putBack.door'), exact: true }).first())
      await expect(margin).toContainText(lead(OD('moneyTab.margin.meter.targetBy')))
      await flow.shot(page, 'money-accepted-short')

      // L3 (B-OM-020): Accept the difference… from Price check's ⋯ (Finance: the plan right + price) — both prices stay.
      const price = page.locator('#price-check')
      await seen(price.getByText(OD('moneyTab.price.tag.notEqual'), { exact: true }).first(), 60_000)
      await press(price.getByRole('button', { name: OD('moneyTab.price.more'), exact: true }))
      await press(page.getByRole('menuitem', { name: OD('moneyTab.price.accept.door'), exact: true }))
      const acceptBox = dialog(page)
      await seen(acceptBox.getByText(OD('moneyTab.price.accept.happens.stay'), { exact: true }), 60_000)
      await acceptBox.getByRole('textbox', { name: startsWith(OD('moneyTab.hand.reason')) }).fill(MONEY_WORDS.accept)
      const acceptance = await answerOf(page, 'POST', /^\/sales\/orders\/[^/]+\/price-check\/accept$/, () => press(acceptBox.getByRole('button', { name: OD('moneyTab.price.accept.go'), exact: true })))
      expect(acceptance.accepted, 'the difference accepted by hand, the nets as read').toMatchObject({ ourNet: money.prices.ourNet, brandNet: money.prices.brandNet })
      await seen(price.getByText(OD('moneyTab.price.tag.accepted'), { exact: true }).first(), 60_000)
      await flow.shot(page, 'money-difference-accepted')

      // The planner: the band offers Make work orders now that the deposit counts as paid (production may start, L1).
      const planner = await flow.desk('planner')
      await planner.go(`/sales/orders/${money.money.id}?tab=money`)
      const make = planner.page.getByRole('button', { name: OD('step.makeWorkOrders'), exact: true }).first()
      await seen(make, 60_000)
      await expect(make).not.toHaveAttribute('aria-disabled', 'true')
      await flow.shot(planner.page, 'money-make-work-orders')

      // B-OM-017: Undo this payment… on the other order — the part payment's ⋯ in its row; reversed and voided in one step.
      await finance.go(`/sales/orders/${money.undo.id}?tab=money`)
      const balance = page.locator(`#about-DepositRequest-${money.partPayment.depositRequestId}`)
      await seen(balance, 60_000)
      const paymentMore = balance.getByRole('button', { name: startsWith(lead(OD('moneyTab.payment.more'))) }).first()
      await seen(paymentMore, 60_000)
      await press(paymentMore)
      await press(page.getByRole('menuitem', { name: OD('moneyTab.payment.undo'), exact: true }))
      const undoBox = dialog(page)
      // om-fx2: a "What happens" line is an element of its own (an <li>); "What never changes." shares its line with its bold label.
      await seen(undoBox.getByText(OD('moneyTab.undo.happens.reversed'), { exact: true }), 60_000)
      await expect(undoBox).toContainText(OD('moneyTab.undo.never'))
      await undoBox.getByRole('textbox', { name: startsWith(OD('moneyTab.hand.reason')) }).fill(MONEY_WORDS.undo)
      await answerOf(page, 'POST', /^\/payments\/[^/]+\/undo$/, async () => {
        await press(undoBox.getByRole('button', { name: OD('moneyTab.undo.go'), exact: true }))
        await flow.stepUp(page, finance.person)
      })
      await flow.settle()
      const undone = ((await scheduleOf(flow, money.undo.id)).requests as Json[]).find((request) => request.id === money.partPayment.depositRequestId)
      expect(((undone?.payments ?? []) as Json[]).map((entry) => entry.paymentId), 'the payment is off the request (reversed, voided)').not.toContain(money.partPayment.paymentId)
      await expect(balance.getByText(OD('moneyTab.plan.pill.PART'), { exact: true }), 'the balance is open again').toHaveCount(0, { timeout: 60_000 })
      await flow.shot(page, 'money-payment-undone')

      // The money wall: Sales reads the plan in words — never an amount, no money door, no Price check, no Margin.
      await sales.go(`/sales/orders/${money.money.id}?tab=money`)
      const salesTab = sales.page.locator('.fw-om')
      await seen(salesTab.locator('#payments'), 60_000)
      await expect(salesTab).not.toContainText('€')
      for (const name of [OD('deposit.record'), OD('moneyTab.plan.act.send'), OD('moneyTab.plan.act.sendAgain'), OD('moneyTab.margin.setCost.door'), OD('priceCheck.card.edit')]) await expect(salesTab.getByRole('button', { name, exact: true }), name).toHaveCount(0)
      await expect(salesTab.locator('#price-check')).toHaveCount(0)
      await expect(salesTab.locator('#margin')).toHaveCount(0)
      await expectNothingOf(sales.page, BRAND_BETA, world.betaNumbers, "A's Money tab")
      await flow.shot(sales.page, 'money-sales-words')

      // Read-only reads the whole tab and finds no act (no Record, no Send, no Open for payment, no Waive…, no Set a cost, no target).
      const reader = await flow.desk('reader')
      await reader.go(`/sales/orders/${money.money.id}?tab=money`)
      const readTab = reader.page.locator('.fw-om')
      await seen(readTab.locator('#payments'), 60_000)
      for (const name of [OD('deposit.record'), OD('moneyTab.plan.act.send'), OD('moneyTab.plan.act.sendAgain'), OD('schedule.verbs.open'), OD('moneyTab.plan.act.waive'), OD('moneyTab.margin.setCost.door'), OD('moneyTab.margin.target.door'), OD('priceCheck.card.edit')]) await expect(readTab.getByRole('button', { name, exact: true }), name).toHaveCount(0)
      await expect(readTab).not.toContainText('€')
      await flow.shot(reader.page, 'money-read-only')
      // B's buyer and A's Money: step 8 already opens A's order (with ?tab=money) in B's portal — the neutral refusal.
    })
    // ---- end F-OM T.2

    // ---- F-OS T.2 (order SHIPMENTS tab; 15-steps T.2): the tab at the end, on the seeds' orders of P1 ----
    await flow.step('15 · the Shipments tab: step 6’s shared draft split into 3 in place, a garment moved, a draft merged ("Merged into …"); SEED-SO-0002 taken off in one go; travels without a DDT and back; tracking numbers per parcel; the expected arrival and Mark delivered on our van (the order follows); Mark delivered over carrier labels with a reason; Sales and Read-only with no door', async () => {
      const warehouse = await flow.desk('warehouse')
      const { page } = warehouse
      const rowsOf = async (orderId: string): Promise<Json[]> => ((await flow.read(page, `/sales/orders/${orderId}`)).order.chain.shipments ?? []) as Json[]
      const ownersOf = async (shipmentId: string): Promise<string | null> => {
        for (const order of [world.so3, world.so2]) if ((await rowsOf(order.id)).some((row) => row.id === shipmentId)) return order.id
        return null
      }
      /** A row's ⋯ on the order's Shipments tab, then one of its items (Warehouse's own window opens in place). */
      const rowAct = async (orderId: string, number: string, item: string) => {
        await warehouse.go(`/sales/orders/${orderId}?tab=shipments`)
        const target = shipmentRow(page, number)
        await seen(target, 60_000)
        await press(target.getByRole('button', { name: OS('ships.row.more', { number }), exact: true }))
        await press(page.getByRole('menuitem', { name: item, exact: true }))
        const box = dialog(page)
        await seen(box, 60_000)
        return box
      }

      // ── D3: split into several, move, merge — on step 6's draft (SEED-SO-0003 first, SEED-SO-0002 beside it) ──
      const shared = (await rowsOf(world.so3.id)).find((row) => row.status === 'DRAFT' && ((row.orders ?? []) as Json[]).length > 1 && row.orders[0]?.id === world.so3.id)
      const preview = shared ? await flow.read(page, `/shipping/shipments/${shared.id}/split`) : null
      const movable = ((preview?.lines ?? []) as Json[]).filter((line) => (line.movable as number) > 0)
      const units = movable.flatMap((line) => Array.from({ length: line.movable as number }, () => line))
      const total = ((preview?.lines ?? []) as Json[]).reduce((sum, line) => sum + (line.quantity as number), 0)
      let children: string[] = []
      if (!shared || units.length < 2 || total < 3) notHere('split into several: step 6’s shared draft carries fewer than three garments that may move (cartons and serials stay)')
      else {
        const box = await rowAct(world.so3.id, shared.number as string, DEPTH('split.menu'))
        await box.getByRole('spinbutton', { name: OS('door.split.into'), exact: true }).fill('3')
        // New shipment 1 and 2 take one garment each (the same line when it gives two); the rest stays on the draft.
        for (const [index, line] of [units[0]!, units[1]!].entries()) {
          await box.getByRole('spinbutton', { name: OS('door.split.movesTo', { line: line.label as string, size: line.size as string, n: index + 1 }), exact: true }).fill('1')
        }
        await box.getByRole('radio', { name: startsWith(DEPTH('splitReason.PART_READY')) }).click()
        await flow.shot(page, 'shipments-split-into-3')
        const split = await answerOf(page, 'POST', /^\/shipping\/shipments\/[^/]+\/split$/, () => press(box.getByRole('button', { name: OS('door.split.goInto', { count: 3 }), exact: true })), /^201$/)
        children = ((split.shipments ?? []) as Json[]).map((made) => made.id as string)
        expect(children, 'two new shipments in ONE command (groups[])').toHaveLength(2)
        await flow.settle()
        // Each new shipment says where it came from, on the order whose garments it carries (S3: its own first order).
        for (const id of children) {
          const owner = await ownersOf(id)
          expect(owner, `the new shipment ${id} shows on an order of A`).not.toBeNull()
          const made = (await rowsOf(owner!)).find((row) => row.id === id)!
          expect(made.splitFrom, 'split from the shared draft').toMatchObject({ id: shared.id })
          await warehouse.go(`/sales/orders/${owner}?tab=shipments`)
          await seen(shipmentRow(page, made.number as string).getByText(OS('ships.chip.splitFrom', { number: shared.number as string })), 60_000)
        }
      }

      // Move: one more garment of the draft onto the first new shipment (both drafts of the same customer, locked together).
      const [first, second] = children
      const left = shared ? await flow.read(page, `/shipping/shipments/${shared.id}/split`) : null
      const stillMovable = ((left?.lines ?? []) as Json[]).find((line) => (line.movable as number) > 0)
      const stillTotal = ((left?.lines ?? []) as Json[]).reduce((sum, line) => sum + (line.quantity as number), 0)
      const firstRow = first ? ((await rowsOf((await ownersOf(first)) ?? world.so3.id)).find((row) => row.id === first) ?? null) : null
      if (!shared || !firstRow || !stillMovable || stillTotal < 2) notHere('move garments to…: nothing more may move off the draft while something stays')
      else {
        const box = await rowAct(world.so3.id, shared.number as string, OS('ships.act.move'))
        await box.getByRole('radio', { name: startsWith(`${firstRow.number as string} · `) }).check()
        await box.getByRole('spinbutton', { name: DEPTH('split.movesOf', { line: stillMovable.label as string, size: stillMovable.size as string }), exact: true }).fill('1')
        await box.getByRole('radio', { name: startsWith(DEPTH('splitReason.CUSTOMER_REQUEST')) }).click()
        await box.getByRole('textbox', { name: startsWith(OS('door.wordsOptional')) }).fill(SHIP_WORDS.move)
        const moved = await answerOf(page, 'POST', /^\/shipping\/shipments\/[^/]+\/move$/, () => press(box.getByRole('button', { name: startsWith(lead(OS('move.go_one'))) }).first()))
        expect(moved.moved, 'one garment moved').toMatchObject({ garments: 1, merged: false })
        await flow.settle()
      }

      // Merge: the second new shipment into the first — it is cancelled "Merged into …", never deleted.
      const secondOwner = second ? await ownersOf(second) : null
      const secondRow = secondOwner ? ((await rowsOf(secondOwner)).find((row) => row.id === second) ?? null) : null
      if (!secondRow || !firstRow || !secondOwner) notHere('merge into…: the split made no two drafts to merge')
      else {
        const box = await rowAct(secondOwner, secondRow.number as string, OS('ships.act.merge'))
        await box.getByRole('radio', { name: startsWith(`${firstRow.number as string} · `) }).check()
        await answerOf(page, 'POST', /^\/shipping\/shipments\/[^/]+\/merge$/, () => press(box.getByRole('button', { name: OS('move.mergeGo', { number: firstRow.number as string }), exact: true })))
        await flow.settle()
        const emptied = (await flow.read(page, `/shipping/shipments/${second}`)).shipment as Json
        expect(emptied, 'the emptied draft stays, cancelled').toMatchObject({ status: 'CANCELLED' })
        expect(String(emptied.cancelReason)).toMatch(/^Merged into /)
        // Where the order still lists it (its first order): "Show N cancelled", then "Merged into …" on its row.
        if ((await rowsOf(secondOwner)).some((row) => row.id === second)) {
          await warehouse.go(`/sales/orders/${secondOwner}?tab=shipments`)
          await press(page.locator('#shipments').getByRole('button', { name: startsWith(lead(OD('ship.showCancelled', { count: 2 }))) }).first())
          await seen(shipmentRow(page, secondRow.number as string).getByText(OS('ships.chip.mergedInto', { number: firstRow.number as string })), 60_000)
        }
        await flow.shot(page, 'shipments-merged')
      }

      // ── X1-B2: SEED-SO-0002 taken off the shared draft in ONE step (all or nothing; the draft keeps SEED-SO-0003's garments) ──
      const onSo2 = shared ? (await rowsOf(world.so2.id)).find((row) => row.id === shared.id) : undefined
      if (!shared || !onSo2) notHere('take this order off…: SEED-SO-0002 has no garment left on step 6’s draft')
      else {
        const box = await rowAct(world.so2.id, shared.number as string, OS('ships.act.takeOff'))
        await box.getByRole('textbox', { name: startsWith(OS('door.why')) }).fill(SHIP_WORDS.takeOff)
        await answerOf(page, 'POST', /^\/shipping\/shipments\/[^/]+\/orders\/[^/]+\/take-off$/, () => press(box.getByRole('button', { name: DEPTH('shipOrders.takeOffGo'), exact: true })))
        await flow.settle()
        await expect.poll(async () => (await rowsOf(world.so2.id)).some((row) => row.id === shared.id), { timeout: 60_000 }).toBe(false)
        expect((await rowsOf(world.so3.id)).some((row) => row.id === shared.id), 'the draft stays on SEED-SO-0003').toBe(true)
      }

      // ── D6 (O7 B): a draft that travels without a DDT (a reason; "Set by hand"), then its DDT put back (the world as it was) ──
      const draft = (await rowsOf(world.so3.id)).find((row) => row.status === 'DRAFT' && row.origin !== 'ELSEWHERE' && row.ddtRequired === true && !row.ddt)
      if (!draft) notHere('travels without a DDT: no draft of SEED-SO-0003 that needs a DDT in this world')
      else {
        const box = await rowAct(world.so3.id, draft.number as string, OS('ships.act.ddtOff'))
        await box.getByRole('checkbox', { name: OS('door.ddt.tick'), exact: true }).check()
        await box.getByRole('textbox', { name: startsWith(OS('door.why')) }).fill(SHIP_WORDS.noDdt)
        await answerOf(page, 'PUT', /^\/shipping\/shipments\/[^/]+\/ddt-required$/, () => press(box.getByRole('button', { name: OS('door.ddt.go'), exact: true })))
        await flow.settle()
        await seen(shipmentRow(page, draft.number as string).getByText(OS('ships.chip.noDdt')), 60_000)
        await flow.shot(page, 'shipments-without-ddt')
        const back = await rowAct(world.so3.id, draft.number as string, OS('ships.act.ddtBack'))
        await back.getByRole('textbox', { name: startsWith(OS('door.why')) }).fill(SHIP_WORDS.ddtBack)
        await answerOf(page, 'PUT', /^\/shipping\/shipments\/[^/]+\/ddt-required$/, () => press(back.getByRole('button', { name: OS('door.ddt.backGo'), exact: true })))
        await flow.settle()
        await expect(shipmentRow(page, draft.number as string).getByText(OS('ships.chip.noDdt'))).toHaveCount(0, { timeout: 60_000 })
      }

      // ── D4 (B-OS-022): Tracking numbers… per parcel, where a parcel without a label may take one (PACKED or left) ──
      const so0101 = await orderOf(flow, page, 'SEED-SO-0101')
      const candidates = [world.so3.id, world.so2.id, so0101.id]
      let typedOn: { orderId: string; number: string; seqs: number[] } | null = null
      for (const orderId of candidates) {
        for (const row of await rowsOf(orderId)) {
          const free = ((row.parcels ?? []) as Json[]).filter((parcel) => parcel.source === null && parcel.number === null)
          if (typedOn || row.mayTypeTracking?.allowed !== true || !['PACKED', 'SHIPPED'].includes(row.status as string) || free.length === 0) continue
          typedOn = { orderId, number: row.number as string, seqs: free.map((parcel) => parcel.seq as number) }
        }
      }
      if (!typedOn) notHere('tracking numbers per parcel: no packed or left shipment of A carried by a carrier booked by hand with a parcel no label tracks')
      else {
        await warehouse.go(`/sales/orders/${typedOn.orderId}?tab=shipments`)
        await press(shipmentRow(page, typedOn.number).getByRole('button', { name: OS('ships.act.tracking'), exact: true }))
        const box = dialog(page)
        await seen(box.getByText(startsWith(lead(OS('door.tracking.parcels')))).first(), 60_000)
        for (const seq of typedOn.seqs) await box.getByRole('textbox', { name: OS('door.tracking.parcelNumber', { seq }), exact: true }).fill(SHIP_WORDS.parcel(seq))
        // After the goods left a number the customer saw that changes asks why (none was typed before: no reason here).
        await answerOf(page, 'PUT', /^\/shipping\/shipments\/[^/]+\/own-transport\/tracking$/, () => press(box.getByRole('button', { name: OS('door.tracking.go'), exact: true })))
        await flow.settle()
        const typedRow = (await rowsOf(typedOn.orderId)).find((row) => row.number === typedOn!.number)
        expect(((typedRow?.parcels ?? []) as Json[]).filter((parcel) => parcel.source === 'TYPED').map((parcel) => parcel.number)).toEqual(expect.arrayContaining(typedOn.seqs.map((seq) => SHIP_WORDS.parcel(seq))))
        await flow.shot(page, 'shipments-parcel-numbers')
      }

      // ── B-OS-016, D5: SEED-SO-0101's own-van shipment — the expected arrival set by hand, then Mark delivered… (our van: no reason) ──
      const van = (await rowsOf(so0101.id)).find((row) => row.status === 'SHIPPED' && row.transportBy === 'SENDER')
      if (!van) notHere('our van: SEED-SO-0101 has no shipment on its way with our van in this world')
      else {
        // os-fx6: the day inside the window the server allows (not before the goods left, at most a year ahead) — two days after the
        // later of today and its departure (the seeds date this departure in the story's days ahead), never a fixed calendar day.
        const leftAt = Date.parse(String(van.shippedAt ?? ''))
        const etaDay = new Date(Math.max(Date.now(), Number.isFinite(leftAt) ? leftAt : 0) + 2 * 86_400_000).toISOString().slice(0, 10)
        const eta = await rowAct(so0101.id, van.number as string, OS('ships.act.eta'))
        await pickDate(eta, OS('door.eta.day'), etaDay)
        // Why: required when it moves a day the customer already reads (F-OS-306), optional else — always said here.
        await eta.getByRole('textbox').last().fill(SHIP_WORDS.eta)
        await answerOf(page, 'PUT', /^\/shipping\/shipments\/[^/]+\/eta$/, () => press(eta.getByRole('button', { name: OS('door.eta.go'), exact: true })))
        await flow.settle()
        await warehouse.go(`/sales/orders/${so0101.id}?tab=shipments`)
        await seen(shipmentRow(page, van.number as string).getByText(OS('ships.dates.setByHand')).first(), 60_000)
        await flow.shot(page, 'shipments-van-expected')
      }
      // A delivery is typed at a time not before the goods left and not in the future: a departure dated ahead takes none yet.
      const vanLeft = van ? Date.parse(String(van.shippedAt ?? '')) : Number.NaN
      if (van && !(Number.isFinite(vanLeft) && vanLeft <= Date.now())) notHere('Mark delivered… on our van: the seeds date SEED-SO-0101’s departure in the story’s days ahead (a delivery is never before it left)')
      else if (van) {
        const before = await statusOf(flow, page, so0101.id)
        const delivered = await rowAct(so0101.id, van.number as string, OS('ships.act.delivered'))
        // Our van: why is not asked (no carrier's tracking to know better than). os-fx7 (W-05): the D6 window — one act, no five
        // typed statuses to choose from; Delivered stays final (its payment steps start that day).
        await expect(delivered.getByRole('textbox', { name: startsWith(OS('door.why')) })).toHaveCount(0)
        await expect(delivered.getByRole('radio')).toHaveCount(0)
        await seen(delivered.getByText(OS('door.status.deliveredFinal')), 60_000)
        await answerOf(page, 'POST', /^\/shipping\/shipments\/[^/]+\/own-transport\/events$/, () => press(delivered.getByRole('button', { name: OS('door.mark.go.DELIVERED'), exact: true })))
        await flow.settle()
        // The order follows its shipments (the worker's sales.ordersFollowShipments): every garment delivered → Delivered (os-fx5: from
        // Shipped; an order already closed in this world stays as it is).
        if (before === 'SHIPPED') await expect.poll(() => statusOf(flow, page, so0101.id), { timeout: 60_000 }).toBe('DELIVERED')
        else notHere(`the order following its delivered shipment: SEED-SO-0101 is ${before} in this world, not Shipped`)
        await warehouse.go(`/sales/orders/${so0101.id}?tab=shipments`)
        await seen(shipmentRow(page, van.number as string).getByText(OD('shipStatus.DELIVERED')).first(), 60_000)
        await flow.shot(page, 'shipments-van-delivered')
      }

      // ── D5 (B-OS-015): Mark delivered… over carrier labels — the person says why; tagged "Set by hand" (L1: Mark returned… beside it) ──
      const labelled = (await rowsOf(world.so2.id)).find((row) => row.status === 'SHIPPED' && row.transportBy === 'CARRIER' && (((row.parcels ?? []) as Json[]).some((parcel) => parcel.source === 'LABEL') || row.mayTypeTracking?.code === 'LABELLED'))
      const labelledLeft = labelled ? Date.parse(String(labelled.shippedAt ?? '')) : Number.NaN
      if (!labelled) notHere('over carrier labels: no shipment of SEED-SO-0002 on its way with a carrier label in this world')
      else if (!(Number.isFinite(labelledLeft) && labelledLeft <= Date.now())) notHere(`Mark delivered… over carrier labels: the seeds date ${labelled.number as string}’s departure in the story’s days ahead (a delivery is never before it left)`)
      else {
        const box = await rowAct(world.so2.id, labelled.number as string, OS('ships.act.delivered'))
        await seen(box.getByText(OS('door.status.labelled')), 60_000)
        await box.getByRole('textbox', { name: startsWith(OS('door.why')) }).fill(SHIP_WORDS.labelled)
        await expect(box.getByRole('radio')).toHaveCount(0) // os-fx7 (W-05): Mark delivered only — never a hand "In transit" over labels
        await answerOf(page, 'POST', /^\/shipping\/shipments\/[^/]+\/own-transport\/events$/, () => press(box.getByRole('button', { name: OS('door.mark.go.DELIVERED'), exact: true })))
        await flow.settle()
        await expect.poll(async () => (await rowsOf(world.so2.id)).find((row) => row.id === labelled.id)?.status, { timeout: 60_000 }).toBe('DELIVERED')
        await warehouse.go(`/sales/orders/${world.so2.id}?tab=shipments`)
        // "Set by hand" over a carrier's own labels (a TEST label is never tracked: then it reads as typed by the office).
        if (((labelled.parcels ?? []) as Json[]).some((parcel) => parcel.source === 'LABEL')) await seen(shipmentRow(page, labelled.number as string).getByText(OS('ships.dates.setByHand')).first(), 60_000)
        await flow.shot(page, 'shipments-labelled-by-hand')
      }

      // ── D2: Sales reads every cell with no shipment door; Read-only reads with no act at all ──
      for (const key of ['sales', 'reader'] as const) {
        const desk = key === 'sales' ? sales : await flow.desk('reader')
        await desk.go(`/sales/orders/${world.so3.id}?tab=shipments`)
        const tab = desk.page.locator('#shipments')
        await seen(tab, 60_000)
        for (const name of [OS('ships.act.tracking'), OD('step.createShipment'), OD('elsewhere.title')]) await expect(tab.getByRole('button', { name, exact: true }), `${key}: ${name}`).toHaveCount(0)
        await expectNothingOf(desk.page, BRAND_BETA, world.betaNumbers, `A's Shipments tab (${key})`)
        await flow.shot(desk.page, `shipments-${key}`)
      }

      // ── A's buyer reads the parcel numbers typed for its shipment in the portal (B's portal refuses A's orders: step 8) ──
      if (!typedOn) notHere('the typed parcel numbers in A’s portal: none was typed in this world')
      else {
        const alpha = await signInToPortal(flow, BRAND_ALPHA, alphaId)
        // os-fx5: a parcel's number is on the portal order's Shipments tab.
        await alpha.go(`/orders/${typedOn.orderId}?tab=shipments`)
        await seen(alpha.page.getByText(SHIP_WORDS.parcel(typedOn.seqs[0]!)).first(), 60_000)
        await expectNothingOf(alpha.page, BRAND_BETA, world.betaNumbers, 'alpha portal: typed parcel numbers')
      }
    })
    // ---- end F-OS T.2

    // ---- F-OF T.2 (order FILES tab): the tab at the end, on SEED-SO-0002 ----
    await flow.step('16 · the Files tab: Add files… to Line 1; Ask for a file… of a person → Upload for this ask → Ask again… → uploaded again → Accept… and share (the portal shows it); Rename… → Versions… → Restore v1; Delete… the wrong file (why); Sales reads the priced ask counted; Read-only finds no act', async () => {
      const owner = await flow.desk('owner')
      const { page } = owner
      const files = page.locator('#files')
      const asks = page.locator('#asks')
      const card = (scope: Page, name: string) => scope.locator('.fw-rtv-card').filter({ has: scope.locator('.fw-rtv-card-open', { hasText: name }) })
      const openFiles = async (desk: Desk) => {
        await desk.go(`/sales/orders/${world.so2.id}?tab=files`)
        await seen(desk.page.locator('#files'), 60_000)
      }
      const row = (scope: Page, text: string) => scope.locator('.fw-ask-row').filter({ hasText: text })

      // ── Add files… to Line 1: two files at once (the ONE upload window: where it goes, what it is, who sees it) ──
      await openFiles(owner)
      await press(files.getByRole('button', { name: FV('files.add'), exact: true }))
      const add = dialog(page)
      await add.locator('input[type="file"]').setInputFiles([FILES.spec, FILES.wrong])
      // fx6w (end check 1): the window lists each file as "name · size" in ONE item (the name is not an element of its own).
      for (const file of [FILES.spec, FILES.wrong]) await seen(add.getByRole('listitem').filter({ hasText: file.name }), 30_000)
      await add.getByRole('combobox', { name: FV('upload.where'), exact: true }).selectOption({ index: 1 }) // the order's first line
      await answerOf(page, 'POST', /^\/files\/[^/]+\/complete$/, () => press(add.getByRole('button', { name: FV('upload.confirm', { count: 2 }), exact: true })))
      // The files go one after the other: the window closes once both are sent (leaving earlier would stop the second).
      await expect(page.getByRole('dialog').filter({ hasText: FILES.wrong.name })).toHaveCount(0, { timeout: 120_000 })
      await flow.settle()
      await openFiles(owner)
      await seen(card(page, FILES.spec.name), 60_000)
      await seen(card(page, FILES.wrong.name), 60_000)
      await flow.shot(page, 'files-added-to-line')

      // ── Ask for a file… of a person: the Factory designer when the stack holds the role (S3: tasks.manage), else the Planner ──
      const roles = ((await flow.read(page, '/auth/roles')).roles ?? []) as Json[]
      const askedKey = roles.some((role) => role.key === 'designer' && !role.archivedAt) ? ('designer' as const) : ('planner' as const)
      if (askedKey === 'planner') notHere('the Factory designer asked: the stack holds no `designer` role; the Planner is asked instead')
      const askedName = askedKey === 'designer' ? 'Dina Designer' : 'Paola Planner'
      const asked = await flow.desk(askedKey)
      await press(asks.getByRole('button', { name: FA('band.ask'), exact: true }), 60_000)
      const askBox = dialog(page)
      await askBox.getByRole('textbox', { name: startsWith(FA('ask.what')) }).fill(FILES_WORDS.ask)
      const pick = askBox.getByRole('combobox', { name: FA('ask.pick.PERSON'), exact: true })
      await expect(pick.locator('option', { hasText: askedName }), `${askedName} may be asked (the choices read)`).toHaveCount(1, { timeout: 60_000 })
      await pick.selectOption({ label: askedName })
      await answerOf(page, 'POST', /^\/sales\/orders\/[^/]+\/file-asks$/, () => press(askBox.getByRole('button', { name: FA('ask.send'), exact: true })))
      await flow.settle()
      await seen(row(page, FILES_WORDS.ask), 60_000)

      // ── As that person: Upload for this ask (the asker's words on top of the ONE upload window) ──
      const uploadFor = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
        await openFiles(asked)
        const mine = row(asked.page, FILES_WORDS.ask)
        await seen(mine, 60_000)
        await press(mine.getByRole('button', { name: FA('act.upload'), exact: true }))
        const box = dialog(asked.page)
        await seen(box.getByText(FILES_WORDS.ask).first(), 30_000) // the asker's words on top
        await box.locator('input[type="file"]').setInputFiles(file)
        await answerOf(asked.page, 'POST', /^\/sales\/orders\/[^/]+\/file-asks\/[^/]+\/answer$/, () => press(box.getByRole('button', { name: FA('upload.send'), exact: true })))
        await flow.settle()
      }
      await uploadFor(FILES.first)

      // ── Back: "arrived to check" → Ask again… (why) → uploaded again ──
      await openFiles(owner)
      await expect(asks).toContainText(FA('band.answer.arrived', { count: 1 }), { timeout: 60_000 })
      await press(row(page, FILES_WORDS.ask).getByRole('button', { name: FA('act.again'), exact: true }))
      const againBox = dialog(page)
      await againBox.getByRole('textbox', { name: startsWith(FA('again.why')) }).fill(FILES_WORDS.again)
      await answerOf(page, 'POST', /^\/sales\/orders\/[^/]+\/file-asks\/[^/]+\/ask-again$/, () => press(againBox.getByRole('button', { name: FA('again.go'), exact: true })))
      await flow.settle()
      await uploadFor(FILES.second)

      // ── Accept… with "Share with {customer}": the file shows in A's portal Documents ──
      await openFiles(owner)
      await press(row(page, FILES_WORDS.ask).getByRole('button', { name: FA('act.accept'), exact: true }), 60_000)
      const acceptBox = dialog(page)
      await acceptBox.getByRole('checkbox', { name: startsWith(lead(FA('accept.share'))) }).check()
      await answerOf(page, 'POST', /^\/sales\/orders\/[^/]+\/file-asks\/[^/]+\/accept$/, () => press(acceptBox.getByRole('button', { name: FA('accept.go'), exact: true })))
      await flow.settle()
      await openFiles(owner)
      await expect(row(page, FILES_WORDS.ask)).toHaveCount(0, { timeout: 60_000 })
      await flow.shot(page, 'files-ask-accepted')
      const alpha = await signInToPortal(flow, BRAND_ALPHA, alphaId)
      await alpha.go(`/orders/${world.so2.id}?tab=documents`)
      await seen(alpha.page.getByText(FILES.second.name).first(), 60_000)
      await expectNothingOf(alpha.page, BRAND_BETA, world.betaNumbers, 'alpha portal: the accepted file')

      // ── Rename… (a new version with the new name) → Versions… → Restore v1 (the old name back as the next version) ──
      const act = async (name: string, item: string) => {
        const target = card(page, name)
        await seen(target, 60_000)
        await chooseFromMenu(target.getByRole('button', { name: FV('acts.menu.label', { name }), exact: true }), page.getByRole('menuitem', { name: startsWith(item) }))
        return dialog(page)
      }
      const rename = await act(FILES.spec.name, FV('acts.menu.rename'))
      await rename.getByRole('textbox', { name: FV('acts.rename.field'), exact: true }).fill(SPEC_RENAMED)
      await answerOf(page, 'POST', /^\/files\/[^/]+\/rename$/, async () => {
        await press(rename.getByRole('button', { name: FV('acts.rename.go'), exact: true }))
        await flow.stepUp(page, owner.person)
      })
      await flow.settle()
      await openFiles(owner)
      await seen(card(page, SPEC_RENAMED), 60_000)
      const versions = await act(SPEC_RENAMED, FV('acts.menu.versions'))
      await seen(versions.getByText(RF('versions.title', { name: SPEC_RENAMED })).first(), 60_000)
      const firstVersion = versions.getByRole('row').filter({ has: page.getByText(RF('versions.number', { n: 1 }), { exact: true }) })
      await answerOf(page, 'POST', /^\/files\/[^/]+\/restore$/, async () => {
        await press(firstVersion.getByRole('button', { name: RF('versions.restore'), exact: true }), 60_000)
        await flow.stepUp(page, owner.person)
      })
      await flow.settle()
      await press(versions.getByRole('button', { name: RF('versions.close'), exact: true }).last()) // the footer's Close (the head's ✕ shares the name)
      await openFiles(owner)
      await seen(card(page, FILES.spec.name), 60_000) // v1's name is in force again (a new version)
      await flow.shot(page, 'files-renamed-restored')

      // ── Delete… the wrong file: the whole document, with a reason (cannot be undone) ──
      const remove = await act(FILES.wrong.name, FV('acts.menu.delete'))
      await seen(remove.getByText(FV('acts.delete.warn')).first(), 30_000)
      await remove.getByRole('textbox', { name: startsWith(FV('acts.delete.why')) }).fill(FILES_WORDS.wrong)
      await answerOf(page, 'POST', /^\/files\/[^/]+\/delete-document$/, async () => {
        await press(remove.getByRole('button', { name: FV('acts.delete.go', { count: 1 }), exact: true }))
        await flow.stepUp(page, owner.person)
      })
      await flow.settle()
      await openFiles(owner)
      await expect(card(page, FILES.wrong.name)).toHaveCount(0, { timeout: 60_000 })

      // ── Sales reads the rows; a priced ask (made by the API, asked of Finance, who sees prices) is counted, never named ──
      byApi('the priced ask of step 16 (asked of Finance, who sees prices): its words never reach Sales')
      const finance = await flow.person('finance')
      await flow.write(page, 'POST', `/sales/orders/${world.so2.id}/file-asks`, { words: FILES_WORDS.priced, fileKind: 'DOCUMENT', target: { type: 'SALES_ORDER' }, who: { kind: 'PERSON', userId: finance.id }, dueOn: day(5), priced: true }, 201)
      await flow.settle()
      await openFiles(sales)
      const salesAsks = sales.page.locator('#asks')
      await seen(salesAsks, 60_000)
      await expect(salesAsks).toContainText(FA('band.counted.priced', { count: 1 }), { timeout: 60_000 })
      await expect(sales.page.getByText(FILES_WORDS.priced)).toHaveCount(0)
      await expectNothingOf(sales.page, BRAND_BETA, world.betaNumbers, "A's Files tab (sales)")
      await flow.shot(sales.page, 'files-sales')

      // ── Read-only reads: no Add files…, no Ask for a file…, a card's ⋯ without Rename… (Versions… only) ──
      const reader = await flow.desk('reader')
      await openFiles(reader)
      await expect(reader.page.getByRole('button', { name: FV('files.add'), exact: true })).toHaveCount(0)
      await expect(reader.page.getByRole('button', { name: FA('band.ask'), exact: true })).toHaveCount(0)
      const readCard = card(reader.page, FILES.spec.name)
      await seen(readCard, 60_000)
      const more = readCard.getByRole('button', { name: FV('acts.menu.label', { name: FILES.spec.name }), exact: true })
      if ((await more.count()) === 0) notHere('Read-only: the spec card has no ⋯ (nothing it may open from there)')
      else {
        await more.click()
        await seen(reader.page.getByRole('menuitem', { name: startsWith(FV('acts.menu.versions')) }), 30_000)
        await expect(reader.page.getByRole('menuitem', { name: startsWith(FV('acts.menu.rename')) })).toHaveCount(0)
        await reader.page.keyboard.press('Escape')
      }
      await flow.shot(reader.page, 'files-reader')
    })
    // ---- end F-OF T.2
  },
})
