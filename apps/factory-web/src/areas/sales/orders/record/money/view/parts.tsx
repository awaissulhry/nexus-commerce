'use client'

import type { ReactElement, ReactNode } from 'react'
import Link from 'next/link'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Clock, FileText, Info, Lock, RefreshCw, TriangleAlert } from 'lucide-react'
import { Banner, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import { dayInstant, type Tone } from '../../../model'
import { LineMenuButton } from '../../view/LineMenu'
import type { MoneyWord } from '../word'
import { keepNumbers, useSay } from './say'
import './money.css'

/**
 * F-CM-k1 (customer MONEY tab, 13-backend §3.1; 18-lead-settles Z2) — the order Money's five small parts, SHARED: the order's Money
 * tab draws them, and so does the customer's Money tab — EXACTLY the same parts, no look prop: a page hands them data and doors. Each
 * draws the order Money's own markup letter for letter (the order page did not change: the DOM diff of every SCR-039 case) and this
 * file imports the order Money's stylesheet itself (a part owns its stylesheet; no css block moved). The parts fetch nothing, take
 * no order and import no record model; they say ORDER words (`orders`, their own useSay) — a host says its own words itself.
 *
 *   MoneyAnswer   the tab's one answer line: a DS Banner in the tone's icon, the wall said once under it
 *   Fold          a folded part's button: chevron, label, and " · hint"
 *   GapRow        a line of what is left (or the settled line): its words, the bold extra, the door
 *   Facts         the facts list: label → value (a value may be the host's door)
 *   InvoiceList   Invoices & credit notes' rows: number (a door), sub-line, also bills, kind, state, payment, amounts, the sixth
 *                 column (the host's cell) and the row's ⋯ (every line of it the host's)
 */

/** The tab's one answer (MoneyHead's look): the tone's icon, the answer as the title, and — only when there is one — the wall line. */
export function MoneyAnswer({ tone, reading, title, below }: { tone: Tone; reading: boolean; title: ReactNode; below: readonly string[] }): ReactElement {
  const icon = reading ? <RefreshCw size={18} aria-hidden /> : tone === 'success' ? <CheckCircle2 size={18} aria-hidden /> : tone === 'danger' ? <TriangleAlert size={18} aria-hidden /> : tone === 'warning' ? <Clock size={18} aria-hidden /> : <Info size={18} aria-hidden />
  return (
    <Banner className="fw-om-head" tone={tone} icon={icon} title={title}>
      {below.length > 0 ? (
        <span className="fw-om-head-wall">
          <Lock size={13} aria-hidden /> {below.join(' ')}
        </span>
      ) : null}
    </Banner>
  )
}

/** A fold's button: the chevron by its state, the label, and with a hint " · {hint}" (the space before the span is the order page's). */
export function Fold({ open, onToggle, label, hint }: { open: boolean; onToggle: () => void; label: string; hint?: string }): ReactElement {
  return (
    <button type="button" className="fw-om-fold" aria-expanded={open} onClick={() => onToggle()}>
      {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      {label}
      {hint ? (
        <>
          {' '}
          <span>· {hint}</span>
        </>
      ) : null}
    </button>
  )
}

/**
 * A line of what is left (AlertCircle), or the settled line (`ok`: CheckCircle2): its words, the extra in bold, then its door.
 * cm-fx4 (M-3): `tone: 'danger'` — a line that is late (data, not a look switch); absent: the markup as before, letter for letter.
 */
export function GapRow({ ok, words, extra, door, tone }: { ok?: boolean; words: ReactNode; extra?: ReactNode; door?: ReactNode; tone?: 'danger' }): ReactElement {
  return (
    <p className={ok ? 'fw-om-gap is-ok' : tone === 'danger' ? 'fw-om-gap is-danger' : 'fw-om-gap'}>
      {ok ? <CheckCircle2 size={14} aria-hidden /> : <AlertCircle size={14} aria-hidden />}
      <span>
        {words}
        {extra ? <b> {extra}</b> : null}
      </span>
      {door}
    </p>
  )
}

/** The facts: one label → value pair each (a value may be the host's door, an `<a>`). */
export function Facts({ facts }: { facts: readonly { key: string; label: string; value: ReactNode }[] }): ReactElement {
  return (
    <dl className="fw-om-facts">
      {facts.map((fact) => (
        <div key={fact.key}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * One row of Invoices & credit notes, plain data (the order's row model, money/invoices.ts, with the document opened into plain
 * fields): its words are `orders` keys said in `currency`; every amount is null without the price grain (the host's rule).
 */
export interface InvoiceListRow {
  readonly id: string
  readonly anchor: string
  /** The document's number; null: a draft (its door says "No number yet ›"). */
  readonly number: string | null
  readonly issueDate: string | null
  readonly currency: string
  /** The document's own page (Finance). */
  readonly href: string
  readonly kind: MoneyWord
  readonly state: { readonly word: MoneyWord; readonly tone: Tone }
  /** The SDI read of an issued document: still reading, or failed (its own Retry); null: read, or none to read. */
  readonly sdi: 'reading' | 'failed' | null
  readonly payment: { readonly word: MoneyWord; readonly tone: Tone } | null
  readonly total: number | null
  readonly open: number | null
  readonly subs: readonly MoneyWord[]
  /** "Also bills": the other orders the document bills (named with their door), the rest counted; null: none. */
  readonly also: { readonly orders: readonly { readonly id: string; readonly number: string; readonly href: string }[]; readonly hidden: number } | null
  /** The sixth column's cell (price grain): the order page hands this order's share, the customer page its order's door. */
  readonly extra: ReactNode
  /** cm-fx4 (M-8): the ⋯'s own name when the number cannot tell rows apart (two drafts); absent: the number, or "Draft" (as before). */
  readonly name?: string
}

/**
 * The list of Invoices & credit notes: the head row, then one row per document. With the price grain: Payment · Total · the sixth
 * column (`extraHead`) · Open; without it no amount column at all — only the Payment words, once any row names them (has-pay).
 * Each row's ⋯ holds the host's lines only (`menuOf`: its doors, Discuss, copy the number, copy a link).
 */
export function InvoiceList({ rows, price, extraHead, menuOf, onRetrySdi }: { rows: readonly InvoiceListRow[]; price: boolean; extraHead: string; menuOf: (row: InvoiceListRow) => readonly MenuItemDef[]; onRetrySdi?: () => void }): ReactElement {
  const t = useT('orders')
  // F-OM-203 (B-OM-023): a reader without the price grain reads the Payment words once any row carries them.
  const words = !price && rows.some((row) => row.payment !== null)
  return (
    // F-OM-203 (B-OM-023): without the price grain the Payment column still shows, in words, once the rows name them.
    <div className={`fw-om-il${price ? '' : ` is-np${words ? ' has-pay' : ''}`}`}>
      <div className="fw-om-ir is-hd" aria-hidden>
        <div>{t('money.col.number')}</div>
        <div className="fw-om-ir-kd">{t('money.col.kind')}</div>
        <div>{t('money.col.status')}</div>
        {price ? (
          <>
            <div>{t('moneyTab.invoices.col.payment')}</div>
            <div className="fw-om-ir-am">{t('money.col.gross')}</div>
            <div className="fw-om-ir-am fw-om-ir-share">{extraHead}</div>
            <div className="fw-om-ir-am">{t('money.col.open')}</div>
          </>
        ) : words ? (
          <div>{t('moneyTab.invoices.col.payment')}</div>
        ) : null}
        <div />
      </div>
      {rows.map((row) => (
        <InvoiceListRowView key={row.id} row={row} price={price} words={words} items={menuOf(row)} onRetrySdi={onRetrySdi} />
      ))}
    </div>
  )
}

function InvoiceListRowView({ row, price, words, items, onRetrySdi }: { row: InvoiceListRow; price: boolean; words: boolean; items: readonly MenuItemDef[]; onRetrySdi?: () => void }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = useSay(row.currency)
  const number = row.number ?? t('money.draft')
  // F-OM-fx5w (N5): a draft says "Draft" once — in its State; its door names what it lacks ("No number yet ›"), its sub-line no "Draft".
  const sub = [...(row.issueDate ? [formatDate(dayInstant(row.issueDate), { locale })] : []), ...row.subs.map(say)].join(' · ')
  const amount = (value: number | null) => (value === null ? null : money(value, row.currency, locale))
  return (
    <div className="fw-om-ir" id={row.anchor} tabIndex={-1}>
      <div className="fw-om-ir-n">
        <span className="fw-om-ir-nb">
          <FileText size={13} aria-hidden />
          <Link className="fw-pt-link" href={row.href}>
            {`${row.number ?? t('moneyTab.invoices.noNumber')} ›` /* F-OM-fx3 (W-13): the number is a door; F-OM-fx5w (N5) */}
          </Link>
        </span>
        {sub ? <span className="fw-pt-sub">{keepNumbers(sub) /* F-OM-fx6 (N11) */}</span> : null}
        {/* F-OP-118: a shared invoice names the other orders it bills (links; the same customer's only), counts the rest. F-OM-fx5w (N4):
            its own row class (the kit's .fw-pt-sub is a block: the words ran into the link). */}
        {row.also ? (
          <span className="fw-pt-sub fw-om-ir-also">
            {row.also.orders.length > 0 ? <span>{t('money.alsoBills')}</span> : null}
            {row.also.orders.map((other) => (
              <Link key={other.id} className="fw-pt-link" href={other.href}>
                {other.number}
              </Link>
            ))}
            {row.also.hidden > 0 ? <span>{t('money.alsoBillsHidden', { count: row.also.hidden })}</span> : null}
          </span>
        ) : null}
        <span className="fw-om-ir-kn">{say(row.kind)}</span>
      </div>
      <div className="fw-om-ir-kd">{say(row.kind)}</div>
      <div className="fw-om-ir-s">
        {row.sdi === 'reading' ? (
          <span className="fw-pt-inline">
            <Spinner size={12} /> {t('deposit.step.sdiReading')}
          </span>
        ) : row.sdi === 'failed' ? (
          <span className="fw-pt-inline">
            {t('moneyTab.invoices.sdiFailed')}
            <Button size="sm" variant="link" onClick={() => onRetrySdi?.()}>
              {t('common.retry')}
            </Button>
          </span>
        ) : (
          <Pill tone={row.state.tone}>{say(row.state.word)}</Pill>
        )}
      </div>
      {price ? (
        <>
          <div className="fw-om-ir-p">{row.payment ? <Tag tone={row.payment.tone}>{say(row.payment.word)}</Tag> : null}</div>
          <div className="fw-om-ir-t">
            {row.total !== null ? <span data-l={t('money.col.gross')}>{amount(row.total)}</span> : null}
            {row.open !== null ? <span data-l={t('money.col.open')}>{amount(row.open)}</span> : null}
          </div>
          <div className="fw-om-ir-am">{amount(row.total)}</div>
          <div className="fw-om-ir-am fw-om-ir-share">{row.extra}</div>
          <div className="fw-om-ir-am">{row.open !== null ? <b>{amount(row.open)}</b> : null}</div>
        </>
      ) : words ? (
        <div className="fw-om-ir-p">{row.payment ? <Tag tone={row.payment.tone}>{say(row.payment.word)}</Tag> : null}</div>
      ) : null}
      <div className="fw-om-ir-o">
        <LineMenuButton label={t('moneyTab.invoices.more', { number: row.name ?? number })} items={[...items]} />
      </div>
    </div>
  )
}
