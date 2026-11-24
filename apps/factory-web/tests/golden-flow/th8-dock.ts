import { expect, test, type Locator, type Page } from '@playwright/test'
import { BRAND_ALPHA } from '../../src/lib/testing/two-brands'
import { seen, type Flow } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { ensureBrand, signInToPortal } from './_harness/two-brands'
import { chooseFromMenu, day, routerActivity } from './_harness/ui'
import { startsWith, words } from './_harness/words'

/**
 * F-OP-218 — UI golden flow TH-8: THE ORDER PAGE'S DOCK (order page plan N4; 11-dock §0–§7, §10; review RC1–RC5, D1–D11). Runs right
 * after 07-order (stages.ts AFTER_STAGES) or alone on a fresh stack (`--stages th8-dock`): it makes its own world once — the seeded P1
 * as Brand Alpha with its portal buyer (two-brands.ts), an order for A, A's message in its order's conversation (the portal's screens),
 * an office note in A's general thread (set-up: no screen writes it here). Then, as Sales at 1440 × 900:
 *   1  per scope (This order, <Customer> (general), All of <Customer>): ONE card in the dock — tw- T.3: the pick is the head's title, the head ONE row,
 *      the body that scrolls (the page does not), the foot or the box inside the viewport, at 40 % (Overview) and a third (Lines);
 *   2  the scope stays across tabs, the band's Change the lines (the dock stays put while the save bar shows; Discard on the bar)
 *      and a reload; an arrival from the orders list starts on This order;
 *   3  no loop: five picks over 10 s write the address with no router request (0 rsc), no document, at most 6 writes of the address
 *      (each with at most Next's one echo to the same address: routerActivity `writes`);
 *   4  Answer on A's line → This order with the box focused on a reply ("Replying to …"); on the general note → General, Office note;
 *   5  the keyboard walk of All of (J / K, Space), light and dark, the phone (375: the full-width view, ← Back).
 * Not here, said in the report: a project's scope (nothing links a project to this order), a work order's notes (10-work-order checks
 * them on the W1 order once it has one), a file opened from the body while All of shows (the order of this world carries no file the
 * body opens through the dock: a proof of delivery comes with 14-ship; the ask is held by the unit tests of F-OP-212).
 */

const OD = words('orders')
const RT = words('record-thread')
const BOX = words('record-thread-composer')
const FRAME = words('record-frame')
const HEAD = words('record-thread-head')
const CARD = words('record-thread-card') // tw- T.3: a bubble's menu (Answer in its thread)
const DS = words('ds-words')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A catalogue sentence's words before its first placeholder (pass the key's raw text: `words(ns)(key)` keeps its placeholders). */
const lead = (text: string) => text.split(/\{[a-zA-Z]+\}/)[0]!.trim()

/** The made-up words of this stage. */
const FROM_ALPHA = 'Made-up from Brand Alpha on its order: can the sleeves of the size 52 be two centimetres longer?'
const GENERAL_NOTE = 'Made-up office note on Brand Alpha: their new warehouse takes deliveries from December.'
// op-fx4: the order's own reference, not Brand Alpha's fixture one: th1a-sheet (later in the run) calls P1 Brand Beta and scans its
// rows for Brand Alpha's markers, the fixture's reference among them.
const DOCK_REF = 'T-TH8-DOCK-PO-0001'

type Made = { id: string; number: string }

/** The office record frame's dock, its ONE card and its bands. */
const dockOf = (page: Page): Locator => page.locator('.fw-rcf.has-thread > aside.fw-rcf-dock')
const cardOf = (page: Page): Locator => dockOf(page).locator('section.fw-rt-column.is-docked')
/** tw- T.3 (W2.1, Z4, P0-B4): the pick is the head's title — ONE menu named "<Which thread>: <the picked thread>", one label per thread. */
const pickOf = (page: Page): Locator => cardOf(page).locator('.fw-rth-title button.fw-thread-pick-title')
/** tw- fx2 (G-21): the title is the thread's record label; the name keeps the picked row's long label ("<label>: <record> · <long>"). */
const pickedName = (long: string) => new RegExp(`^${escape(OD('record.dock.label'))}: (?:.+ · )?${escape(long)}$`)
async function expectPicked(page: Page, long: string, timeout = 30_000): Promise<void> {
  await expect(pickOf(page)).toHaveAttribute('aria-label', pickedName(long), { timeout })
}
/** A message of All of <Customer> (tw- W2.5: the thread's own bubble, read only). */
const allItem = (page: Page, words: string): Locator => cardOf(page).locator('article.fw-aoc-item').filter({ hasText: words })
/** A bubble's menu row (its arrow in the corner; the menu portals to the page). */
async function fromBubbleMenu(page: Page, bubble: Locator, row: string): Promise<void> {
  await bubble.hover()
  await chooseFromMenu(bubble.locator('button.fw-rt-msg-more').first(), page.getByRole('menuitem', { name: row, exact: true }))
}
const feedHead = (page: Page): Locator => cardOf(page).locator('.fw-rth.fw-aoc-head')

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  expect(box, 'drawn on the screen').not.toBeNull()
  return box!
}

