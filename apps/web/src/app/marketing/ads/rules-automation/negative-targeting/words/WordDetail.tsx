'use client'

/**
 * Negative Targeting page, Words view (step 4) — one word's record: the DS `DetailModal` (centred, header and tabs fixed,
 * the body scrolls; a full-screen sheet on a phone), its address `?word=<id>&tab=overview|terms|where|history`.
 *
 *   header   word mark · the word                       state · covered              ▲ 3 of 14 ▼ (K / J)   ✕
 *            Amazon IT · 6 terms · 4 ad groups · 2 products
 *   tabs     Overview (numbers, why it wastes, the verb or why held, each product's part) · Terms (every term holding it:
 *            where, product, spend, clicks, orders, sold) · Where it runs (each ad group its terms spent in: wasting, blocked,
 *            held — with why — or not wasting) · History (the negatives made of it)
 *   footer   Block word · whole campaign     [Block word]
 *
 * Every verb opens the page's review ABOVE this modal (`onBlock`); the record is read again after it (`version`). A verb
 * that lands nowhere stays on screen, held, with the server's reason; so does every verb for a person who may not change ads.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Tag, Tooltip } from '@/design-system/primitives'
import { EntityPath, KeyValue, useNarrow, type EntityLinkComponent } from '@/design-system/components'
import { DetailModal, type DetailModalProps, type DetailNav } from '@/design-system/patterns'
import Link from '@/lib/workspaces/Link'
import type { ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import { money } from '../../bid/_shared/format'
import { HistoryTab } from '../waste/RowDetail'
import { StateMark } from '../waste/marks'
import { moneyOr, plural, writeHeld, xCpaText } from '../waste/wasteModel'
import type { HistoryItem, RowTest, Where } from '../waste/wasteTypes'
import { CoveredMark, WordMark, WordStateMark } from './wordColumns'
import { readWord } from './wordsApi'
import { groupTerms, placesWords, placeStateWord, placeWhy, productsWords, termsWords, wordVerb, type WordTab } from './wordsModel'
import type { WordDetail as WordDetailAnswer, WordPlace, WordProduct, WordRow, WordTerm } from './wordsTypes'
import styles from '../negatives.module.css'
import own from './words.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const PAGE = '/marketing/ads/rules-automation/negative-targeting'

export interface WordDetailProps {
  id: string
  /** The word as the table holds it (shown at once, while its record is read). */
  listRow: WordRow | null
  /** The filter bar's lists the list was read with: the record reads the same terms. */
  lists: ScopeApi | null
  tab: WordTab
  onTab(tab: WordTab): void
  nav?: DetailNav
  canWrite: boolean
  /** Bumped after every write: the record is read again. */
  version: number
  onBlock(row: WordRow, where: Where): void
  onClose(): void
  onUndo(item: HistoryItem): void
  returnFocusTo?: DetailModalProps['returnFocusTo']
}

export function WordDetail({ id, listRow, lists, tab, onTab, nav, canWrite, version, onBlock, onClose, onUndo, returnFocusTo }: WordDetailProps) {
  const [detail, setDetail] = useState<{ id: string; answer: WordDetailAnswer } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [again, setAgain] = useState(0)
  const listsKey = JSON.stringify(lists ?? {})
  useEffect(() => {
    const ctl = new AbortController()
    setReading(true)
    setErr(null)
    readWord(id, lists, ctl.signal)
      .then((answer) => { setDetail({ id, answer }); setReading(false) })
      .catch((e) => { if (!ctl.signal.aborted) { setErr(e instanceof Error ? e.message : String(e)); setReading(false) } })
    return () => ctl.abort()
  }, [id, version, again, listsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const answer = detail?.id === id ? detail.answer : null
  // The record's row is the freshest (read after the list); the list's row shows at once while it is read.
  const row: WordRow | null = answer?.row ?? (listRow?.id === id ? listRow : null)
  const held = writeHeld(canWrite)
  const notRead = (
    <p className={styles.quiet}>Not read: {err} <Button size="xs" variant="link" onClick={() => setAgain((n) => n + 1)}>Try again</Button></p>
  )

  const title: ReactNode = row ? (
    <span className={styles.detailTitle}>
      <WordMark terms={row.terms} />
      <span className={styles.ellipsis}>{row.word}</span>
    </span>
  ) : 'Word'
  const subtitle: ReactNode = row ? (
    <span className={styles.detailPath}>
      <span>{`Amazon ${row.market} · ${termsWords(row.terms)} · ${placesWords(row)} ·`}</span>
      {row.product?.href ? <Link href={row.product.href} className="nds-entitylink">{row.product.name}</Link> : <span>{productsWords(row)}</span>}
    </span>
  ) : undefined
  const meta: ReactNode = row ? (
    <span className={styles.marks}>
      <WordStateMark row={row} focusable />
      {row.coveredBy && <CoveredMark by={row.coveredBy} focusable />}
    </span>
  ) : undefined
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'terms', label: 'Terms', count: row?.terms ?? null },
    { id: 'where', label: 'Where it runs', count: row?.places.adGroups ?? null },
    { id: 'history', label: 'History', count: answer ? answer.history.length : null },
  ]

  const body = (render: (a: WordDetailAnswer) => ReactNode) => (err && !answer ? notRead : !answer ? <p className={styles.quiet}>Reading…</p> : render(answer))

  return (
    <DetailModal
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      meta={meta}
      tabs={tabs}
      activeTab={tab}
      onTabChange={(t) => onTab(t as WordTab)}
      tabsLabel="Word"
      nav={nav}
      loading={!row && reading}
      error={!row && err ? err : undefined}
      onRetry={() => setAgain((n) => n + 1)}
      returnFocusTo={returnFocusTo}
      footer={row ? <Footer row={row} held={held} onBlock={onBlock} /> : undefined}
    >
      {row && tab === 'overview' && <Overview row={row} products={answer?.products ?? null} onTab={onTab} />}
      {row && tab === 'terms' && body((a) => <TermsTab terms={a.terms} currency={row.currency} market={row.market} />)}
      {row && tab === 'where' && body((a) => <WhereTab places={a.places} currency={row.currency} />)}
      {row && tab === 'history' && body((a) => <HistoryTab items={a.history} canWrite={canWrite} onUndo={onUndo} />)}
    </DetailModal>
  )
}

