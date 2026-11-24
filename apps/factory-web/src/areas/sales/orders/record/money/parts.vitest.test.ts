import { readFileSync } from 'node:fs'
import { createElement as h, Fragment, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, FileText, Info, Lock, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { Banner, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { money } from '../../../quotes/model'
import { dayInstant, type Tone } from '../../model'
import { LineMenuButton } from '../view/LineMenu'
import { Facts, Fold, GapRow, InvoiceList, MoneyAnswer, type InvoiceListRow } from './view/parts'
import { keepNumbers, useSay } from './view/say'
import { word } from './word'

/**
 * F-CM-k1 (customer MONEY tab, 13-backend §3.1, 15-steps K1.1; 18-lead-settles Z2) — the order Money's five small parts, shared with
 * the customer's Money tab: each part draws TODAY's markup of the order's Money tab letter for letter. "Today" below is the order
 * Money's own markup as its sections drew it before the parts (MoneyHead, TotalsSection, PaymentsSection, PriceCheckSection,
 * MarginSection, InvoicesSection), transcribed with createElement; the same icons and DS parts, so a library's markup never makes
 * noise. Every name and number is made up.
 */

const icon = (Icon: LucideIcon, size: number) => h(Icon, { size, 'aria-hidden': true })
const noop = () => undefined

// ---- today's markup, transcribed ----
const todayIcon = (tone: Tone, reading: boolean) => (reading ? icon(RefreshCw, 18) : tone === 'success' ? icon(CheckCircle2, 18) : tone === 'danger' ? icon(TriangleAlert, 18) : tone === 'warning' ? icon(Clock, 18) : icon(Info, 18))
/** MoneyHead.tsx:21-28 before F-CM-k1. */
const todayHead = (tone: Tone, reading: boolean, title: ReactNode, below: readonly string[]) =>
  h(Banner, { className: 'fw-om-head', tone, icon: todayIcon(tone, reading), title }, below.length > 0 ? h('span', { className: 'fw-om-head-wall' }, icon(Lock, 13), ' ', below.join(' ')) : null)
/** TotalsSection.tsx:111-114 and PaymentsSection.tsx:72-75 (with a hint) · PriceCheckSection.tsx:189-192 and MarginSection.tsx:123-126 (without). */
const todayFold = (open: boolean, label: string, hint?: string) =>
  hint === undefined
    ? h('button', { type: 'button', className: 'fw-om-fold', 'aria-expanded': open, onClick: noop }, open ? icon(ChevronDown, 14) : icon(ChevronRight, 14), label)
    : h('button', { type: 'button', className: 'fw-om-fold', 'aria-expanded': open, onClick: noop }, open ? icon(ChevronDown, 14) : icon(ChevronRight, 14), label, ' ', h('span', null, '· ', hint))
/** TotalsSection.tsx:93-96 (the settled row) and :99-106 (a gap). */
const todaySettled = (words: ReactNode) => h('p', { className: 'fw-om-gap is-ok' }, icon(CheckCircle2, 14), h('span', null, words))
const todayGap = (words: ReactNode, extra: ReactNode | null, door: ReactNode | null) => h('p', { className: 'fw-om-gap' }, icon(AlertCircle, 14), h('span', null, words, extra ? h('b', null, ' ', extra) : null), door)
/** TotalsSection.tsx:134-149. */
const todayFacts = (facts: readonly { key: string; label: string; value: ReactNode }[]) => h('dl', { className: 'fw-om-facts' }, facts.map((fact) => h('div', { key: fact.key }, h('dt', null, fact.label), h('dd', null, fact.value))))

/** InvoicesSection.tsx:102-191 (one row) before F-CM-k1: the order's chain invoice read through the row's plain fields. */
function TodayRow({ row, price, words, items }: { row: InvoiceListRow; price: boolean; words: boolean; items: MenuItemDef[] }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = useSay(row.currency)
  const number = row.number ?? t('money.draft')
  const sub = [...(row.issueDate ? [formatDate(dayInstant(row.issueDate), { locale })] : []), ...row.subs.map(say)].join(' · ')
  const amount = (value: number | null) => (value === null ? null : money(value, row.currency, locale))
  // cm-fx1: Tag and Pill take their children as a prop (TagProps / PillProps: `children` required) — the same element, typed honestly.
  const pay = () => h('div', { className: 'fw-om-ir-p' }, row.payment ? h(Tag, { tone: row.payment.tone, children: say(row.payment.word) }) : null)
  return h(
    'div',
    { className: 'fw-om-ir', id: row.anchor, tabIndex: -1 },
    h(
      'div',
      { className: 'fw-om-ir-n' },
      h('span', { className: 'fw-om-ir-nb' }, icon(FileText, 13), h(Link, { className: 'fw-pt-link', href: row.href }, `${row.number ?? t('moneyTab.invoices.noNumber')} ›`)),
      sub ? h('span', { className: 'fw-pt-sub' }, keepNumbers(sub)) : null,
      row.also
        ? h(
            'span',
            { className: 'fw-pt-sub fw-om-ir-also' },
            row.also.orders.length > 0 ? h('span', null, t('money.alsoBills')) : null,
            row.also.orders.map((other) => h(Link, { key: other.id, className: 'fw-pt-link', href: other.href }, other.number)),
            row.also.hidden > 0 ? h('span', null, t('money.alsoBillsHidden', { count: row.also.hidden })) : null,
          )
        : null,
      h('span', { className: 'fw-om-ir-kn' }, say(row.kind)),
    ),
    h('div', { className: 'fw-om-ir-kd' }, say(row.kind)),
    h(
      'div',
      { className: 'fw-om-ir-s' },
      row.sdi === 'reading'
        ? h('span', { className: 'fw-pt-inline' }, h(Spinner, { size: 12 }), ' ', t('deposit.step.sdiReading'))
        : row.sdi === 'failed'
          ? h('span', { className: 'fw-pt-inline' }, t('moneyTab.invoices.sdiFailed'), h(Button, { size: 'sm', variant: 'link', onClick: noop }, t('common.retry')))
          : h(Pill, { tone: row.state.tone, children: say(row.state.word) }),
    ),
    price
      ? h(
          Fragment,
          null,
          pay(),
          h('div', { className: 'fw-om-ir-t' }, row.total !== null ? h('span', { 'data-l': t('money.col.gross') }, amount(row.total)) : null, row.open !== null ? h('span', { 'data-l': t('money.col.open') }, amount(row.open)) : null),
          h('div', { className: 'fw-om-ir-am' }, amount(row.total)),
          h('div', { className: 'fw-om-ir-am fw-om-ir-share' }, row.extra),
          h('div', { className: 'fw-om-ir-am' }, row.open !== null ? h('b', null, amount(row.open)) : null),
        )
      : words
        ? pay()
        : null,
    h('div', { className: 'fw-om-ir-o' }, h(LineMenuButton, { label: t('moneyTab.invoices.more', { number }), items })),
  )
}

/** InvoicesSection.tsx:74-94 before F-CM-k1: the list, its head row (the sixth column "This order"), then the rows. */
function TodayList({ rows, price, items }: { rows: readonly InvoiceListRow[]; price: boolean; items: MenuItemDef[] }) {
  const t = useT('orders')
  const words = !price && rows.some((row) => row.payment !== null)
  return h(
    'div',
    { className: `fw-om-il${price ? '' : ` is-np${words ? ' has-pay' : ''}`}` },
    h(
      'div',
      { className: 'fw-om-ir is-hd', 'aria-hidden': true },
      h('div', null, t('money.col.number')),
      h('div', { className: 'fw-om-ir-kd' }, t('money.col.kind')),
      h('div', null, t('money.col.status')),
      price
        ? h(Fragment, null, h('div', null, t('moneyTab.invoices.col.payment')), h('div', { className: 'fw-om-ir-am' }, t('money.col.gross')), h('div', { className: 'fw-om-ir-am fw-om-ir-share' }, t('money.share')), h('div', { className: 'fw-om-ir-am' }, t('money.col.open')))
        : words
          ? h('div', null, t('moneyTab.invoices.col.payment'))
          : null,
      h('div', null),
    ),
    rows.map((row) => h(TodayRow, { key: row.id, row, price, words, items })),
  )
}

// ---- the rows (made up) ----
const GOODS: InvoiceListRow = {
  id: 'inv-1',
  anchor: 'about-Invoice-inv-1',
  number: 'FT-2026-00003',
  issueDate: '2026-11-20',
  currency: 'EUR',
  href: '/w/DEMO/finance/invoices/inv-1',
  kind: word('docType.TD01'),
  state: { word: word('invoiceStatus.DELIVERED'), tone: 'success' },
  sdi: null,
  payment: { word: word('moneyTab.invoices.pay.part'), tone: 'warning' },
  total: 532896,
  open: 232896,
  subs: [word('moneyTab.invoices.sub.forShipment', { params: { numbers: 'SEED-SH-0102' } })],
  also: { orders: [{ id: 'so-3', number: 'SEED-SO-0003', href: '/w/DEMO/sales/orders/so-3' }], hidden: 2 },
  extra: '€ 3,100.00',
}
const DRAFT: InvoiceListRow = { ...GOODS, id: 'inv-2', anchor: 'about-Invoice-inv-2', number: null, issueDate: null, href: '/w/DEMO/finance/invoices/inv-2', state: { word: word('invoiceStatus.DRAFT'), tone: 'neutral' }, payment: null, total: null, open: null, subs: [], also: null, extra: null }
const READING: InvoiceListRow = { ...GOODS, id: 'inv-3', anchor: 'about-Invoice-inv-3', sdi: 'reading', also: null }
const FAILED: InvoiceListRow = { ...GOODS, id: 'inv-4', anchor: 'about-Invoice-inv-4', sdi: 'failed', payment: null, also: { orders: [], hidden: 1 } }
const ROWS = [GOODS, DRAFT, READING, FAILED]
/** Without the price grain the host hands no amount (its own rule): total, open and the sixth column are null. */
const noPrice = (row: InvoiceListRow): InvoiceListRow => ({ ...row, total: null, open: null, extra: null })
const ITEMS: MenuItemDef[] = [{ id: 'copy', label: 'Copy number', onSelect: noop }]
const tOf = (locale: Locale) => createTranslator(locale, messagesFor(locale, ['orders']).orders!)
/** A word as React writes it in markup ("This order's share" → "This order&#x27;s share"). */
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

describe('F-CM-k1: the five parts draw the order Money\'s markup letter for letter', () => {
  it('MoneyAnswer: the tone\'s icon (reading first), the answer as the title, the wall line only when there is one', () => {
    const title = keepNumbers('Invoice FT-2026-00003 open, due 25/11/2026.')
    for (const tone of ['neutral', 'info', 'success', 'warning', 'danger'] as const) {
      for (const reading of [false, true]) {
        for (const below of [[], ['Amounts are shown to people who see prices.', 'Invoices are shown to people who see them.']]) {
          expect(render(h(MoneyAnswer, { tone, reading, title, below })), `${tone} ${reading} ${below.length}`).toBe(render(todayHead(tone, reading, title, below)))
        }
      }
    }
    expect(render(h(MoneyAnswer, { tone: 'info', reading: false, title, below: [] }))).not.toContain('fw-om-head-wall')
    expect(render(h(MoneyAnswer, { tone: 'info', reading: false, title, below: ['A.', 'B.'] }))).toContain('</svg> A. B.</span>')
    // The title is a node: the numbers kept whole (F-OM-fx6), the customer's company line fits in it too (Z26).
    expect(render(h(MoneyAnswer, { tone: 'info', reading: false, title, below: [] }))).toContain('<span class="fw-om-num">FT-2026-00003</span>')
  })

  it('Fold: with its hint (" · hint", the space before the span) and without, open and closed', () => {
    for (const open of [false, true]) {
      expect(render(h(Fold, { open, onToggle: noop, label: 'How it adds up', hint: 'from the order to what is left' })), `hint ${open}`).toBe(render(todayFold(open, 'How it adds up', 'from the order to what is left')))
      expect(render(h(Fold, { open, onToggle: noop, label: 'By line (3)' })), `no hint ${open}`).toBe(render(todayFold(open, 'By line (3)')))
    }
    expect(render(h(Fold, { open: false, onToggle: noop, label: 'Earlier steps (2)', hint: 'replaced or removed' }))).toContain('Earlier steps (2) <span>· replaced or removed</span></button>')
    expect(render(h(Fold, { open: true, onToggle: noop, label: 'Only the lines that differ' }))).toMatch(/<\/svg>Only the lines that differ<\/button>$/)
    expect(render(h(Fold, { open: true, onToggle: noop, label: 'L' }))).toContain('aria-expanded="true"')
  })

  it('GapRow: a gap with its bold extra and its door, a gap alone, the settled row', () => {
    const door = h('a', { className: 'fw-pt-link', href: '#invoices' }, 'Invoices ↓')
    expect(render(h(GapRow, { words: 'Not invoiced yet', extra: '€ 1,200.00', door }))).toBe(render(todayGap('Not invoiced yet', '€ 1,200.00', door)))
    expect(render(h(GapRow, { words: 'Not paid in full' }))).toBe(render(todayGap('Not paid in full', null, null)))
    expect(render(h(GapRow, { ok: true, words: 'Settled on 20/11/2026' }))).toBe(render(todaySettled('Settled on 20/11/2026')))
    expect(render(h(GapRow, { words: 'Not invoiced yet', extra: '€ 1,200.00' }))).toContain('<span>Not invoiced yet<b> € 1,200.00</b></span>')
    expect(render(h(GapRow, { ok: true, words: 'Settled' }))).toContain('<p class="fw-om-gap is-ok">')
    // cm-fx4 (M-3): the optional danger tone (a late line, the customer's Money) — the same markup with `is-danger`; without it, today's.
    expect(render(h(GapRow, { words: 'A deposit is late', door, tone: 'danger' }))).toBe(render(todayGap('A deposit is late', null, door)).replace('<p class="fw-om-gap">', '<p class="fw-om-gap is-danger">'))
    expect(render(h(GapRow, { words: 'A deposit is late', door }))).toBe(render(todayGap('A deposit is late', null, door)))
  })

  it('Facts: one label → value pair each; a value may be the host\'s door', () => {
    const facts: { key: string; label: string; value: ReactNode }[] = [
      { key: 'moneyTab.totals.fact.deposit', label: 'Deposit', value: '30 % paid' },
      { key: 'moneyTab.totals.fact.margin', label: 'Margin now', value: h('a', { className: 'fw-pt-link', href: '#margin' }, '35.7 % ›') },
    ]
    expect(render(h(Facts, { facts }))).toBe(render(todayFacts(facts)))
    expect(render(h(Facts, { facts }))).toContain('<dl class="fw-om-facts"><div><dt>Deposit</dt><dd>30 % paid</dd></div>')
  })

  for (const locale of LOCALES) {
    it(`${locale}: InvoiceList with the price grain — Payment · Total · the sixth column · Open, and every row\'s ⋯`, () => {
      const t = tOf(locale)
      const asked: string[] = []
      const html = render(h(InvoiceList, { rows: ROWS, price: true, extraHead: t('money.share'), menuOf: (row: InvoiceListRow) => (asked.push(row.id), ITEMS), onRetrySdi: noop }), locale)
      expect(html).toBe(render(h(TodayList, { rows: ROWS, price: true, items: ITEMS }), locale))
      expect(html).toContain('<div class="fw-om-il">')
      expect(html).toContain(`<div class="fw-om-ir-am fw-om-ir-share">${esc(t('money.share'))}</div>`)
      // The host builds each row's ⋯ (asked once per row, in order).
      expect(asked).toEqual(ROWS.map((row) => row.id))
    })

    it(`${locale}: InvoiceList without the price grain — no amount column; the Payment words once a row names them (is-np has-pay)`, () => {
      const t = tOf(locale)
      const words = ROWS.map(noPrice)
      const none = words.map((row) => ({ ...row, payment: null }))
      const withWords = render(h(InvoiceList, { rows: words, price: false, extraHead: t('money.share'), menuOf: () => ITEMS, onRetrySdi: noop }), locale)
      expect(withWords).toBe(render(h(TodayList, { rows: words, price: false, items: ITEMS }), locale))
      expect(withWords).toContain('<div class="fw-om-il is-np has-pay">')
      const without = render(h(InvoiceList, { rows: none, price: false, extraHead: t('money.share'), menuOf: () => ITEMS }), locale)
      expect(without).toBe(render(h(TodayList, { rows: none, price: false, items: ITEMS }), locale))
      expect(without).toContain('<div class="fw-om-il is-np">')
      for (const html of [withWords, without]) {
        expect(html).not.toContain('fw-om-ir-share')
        expect(html).not.toContain('fw-om-ir-am')
        expect(textOf(html)).not.toMatch(/€|\d[.,]\d{2}\b/)
      }
      expect(without).not.toContain('fw-om-ir-p')
    })

    it(`${locale}: InvoiceList — a row's own ⋯ name (two drafts told apart, cm-fx4 M-8); absent, the number or "Draft" as before`, () => {
      const t = tOf(locale)
      const named = render(h(InvoiceList, { rows: [{ ...DRAFT, name: 'Draft 2 · SEED-SO-0002' }], price: true, extraHead: t('money.share'), menuOf: () => ITEMS }), locale)
      expect(named).toContain(`aria-label="${esc(t('moneyTab.invoices.more', { number: 'Draft 2 · SEED-SO-0002' }))}"`)
      const plain = render(h(InvoiceList, { rows: [DRAFT], price: true, extraHead: t('money.share'), menuOf: () => ITEMS }), locale)
      expect(plain).toBe(render(h(TodayList, { rows: [DRAFT], price: true, items: ITEMS }), locale))
    })
  }

  it('the parts say ORDER words with their own useSay; a host names its own catalogue (useSay(currency, namespace))', () => {
    const Said = ({ namespace, said }: { namespace?: string; said: string }) => h('span', null, useSay('EUR', namespace)(word(said)))
    for (const locale of LOCALES) {
      expect(textOf(render(h(Said, { said: 'money.share' }), locale)), locale).toBe(tOf(locale)('money.share'))
      const customer = createTranslator(locale, messagesFor(locale, ['customer-money'])['customer-money']!)
      expect(textOf(render(h(Said, { namespace: 'customer-money', said: 'money.nothingLate' }), locale)), locale).toBe(customer('money.nothingLate'))
    }
  })
})

describe('F-CM-k1: the parts file', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('owns its stylesheet (no css block moved); the windows import it too; the parts fetch nothing and take no order', () => {
    const parts = source('./view/parts.tsx')
    expect(parts).toContain("import './money.css'")
    expect(source('./view/MoneyDialogs.tsx')).toContain("import './money.css'")
    expect(source('./view/MoneyTab.tsx')).toContain("import './money.css'")
    expect(parts).not.toMatch(/fetch\(|lib\/api|useMoneyActs|record-model|from '\.\.\/\.\.\/\.\.\/api'/)
    for (const name of ['MoneyAnswer', 'Fold', 'GapRow', 'Facts', 'InvoiceList']) expect(parts, name).toContain(`export function ${name}(`)
    expect(parts).toContain('export interface InvoiceListRow {')
    // No look prop: a part takes data and doors only.
    expect(parts).not.toMatch(/className\?: string|variant\?:|look\?:/)
  })

  it('K1.2: the sections draw the parts (one place for each markup), each `./parts` import AFTER the file\'s Kit import', () => {
    for (const file of ['./view/TotalsSection.tsx', './view/PaymentsSection.tsx', './view/PriceCheckSection.tsx', './view/MarginSection.tsx']) {
      const text = source(file)
      expect(text.indexOf("from '../../view/production/Kit'"), file).toBeGreaterThan(-1)
      expect(text.indexOf("from './parts'"), file).toBeGreaterThan(text.indexOf("from '../../view/production/Kit'"))
      expect(text, file).toContain('<Fold ')
      expect(text, file).not.toContain('className="fw-om-fold"')
    }
    const totals = source('./view/TotalsSection.tsx')
    expect(totals).toContain('<GapRow ok words={say(totals.settledRow)} />')
    expect(totals).toContain('<Facts')
    expect(totals).not.toMatch(/className="fw-om-gap|className="fw-om-facts"/)
    const head = source('./view/MoneyHead.tsx')
    expect(head).toContain('<MoneyAnswer tone={head.tone} reading={head.reading}')
    expect(head).not.toMatch(/<Banner|fw-om-head-wall/)
  })

  it('K1.3: Invoices & credit notes draws the shared list — it builds each row\'s ⋯ and hands the sixth column; the row markup lives in the part only', () => {
    const text = source('./view/InvoicesSection.tsx')
    expect(text.indexOf("from './parts'")).toBeGreaterThan(text.indexOf("from '../../view/production/Kit'"))
    expect(text).toContain("<InvoiceList rows={rows} price={price} extraHead={t('money.share')} menuOf={menuOf} onRetrySdi={() => actions?.onRetryPart?.('sdi')} />")
    expect(text).toContain('extra: row.share === null ? null : money(row.share, order.currency, locale),')
    expect(text).not.toMatch(/className="fw-om-ir|className=\{`fw-om-il/)
    // The order's row carries the plain fields the list draws (its `invoice` stays, for the row's ⋯).
    const rows = source('./invoices.ts')
    for (const field of ['number: invoice.number,', 'issueDate: invoice.issueDate,', 'currency: order.currency,', '      href,', '      invoice,']) expect(rows, field).toContain(field)
  })
})