/** The card: ONE head row (its title the pick, a line under it), no band above it, its foot (or box) inside the viewport. */
async function expectCard(page: Page, where: string, kind: 'thread' | 'all'): Promise<void> {
  const card = cardOf(page)
  await expect(card, where).toHaveCount(1)
  await expect(card.locator('.fw-rt-top'), `${where}: no pick band (tw- W2.1)`).toHaveCount(0)
  const head = kind === 'all' ? feedHead(page) : card.locator('.fw-rth').first()
  await seen(head)
  await seen(head.locator('.fw-thread-pick'))
  const height = Math.round((await boxOf(head)).height)
  expect(height, `${where}: the Head is ONE row of two lines (56 px, P0-B1)`).toBeGreaterThanOrEqual(44)
  expect(height, `${where}: the Head is ONE row of two lines (56 px, P0-B1)`).toBeLessThanOrEqual(72)
  const headBox = await boxOf(head)
  const cardBox = await boxOf(card)
  expect(headBox.y - cardBox.y, `${where}: the head is the card's first band`).toBeLessThanOrEqual(2)
  const foot = kind === 'all' ? card.locator('.fw-rt-foot') : card.locator('.fw-rt-composer').first()
  await seen(foot)
  const viewport = page.viewportSize()!
  const at = await boxOf(foot)
  expect(at.y + at.height, `${where}: the foot is inside the viewport`).toBeLessThanOrEqual(viewport.height + 1)
}

/** The body scrolls on its own: its overflow is the card's (auto, contained) and a wheel over it never moves the page. */
async function expectBodyScrolls(page: Page, where: string, kind: 'thread' | 'all'): Promise<void> {
  // op-fx11: F-OP-304 (#1753, walk #12) renamed the dock card's scroller .fw-rt-body → .fw-rt-scroll (.fw-rt-body is a message's words).
  const body = kind === 'all' ? cardOf(page).locator('.fw-rt-scroll') : cardOf(page).locator('.fw-rt-feed')
  await seen(body)
  const style = await body.evaluate((element) => ({ overflowY: getComputedStyle(element).overflowY, overscroll: getComputedStyle(element).overscrollBehaviorY }))
  expect(style.overflowY, `${where}: the body scrolls`).toMatch(/auto|scroll/)
  const pageTop = () =>
    page.evaluate(() => {
      for (let node: HTMLElement | null = document.querySelector<HTMLElement>('.fw-rcf')?.parentElement ?? null; node; node = node.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node.scrollTop
      }
      return document.scrollingElement?.scrollTop ?? 0
    })
  const before = await pageTop()
  await body.hover()
  await page.mouse.wheel(0, 600)
  await page.waitForTimeout(300)
  expect(await pageTop(), `${where}: the page did not move under the wheel`).toBe(before)
}

async function pick(page: Page, long: string): Promise<void> {
  // tw- fx1: the row in use starts with the DS's "✓" (part of its name).
  await chooseFromMenu(pickOf(page), page.getByRole('menuitemcheckbox', { name: new RegExp(`^(?:✓\\s*)?${escape(long)}`) }))
  await expectPicked(page, long)
}

