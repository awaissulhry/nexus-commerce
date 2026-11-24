import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen, OVERVIEW_ROLES, roleHeld, type OverviewRole } from '../fixtures'

/**
 * F-CO-301 (customer page › Overview; co-t T.1, T.2; 13-backend §4; 10-design §9) — the Overview's gallery cases (SCR-033) drawn as
 * the page draws them, split per language and per part: every `co-*` state with no key left; the money wall on the cases without
 * the price grain; the rights per office role (its template's REAL grant: the cards and doors drawn, the ones left out, no button
 * held for a right); worker privacy (office people only with partners.view). Made-up data only.
 */

const screen = designScreen as unknown as DesignScreen<unknown>
const caseOf = (id: string) => {
  const item = screen.cases.find((entry) => entry.id === id)
  if (!item) throw new Error(`no case ${id}`)
  return item
}
const draw = (id: string, locale: Locale): string => {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: caseOf(id).model })))
}
/** The words a person reads (tags, React's marks and e-mail addresses out; entities back; every run of space one space). */
const textOf = (html: string): string =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/[\w.+-]+@[\w.-]+/g, '')
    .replace(/\s+/g, ' ')
/** The Overview tab's own part of the page: from its root to the docked thread (the band and the notices stand above it). */
const overviewOf = (html: string): string => {
  const from = html.indexOf('class="fw-so-overview"')
  const dock = html.indexOf('class="fw-rcf-dock"', from)
  expect(from, 'the Overview is drawn').toBeGreaterThan(-1)
  return html.slice(from, dock > from ? dock : undefined)
}
/**
 * co-fx1: the same words with each element's text kept apart (" | " between elements) — so a count is a count only INSIDE one element
 * (S39's "3 invoices late" is one line), never a date of one element followed by the next element's first word ("…21/10/2026 |
 * Invoices are late"). Read at the end check: that join made a date and the strip's words look like a count.
 */