/* ── the footer: Block word ──────────────────────────────────────────────────────────────────────────────────────── */

function Footer({ row, held, onBlock }: { row: WordRow; held: string | null; onBlock(row: WordRow, where: Where): void }) {
  const v = wordVerb(row)
  const c = wordVerb(row, 'campaign')
  return (
    <div className={styles.footer}>
      <span className="grow" />
      <Button size="sm" variant="secondary" heldReason={held ?? c.held} aria-label={c.sentence} onClick={() => onBlock(row, 'campaign')}>{c.label}</Button>
      <Button size="sm" variant={v.primary ? 'primary' : 'secondary'} heldReason={held ?? v.held} aria-label={v.sentence} onClick={() => onBlock(row, 'adGroup')}>{v.label}</Button>
    </div>
  )
}

/* ── Overview ────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The test in short: "Wastes" / "Not wasting" with its sentence on hover and focus, and the bar it is judged by. */
function TestValue({ test, currency }: { test: RowTest; currency: string }) {
  const bar = [
    plural(test.clicksNeeded, 'click'),
    typeof test.spendBarCents === 'number' ? `${money(test.spendBarCents, currency)}${test.xCpaBar ? ` (${xCpaText(test.xCpaBar)})` : ''}` : null,
    '0 orders',
    `${test.windowDays} d`,
  ].filter(Boolean).join(' · ')
  return (
    <span className={styles.inline}>
      <Tooltip label={test.sentence} portal>
        <span tabIndex={0}><Tag tone={test.met ? 'danger' : 'neutral'}>{test.met ? 'Wastes' : 'Not wasting'}</Tag></span>
      </Tooltip>
      <span>{bar}</span>
    </span>
  )
}