export default defineStage({
  proves:
    'the order page’s dock: every scope (This order, General, All of) in ONE card — the pick in the one-row Head, a body that scrolls alone, the foot in view at 40 %, a third and 375 px; the scope kept across tabs, Amend and a reload, This order on an arrival; five picks write the address with no router request; Answer opens the line’s thread with the box focused (Reply on the customer’s line, Office note on a note); the keyboard walk; light and dark',
  async run(flow: Flow) {
    const sales = await flow.desk('sales')
    const { page } = sales
    const alphaId = await flow.seedId('party:P1')
    const customer = BRAND_ALPHA.legalName

    const order = await flow.step('set-up: P1 as Brand Alpha with its portal buyer, an order for A, an office note in A’s general thread', async () => {
      await ensureBrand(flow, sales, BRAND_ALPHA, alphaId)
      const made = await flow.write(
        page,
        'POST',
        '/sales/orders/manual',
        {
          companyId: flow.companyId,
          partyId: alphaId,
          customerRef: DOCK_REF,
          promiseDate: day(45),
          depositPct: null,
          lines: [{ styleId: await flow.seedId('product:style:JKT-01'), colourwayId: await flow.seedId('product:colourway:JKT-01:BLK'), sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }],
        },
        201,
      )
      await flow.write(page, 'POST', `/threads/Party/${alphaId}/notes`, { body: GENERAL_NOTE, mentions: [], attachments: [] }, 201)
      return { id: made.order.id as string, number: made.order.number as string } satisfies Made
    })

    await flow.step('customer A writes in its order’s conversation (the portal’s docked conversation)', async () => {
      const alpha = await signInToPortal(flow, BRAND_ALPHA, alphaId)
      await alpha.go(`/orders/${order.id}`)
      const dock = alpha.page.locator('.fw-prf[data-mode="docked"] > aside#messages')
      await seen(dock, 60_000)
      await dock.getByRole('textbox', { name: DS('partnerThread.composer'), exact: true }).fill(FROM_ALPHA)
      await dock.getByRole('button', { name: DS('partnerThread.send'), exact: true }).click()
      await seen(dock.getByText(FROM_ALPHA), 60_000)
      await flow.settle()
    })

    const go = (search = '') => sales.go(`/sales/orders/${order.id}${search}`)

    await flow.step('1 · every scope in ONE card: the pick as the Head’s title, the body that scrolls alone, the foot in view (40 %, a third)', async () => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await go('?tab=overview')
      await seen(pickOf(page), 60_000)
      await expectCard(page, 'This order · 40 %', 'thread')
      await expectBodyScrolls(page, 'This order', 'thread')
      await pick(page, OD('record.dock.general', { customer }))
      await expectCard(page, 'General · 40 %', 'thread')
      await seen(cardOf(page).getByText(GENERAL_NOTE))
      await pick(page, OD('record.dock.all', { customer }))
      await expectCard(page, 'All of · 40 %', 'all')
      await expect(feedHead(page).locator('.fw-rth-line')).toContainText(lead(HEAD('allOf.line_other'))) // "Read only · N threads"
      await expect(cardOf(page).locator('.fw-rt-foot')).toContainText(`${OD('record.dock.readOnly')}. ${OD('record.dock.writeIn')}`)
      await seen(allItem(page, FROM_ALPHA), 60_000)
      await expectBodyScrolls(page, 'All of', 'all')
      await flow.shot(page, 'dock-all-forty')
      // Lines: a third under 1600 px (a grid tab), the same card.
      await go('?tab=lines&thread=all')
      await expectCard(page, 'All of · a third (Lines)', 'all')
      await pick(page, OD('record.dock.order'))
      await expectCard(page, 'This order · a third (Lines)', 'thread')
      await flow.shot(page, 'dock-order-third')
    })

    await flow.step('2 · the scope stays across tabs, Change the lines and a reload; an arrival from the orders list starts on This order', async () => {
      await go('?tab=overview')
      await pick(page, OD('record.dock.all', { customer }))
      await page.waitForURL(/[?&]thread=all/)
      const tabs = page.getByRole('navigation', { name: OD('record.tabsLabel'), exact: true })
      for (const tab of ['tab.lines', 'tab.production', 'tab.money']) {
        await tabs.getByRole('link', { name: startsWith(OD(tab)) }).click()
        await page.waitForURL(new RegExp(`[?&]tab=${tab.slice(4)}`))
        await expect(page, `${OD(tab)} keeps All of`).toHaveURL(/[?&]thread=all/)
        await seen(feedHead(page))
      }
      // F-OL-05: Change the lines (the band's ⋯) lands on Lines — no edit mode, the table changes in place — the scope kept.
      await tabs.getByRole('link', { name: startsWith(OD('tab.overview')) }).click()
      await page.waitForURL(/[?&]tab=overview/)
      const more = page.getByRole('button', { name: OD('record.more'), exact: true }).first()
      const change = page.getByRole('menuitem', { name: startsWith(OD('lineMenu.changeLines')) })
      await more.click()
      if ((await change.count()) > 0 && (await change.first().isEnabled())) {
        await change.first().click()
        await page.waitForURL(/[?&]tab=lines/)
        await expect(page, 'Change the lines keeps All of').toHaveURL(/[?&]thread=all/)
        await seen(feedHead(page))
        // F-OL-06 (Order LINES lane): one size typed in the table shows the save bar at the bottom; the dock does not move for it.
        const before = await boxOf(cardOf(page))
        const size50 = page.locator('.fw-lt').getByRole('textbox', { name: /, size 50$/ }).first()
        await expect(size50).toHaveValue('2')
        await size50.fill('3')
        const bar = page.getByRole('region', { name: DS('editModeBar.region'), exact: true })
        await seen(bar.getByText(OD('save.count', { count: 1 }), { exact: true }))
        const after = await boxOf(cardOf(page))
        for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[side] - before[side]), `the dock's ${side} while the bar shows`).toBeLessThanOrEqual(1)
        await flow.shot(page, 'dock-with-save-bar')
        // Discard on the bar asks first ("Discard 1 change?", naming the line); Keep changing is the first choice; Discard empties it.
        await bar.getByRole('button', { name: DS('editModeBar.discard'), exact: true }).click()
        const confirm = page.getByRole('dialog', { name: OD('save.discard.title', { count: 1 }) })
        await seen(confirm)
        await confirm.getByRole('button', { name: OD('save.discard.go', { count: 1 }), exact: true }).click()
        await expect(bar).toHaveCount(0)
        await expect(size50).toHaveValue('2')
        await expect(page, 'Discard keeps All of').toHaveURL(/[?&]thread=all/)
      } else {
        await page.keyboard.press('Escape')
        test.info().annotations.push({ type: 'not here', description: 'Changing the lines is held on this order (its state): the scope across the door is held by the unit tests of F-OP-210' })
      }
      await page.reload()
      await seen(feedHead(page), 60_000)
      await expectPicked(page, OD('record.dock.all', { customer }))
      // An arrival from outside (the list) has no scope: This order.
      await sales.go(`/sales/orders?q=${encodeURIComponent(DOCK_REF)}`)
      await page.getByRole('link', { name: order.number, exact: true }).first().click()
      await page.waitForURL(new RegExp(`/sales/orders/${order.id}`))
      await expect(page).not.toHaveURL(/[?&]thread=/)
      await expectPicked(page, OD('record.dock.order'), 60_000)
    })

    await flow.step('3 · no loop: five picks over 10 s — no router request, no document, at most 6 writes of the address', async () => {
      await go('?tab=overview')
      await seen(pickOf(page), 60_000)
      await page.waitForTimeout(3_000) // the page's own first reads and a build's prefetches are done before the window opens
      const seenNow = await routerActivity(page, 10_000, async () => {
        await pick(page, OD('record.dock.general', { customer }))
        await pick(page, OD('record.dock.all', { customer }))
        await pick(page, OD('record.dock.order'))
        await pick(page, OD('record.dock.all', { customer }))
        await pick(page, OD('record.dock.general', { customer }))
      })
      const said = seenNow.lines.join('\n')
      // F-OP-209: a pick is the frame's ONE history write — the server is never asked for the page again.
      expect(seenNow.router, said).toBe(0)
      expect(seenNow.documents, said).toBe(0)
      // op-fx4: a pick is ONE write of the address; Next 16 echoes each write once to the same address (routerActivity `writes`).
      expect(seenNow.writes, said).toBeLessThanOrEqual(6)
      expect(seenNow.navigations, said).toBeLessThanOrEqual(2 * seenNow.writes)
      await expect(page).toHaveURL(/[?&]thread=general/)
    })

    await flow.step('4 · Answer: A’s line → This order with the box focused on a reply; the general note → General, Office note', async () => {
      await go('?tab=overview&thread=all')
      // tw- T.3 (W2.5): Answer is the bubble's menu row "Answer in its thread".
      const line = allItem(page, FROM_ALPHA)
      await seen(line, 60_000)
      await fromBubbleMenu(page, line, CARD('menu.answerThere'))
      await expectPicked(page, OD('record.dock.order'))
      const box = cardOf(page).locator('.fw-rt-composer textarea').first()
      await expect(box, 'the box takes the focus').toBeFocused({ timeout: 30_000 })
      // W2.3: the audience chip (its name "Who reads what you write: …") and the box's data-mode say it is a reply, not an office note.
      await expect(cardOf(page).locator('.fw-rt-composer').first(), 'a reply, not an office note').not.toHaveAttribute('data-mode', 'note')
      await expect(cardOf(page).locator('.fw-rt-cx-chipbtn').first()).not.toHaveAttribute('aria-label', `${BOX('modeLabel')}: ${BOX('mode.note')}`)
      await seen(cardOf(page).getByRole('group', { name: startsWith(lead(BOX('link.replying'))) }))
      await flow.shot(page, 'answer-reply')

      await go('?tab=overview&thread=all')
      const note = allItem(page, GENERAL_NOTE)
      await seen(note, 60_000)
      await fromBubbleMenu(page, note, CARD('menu.answerThere'))
      await expectPicked(page, OD('record.dock.general', { customer }))
      await expect(cardOf(page).locator('.fw-rt-composer textarea').first()).toBeFocused({ timeout: 30_000 })
      await expect(cardOf(page).locator('.fw-rt-composer').first()).toHaveAttribute('data-mode', 'note')
      await expect(cardOf(page).locator('.fw-rt-cx-chipbtn').first()).toHaveAttribute('aria-label', `${BOX('modeLabel')}: ${BOX('mode.note')}`)
      // Leave the box empty: nothing is written by this check.
      await page.keyboard.press('Escape')
    })

    await flow.step('5 · the keyboard walk of All of; light and dark; the phone (375: the full-width view, ← Back)', async () => {
      await go('?tab=overview&thread=all')
      // tw- T.3 (W2.5): the messages are the thread's bubbles (oldest at the top); J / K walk them, one tab stop.
      const lines = cardOf(page).locator('article.fw-aoc-item')
      await seen(lines.first(), 60_000)
      expect(await lines.count(), 'two messages at least to walk').toBeGreaterThanOrEqual(2)
      await lines.first().focus()
      await page.keyboard.press('j')
      await expect(lines.nth(1)).toBeFocused()
      await page.keyboard.press('k')
      await expect(lines.first()).toBeFocused()
      // The keys are said in the foot's ONE info icon.
      await expect(cardOf(page).locator('.fw-rt-foot .info')).toHaveAttribute('aria-label', RT('allOfCustomer.keysTip'))

      await page.emulateMedia({ colorScheme: 'dark' })
      await expectCard(page, 'All of · dark', 'all')
      await flow.shot(page, 'dock-all-dark')
      await page.emulateMedia({ colorScheme: 'light' })

      // The phone: the scope in the address keeps the full-width view open (the same card, ← Back above it); Back gives the body;
      // the band's Thread button opens the view again on the scope the frame kept (F-OP-209).
      await page.setViewportSize({ width: 375, height: 812 })
      await seen(page.locator('.fw-rcf[data-view="thread"]'), 30_000)
      await expectCard(page, 'All of · 375', 'all')
      await flow.shot(page, 'dock-all-phone')
      await page.getByRole('button', { name: startsWith(FRAME('thread.back')) }).first().click()
      await seen(page.locator('.fw-rcf[data-view="body"]'), 30_000)
      await page.getByRole('button', { name: startsWith(FRAME('thread.button')) }).first().click()
      await seen(page.locator('.fw-rcf[data-view="thread"]'), 30_000)
      await expect(page).toHaveURL(/[?&]thread=all/)
      await seen(feedHead(page))
      await page.setViewportSize({ width: 1440, height: 900 })
      // The ⋮ never folds away on All of (D6); tw- T.0: the width is its ⋮ › Width, as in the record thread's head.
      await go('?tab=overview&thread=all')
      await expect(feedHead(page).getByRole('button', { name: HEAD('width.label'), exact: true })).toHaveCount(0)
      await chooseFromMenu(feedHead(page).getByRole('button', { name: HEAD('more.label'), exact: true }), page.getByRole('menuitem', { name: startsWith(HEAD('width.reset')) }))
    })

    test.info().annotations.push(
      { type: 'not here', description: 'a project’s scope: no project links the order of this world' },
      { type: 'not here', description: 'a work order’s notes in the dock: 10-work-order checks them on the W1 order once it has one' },
      { type: 'not here', description: 'a file opened from the body while All of shows: no body file of this order opens through the dock before 14-ship (a proof of delivery); the ask is held by the unit tests of F-OP-212' },
    )
  },
})