const cellsOf = (html: string): string => textOf(html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' | '))
const LEFT_KEY = /\b(?:customers|overview|record|status|side|warning|step|vies|held|field|kind|taxMode|identity|list|common|credit|promises|reason|hold|prom|col|work|group|urgency|limits|customerCard|tab|state|row|strips|cm|settings|fact|dialog|designer|people|dates|linked|facts|strip|headline|quiet|team|reqSide|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*/
const CO_CASES = screen.cases.filter((entry) => entry.id.startsWith('co-')).map((entry) => entry.id)

describe('the co-* states are in the gallery (15-steps T.1)', () => {
  it('every state the plan names has its case', () => {
    expect(CO_CASES).toEqual(
      expect.arrayContaining(['co-busy', 'co-hold', 'co-blocked', 'co-invoice-vies', 'co-prospect', 'co-quotes-only', 'co-no-open', 'co-archived', 'co-five-strips', 'co-reading', 'co-failed', 'co-no-orders', ...OVERVIEW_ROLES.map((role) => `co-role-${role.replace('_', '-')}`)]),
    )
    // The two windows' insides are cases of their own, drawn on the tab (never a Modal open on a server render).
    for (const id of ['overview-supervisor-new', 'overview-supervisor-nobody', 'overview-supervisor-refused']) {
      const part = overviewOf(draw(id, 'en'))
      expect(part, id).not.toContain('role="dialog"')
      expect(textOf(part), id).toContain('Who looks after')
    }
    for (const id of ['overview-designer-change', 'overview-designer-refused']) {
      const part = overviewOf(draw(id, 'en'))
      expect(part, id).not.toContain('role="dialog"')
      expect(textOf(part), id).toContain('Factory designer for')
    }
  })
})

for (const locale of LOCALES) {
  describe(`the Overview's gallery in ${locale}`, () => {
    it('every co-* case draws with no key left and no placeholder', () => {
      for (const id of CO_CASES) {
        const text = textOf(overviewOf(draw(id, locale)))
        expect(text.match(LEFT_KEY)?.[0] ?? null, `${id} (${locale})`).toBeNull()
        expect(text.match(/\{[a-zA-Z]+\}/)?.[0] ?? null, `${id} (${locale}) placeholder`).toBeNull()
      }
    })

    it('the money wall: without the price grain no amount and no count of invoices — the words alone', () => {
      for (const id of ['w2a-numbers-no-price', 'w2b-324-overview-no-price', 'co-role-sales', 'co-role-read-only', 'co-role-production-manager', 'co-role-warehouse']) {
        const text = textOf(overviewOf(draw(id, locale)))
        expect(text, `${id} (${locale})`).not.toMatch(/€|\d[\d.,]*\s?EUR\b/)
        expect(cellsOf(overviewOf(draw(id, locale))), `${id} (${locale})`).not.toMatch(/\d+\s+(invoices?|fattur[ae])\b/i)
      }
      // Sales and Read-only read the receivables: the words "Invoices are late", the credit as words.
      for (const id of ['co-role-sales', 'co-role-read-only']) {
        const text = textOf(overviewOf(draw(id, locale)))
        expect(text, id).toContain(locale === 'en' ? 'Invoices are late' : 'Ci sono fatture scadute')
        expect(text, id).toContain(locale === 'en' ? 'Over the credit limit' : 'Oltre il fido')
      }
      // With the grain the same reads carry their amounts and the API's count of late invoices (S39).
      for (const id of ['co-role-owner', 'co-role-finance']) {
        const text = textOf(overviewOf(draw(id, locale)))
        expect(text, id).toMatch(/€/)
        expect(text, id).toMatch(locale === 'en' ? /\d+ invoices late/ : /\d+ fatture scadute/)
      }
    })
  })
}

// ---- the rights, per office role (10-design §9): the cards and doors drawn, the ones left out — never "Not shown", never held for a right
interface RoleView {
  /** Who looks after: the office rows and the Portal row (partners.view). */
  readonly officePeople: boolean
  /** How many Change… (production.brand.manage: the supervisor's; partners.manage: the designer's). */
  readonly changes: number
  /** Amounts (the price grain). */
  readonly amounts: boolean
  /** The Overdue strip as words (receivables.view without the grain). */
  readonly lateWords: boolean
  /** The Credit fact (sales.credit.view). */
  readonly credit: boolean
  /** Customer facts' Edit (parties.manage). */
  readonly edit: boolean
  /** The money doors (the Money tab: money.price, receivables.view or sales.credit.view). */
  readonly moneyDoor: boolean
  /** "You can view, not change" (no parties.manage). */
  readonly viewOnly: boolean
  /** co-fx2 (walk CO-W-2): Linked records' Quotes and Incoming rows — the Quotes & incoming tab's (quotes.view or sales.inquiries.view). */
  readonly quotesTab: boolean
}
const ROLE_VIEWS: Readonly<Record<OverviewRole, RoleView>> = {
  owner: { officePeople: true, changes: 2, amounts: true, lateWords: false, credit: true, edit: true, moneyDoor: true, viewOnly: false, quotesTab: true },
  sales: { officePeople: true, changes: 1, amounts: false, lateWords: true, credit: true, edit: true, moneyDoor: true, viewOnly: false, quotesTab: true },
  production_manager: { officePeople: true, changes: 1, amounts: false, lateWords: false, credit: false, edit: false, moneyDoor: false, viewOnly: true, quotesTab: true },
  warehouse: { officePeople: false, changes: 0, amounts: false, lateWords: false, credit: false, edit: false, moneyDoor: false, viewOnly: true, quotesTab: false },
  finance: { officePeople: false, changes: 0, amounts: true, lateWords: false, credit: true, edit: true, moneyDoor: true, viewOnly: false, quotesTab: true },
  read_only: { officePeople: true, changes: 0, amounts: false, lateWords: true, credit: true, edit: false, moneyDoor: true, viewOnly: true, quotesTab: true },
}

describe('the rights per office role: a part without its right is left out, a button without its right is hidden', () => {
  it('the table above is the role templates\' own grant (a template that changes fails here first)', () => {
    for (const role of OVERVIEW_ROLES) {
      const held = roleHeld(role)
      const view = ROLE_VIEWS[role]
      expect(view.officePeople, role).toBe(held.has('partners.view'))
      expect(view.changes, role).toBe(view.officePeople ? Number(held.has('production.brand.manage')) + Number(held.has('partners.manage')) : 0)
      expect(view.amounts, role).toBe(held.has('money.price'))
      expect(view.lateWords, role).toBe(held.has('receivables.view') && !held.has('money.price'))
      expect(view.credit, role).toBe(held.has('sales.credit.view'))
      expect(view.edit, role).toBe(held.has('parties.manage'))
      expect(view.moneyDoor, role).toBe(held.has('money.price') || held.has('receivables.view') || held.has('sales.credit.view'))
      expect(view.viewOnly, role).toBe(!held.has('parties.manage'))
      expect(view.quotesTab, role).toBe(held.has('quotes.view') || held.has('sales.inquiries.view'))
    }
  })

  for (const role of OVERVIEW_ROLES) {
    it(`as ${role}: the cards and doors drawn, the ones left out`, () => {
      const id = `co-role-${role.replace('_', '-')}`
      const html = draw(id, 'en')
      const part = overviewOf(html)
      const text = textOf(part)
      const view = ROLE_VIEWS[role]
      expect(text.includes('Production supervisor'), `${id} office people`).toBe(view.officePeople)
      expect(text.includes('Portal settings'), `${id} portal row`).toBe(view.officePeople)
      expect(text.match(/Change…/g)?.length ?? 0, `${id} Change…`).toBe(view.changes)
      expect(/€/.test(text), `${id} amounts`).toBe(view.amounts)
      expect(text.includes('Invoices are late'), `${id} late words`).toBe(view.lateWords)
      expect(/class="fw-so-fact-label"[^>]*>Credit</.test(part), `${id} Credit fact`).toBe(view.credit)
      expect(/\bEdit\b/.test(text), `${id} Edit`).toBe(view.edit)
      expect(/Money ›/.test(text), `${id} money door`).toBe(view.moneyDoor)
      expect(textOf(html).includes('You can view, not change'), `${id} view only`).toBe(view.viewOnly)
      // co-fx2 (walk CO-W-2): without the Quotes tab's right, no Incoming and no Quotes row (the count read answers drafts anyway).
      expect(/\| Incoming \|/.test(cellsOf(part)), `${id} Incoming`).toBe(view.quotesTab)
      // The Quotes row also needs the open quotes' count (quotes.view): the tab through sales.inquiries.view alone shows Incoming only.
      expect(/\| Quotes \|/.test(cellsOf(part)), `${id} Quotes`).toBe(view.quotesTab && roleHeld(role).has('quotes.view'))
      // Never "Not shown: your role", never a button held for a right — on this tab, in both languages.
      for (const locale of LOCALES) {
        const words = textOf(overviewOf(draw(id, locale)))
        expect(words, `${id} (${locale})`).not.toMatch(/Not shown: your role|Non mostrato: il tuo ruolo/)
        expect(overviewOf(draw(id, locale)), `${id} (${locale}) held for a right`).not.toMatch(/Needs the right|Serve il permesso/)
      }
    })
  }

  it('a reader without orders.view: no band, no order row — the status word', () => {
    const part = overviewOf(draw('co-no-orders', 'en'))
    const text = textOf(part)
    expect(text).not.toContain('All orders of')
    // co-fx1: no Orders row — its own label (Linked records' row "Orders"); "n open of N" alone also says the Projects row.
    expect(cellsOf(part)).not.toMatch(/\| Orders \|/)
    expect(cellsOf(part)).toMatch(/\| Projects \|/)
    // The same reader with orders.view (co-busy): the Orders row is there, its label and its "n open of N".
    const busy = cellsOf(overviewOf(draw('co-busy', 'en')))
    expect(busy).toMatch(/\| Orders (?:\| )+\d+ open of \d+ ›/)
    expect(text).toContain('Active')
  })
})