function Overview({ row, products, onTab }: { row: WordRow; products: WordProduct[] | null; onTab(t: WordTab): void }) {
  const cols = useNarrow() ? 2 : 3
  const d = row.d
  const v = wordVerb(row)
  const lands = v.held ? v.held : `A negative phrase "${row.word}" in ${plural(row.verb.places, 'ad group')}`
  return (
    <div className={styles.overview}>
      <KeyValue columns={cols} items={[
        { label: `Spend · ${row.test.windowDays} d`, value: moneyOr(d.spendCents, row.currency), hint: row.stockOutDays ? `${plural(row.stockOutDays, 'day')} out of stock left out` : undefined },
        { label: 'Clicks', value: d.clicks.toLocaleString('en-IE') },
        { label: 'Orders', value: d.orders.toLocaleString('en-IE'), hint: 'to today' },
        { label: 'Terms', value: <Button size="xs" variant="link" onClick={() => onTab('terms')}>{termsWords(row.terms)}</Button>, hint: row.sold ? `${row.sold} sold` : 'none sold' },
        { label: 'Places', value: <Button size="xs" variant="link" onClick={() => onTab('where')}>{placesWords(row)}</Button>, hint: [row.places.blocked ? `${row.places.blocked} blocked` : null, row.places.open ? `lands in ${row.places.open}` : null].filter(Boolean).join(' · ') || undefined },
        { label: 'CPC', value: moneyOr(d.cpcCents, row.currency) },
      ]} />
      <KeyValue columns={2} items={[
        // The state in one sentence, true for the whole row (the numbers above are every product's; the test is per product).
        { label: 'State', value: row.stateWhy },
        { label: 'Test', value: <TestValue test={row.test} currency={row.currency} />, hint: row.test.by ? `by ${row.test.by.name}` : 'by the page\'s default' },
        { label: 'Block word', value: lands, hint: v.held ? undefined : 'One change each; the review shows every place first' },
        ...(row.coveredBy ? [{ label: 'Covered by', value: `"${row.coveredBy}"`, hint: 'Blocking that word blocks this one' }] : []),
      ]} />
      {products && products.length > 1 && (
        <section aria-label="Products">
          <h3 className={styles.h3}>Products <span className={styles.count}>{products.length}</span></h3>
          <ul className={styles.places} aria-label="Products">
            {products.map((p, i) => (
              <li key={`${i}:${p.product?.id ?? 'shared'}`} className={styles.place}>
                <span className={own.lines}>
                  {p.product?.href ? <Link href={p.product.href} className={`nds-entitylink ${styles.ellipsis}`} title={p.product.name}>{p.product.name}</Link> : <span>{p.product?.name ?? 'Shared campaigns'}</span>}
                  <TestValue test={p.test} currency={row.currency} />
                </span>
                <span />
                <span className={styles.placeNum}>{`${moneyOr(p.d.spendCents, row.currency)} · ${plural(p.terms, 'term')}`}</span>
                <span className={styles.placeOpen}>{plural(p.places, 'ad group')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/* ── Terms ───────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Every term holding the word (one line each: as many as its count): its places (links), product, spend, clicks,
 *  orders, a mark when it sold. */
function TermsTab({ terms, currency, market }: { terms: WordTerm[]; currency: string; market: string }) {
  if (!terms.length) return <p className={styles.quiet}>None</p>
  return (
    <div role="table" aria-label="Terms" className={own.table}>
      <div role="row" className={own.head}>
        <span role="columnheader">Term · where</span>
        <span role="columnheader">Product</span>
        <span role="columnheader" className={own.num}>Spend</span>
        <span role="columnheader" className={own.num}>Clicks</span>
        <span role="columnheader" className={own.num}>Orders</span>
      </div>
      {groupTerms(terms).map((g) => {
        // The term's own record on the Wasting view (its place that spent most): its places, its verb, its history.
        const href = `${PAGE}?${new URLSearchParams({ market, view: 'wasting', show: 'all', row: g.places[0].rowId })}`
        return (
          <div role="row" key={g.key} className={own.row}>
            <span role="cell" className={own.lines}>
              <span className={styles.inline}>
                <Link href={href} className={`nds-entitylink ${styles.ellipsis}`} title={`${g.text} — open the search term`}>{g.text}</Link>
                {g.sold && <Tag tone="success" title="It sold in its window: a negative phrase there would block it">Sold</Tag>}
              </span>
              {g.places.map((t) => (
                <span key={t.rowId} className={`${own.sub} ${styles.inline}`}>
                  <StateMark row={{ state: t.state, match: 'EXACT', level: 'AD_GROUP' }} />
                  <EntityPath items={[t.portfolio, t.campaign, t.adGroup]} linkAs={WorkspaceLink} label="Where" />
                </span>
              ))}
            </span>
            <span role="cell" className={own.product}>
              {g.product?.href ? <Link href={g.product.href} className={`nds-entitylink ${styles.ellipsis}`} title={g.product.name}>{g.product.name}</Link> : <span className="nds-cell-muted">{g.products > 1 ? plural(g.products, 'product') : '—'}</span>}
            </span>
            <span role="cell" className={own.num} data-label="Spend">{moneyOr(g.d.spendCents, currency)}</span>
            <span role="cell" className={own.num} data-label="Clicks">{g.d.clicks.toLocaleString('en-IE')}</span>
            <span role="cell" className={own.num} data-label="Orders">{g.d.orders.toLocaleString('en-IE')}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ── Where ───────────────────────────────────────────────────────────────────────────────────────────────────────── */

const PLACE_TONE = { OPEN: 'danger', BLOCKED: 'info', HELD: 'neutral', NOT_WASTING: 'neutral' } as const

function WhereTab({ places, currency }: { places: WordPlace[]; currency: string }) {
  if (!places.length) return <p className={styles.quiet}>None</p>
  return (
    <ul className={styles.places} aria-label="Where its terms spent">
      {places.map((p) => {
        const why = placeWhy(p)
        const word = p.state === 'OPEN' ? 'Wasting' : placeStateWord(p.state)
        return (
          <li key={`${p.campaignId}|${p.adGroupId ?? ''}`} className={styles.place}>
            <span className={own.lines}>
              <span className={styles.placePath}><EntityPath items={[p.portfolio, p.campaign, p.adGroup]} linkAs={WorkspaceLink} label="Where" /></span>
              {why && <span className={own.sub}>{why}</span>}
            </span>
            <span className={styles.marks}>
              <Tag tone={PLACE_TONE[p.state]} title={why ?? undefined}>{word}</Tag>
            </span>
            <span className={styles.placeNum} title="Spend · orders of its terms here, in the window">{`${moneyOr(p.d.spendCents, currency)} · ${plural(p.d.orders, 'order')}`}</span>
            <span className={styles.placeOpen}>{plural(p.terms, 'term')}</span>
          </li>
        )
      })}
    </ul>
  )
}
