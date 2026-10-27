'use client'

/**
 * Negative Targeting page, Words view (step 4; redone 2026-10-26, RECORD-SPEC R1–R15) — one word's record: the DS
 * `DetailModal` (centred, header and tabs fixed, the body scrolls; a full-screen sheet on a phone), its address
 * `?word=<id>&tab=overview|terms|where|history`.
 *
 *   header   word mark · the word                                                  ▲ 2 of 5 ▼ (K / J)   ✕
 *            "Word in 13 search terms · 7 ad groups · 5 campaigns · Amazon IT"     the state pill (nobody looks after a word)
 *   tabs     Overview · Search terms N · Where it runs N · History N
 *   overview the banner (for which product it wastes) · four tiles · each product on its own · About this word; then
 *            what Block word does, place by place (where it lands, what it blocks there; where it is left out and why)
 *   terms    every search term holding the word, highest spend first (each opens its own record)
 *   where    Spends here (wasting · held · not wasting, with why) · Blocked here
 *   history  the negatives made of it (the DS Timeline)
 *   footer   the quiet line · Block word · whole campaign · [Block “cheap” in 3 ad groups]
 *
 * Every verb opens the page's review ABOVE this modal (`onBlock`); the record is read again after it (`version`). A verb
 * that lands nowhere stays on screen, held, with the server's reason; so does every verb for a person who may not change ads.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Pill, Tag } from '@/design-system/primitives'
import { Card, EntityPath, KeyValue, RecordLayout, SummaryTable, type EntityLinkComponent, type KeyValueItem } from '@/design-system/components'
import { DetailModal, type DetailModalProps, type DetailNav } from '@/design-system/patterns'
import Link from '@/lib/workspaces/Link'
import type { ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import { dayWords } from '../../bid/_shared/format'
import { Counted, FooterNote, HistoryTab, RecordBanner, RecordMetrics, RecordPill, Slot } from '../waste/RowDetail'
import { historyStep } from '../waste/recordModel'
import { moneyOr, plural, writeHeld } from '../waste/wasteModel'
import type { HistoryItem, WasteCriteria, Where } from '../waste/wasteTypes'
import { WordMark } from './wordColumns'
import { readWord } from './wordsApi'
import {
  blockPlanView, blockWordWords, groupTerms, placesWords, placeWhy, productChecks, termsCardWords, wordBanner, wordMetrics, wordPill, wordPlacePill,
  wordSubtitle, wordTestWords, wordVerb, wordWhereWords, type WordTab,
} from './wordsModel'
import type { WordDetail as WordDetailAnswer, WordPlace, WordProduct, WordRow, WordTerm } from './wordsTypes'
import s from '../waste/record.module.css'

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
  /** Optional (2026-10-26): the list's days the numbers count to, for the About card's "Counted to". */
  criteria?: Pick<WasteCriteria, 'settledThrough' | 'ordersThrough'> | null
}

export function WordDetail({ id, listRow, lists, tab, onTab, nav, canWrite, version, onBlock, onClose, onUndo, returnFocusTo, criteria }: WordDetailProps) {
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
    <p className={s.quiet}>Not read: {err} <Button size="xs" variant="link" onClick={() => setAgain((n) => n + 1)}>Try again</Button></p>
  )

  const title: ReactNode = row ? (
    <span className={s.title}>
      <WordMark terms={row.terms} />
      <span className={s.ellipsis}>{row.word}</span>
    </span>
  ) : 'Word'
  const subtitle: ReactNode = row ? (
    <span className={s.subtitle}>
      <span className={s.lead}>{wordSubtitle(row)}</span>
      <span className={s.sep} aria-hidden>·</span>
      <span>{`Amazon ${row.market}`}</span>
    </span>
  ) : undefined
  // Nobody looks after a word: the state pill only.
  const meta: ReactNode = row ? <span className={s.meta}><RecordPill view={wordPill(row)} /></span> : undefined
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'terms', label: 'Search terms', count: row?.terms ?? null },
    { id: 'where', label: 'Where it runs', count: row?.places.adGroups ?? null },
    { id: 'history', label: 'History', count: answer ? answer.history.length : null },
  ]

  const body = (render: (a: WordDetailAnswer) => ReactNode) => (err && !answer ? notRead : !answer ? <p className={s.quiet}>Reading…</p> : render(answer))

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
      {row && tab === 'overview' && <Overview row={row} answer={answer} criteria={criteria ?? null} onTab={onTab} />}
      {row && tab === 'terms' && body((a) => <TermsTab row={row} terms={a.terms} />)}
      {row && tab === 'where' && body((a) => <WhereTab row={row} places={a.places} />)}
      {row && tab === 'history' && body((a) => (
        <HistoryTab items={a.history} canWrite={canWrite} onUndo={onUndo} noun="word" empty="A negative phrase made from this word shows here when it is added or removed." />
      ))}
    </DetailModal>
  )
}

/* ── the footer: Block word ──────────────────────────────────────────────────────────────────────────────────────── */

function Footer({ row, held, onBlock }: { row: WordRow; held: string | null; onBlock(row: WordRow, where: Where): void }) {
  const v = wordVerb(row)
  const c = wordVerb(row, 'campaign')
  const main = blockWordWords(row)
  return (
    <div className={s.footer}>
      <FooterNote />
      <span className={s.grow} />
      <Slot><Button size="sm" variant="secondary" heldReason={held ?? c.held} aria-label={c.sentence} onClick={() => onBlock(row, 'campaign')}>{c.label}</Button></Slot>
      <Slot primary={v.primary}>
        <Button size="sm" variant={v.primary ? 'primary' : 'secondary'} heldReason={held ?? v.held} aria-label={main.sentence} onClick={() => onBlock(row, 'adGroup')}>{main.label}</Button>
      </Slot>
    </div>
  )
}

/* ── Overview ────────────────────────────────────────────────────────────────────────────────────────────────────── */

const productCell = (p: WordProduct['product'], products: number): ReactNode => (p?.href
  ? <Link href={p.href} className={`nds-entitylink ${s.ellipsis}`} title={p.name}>{p.name}</Link>
  : <span>{p?.name ?? (products > 1 ? plural(products, 'product') : 'Shared campaigns')}</span>)

const placePath = (p: Pick<WordPlace, 'campaign' | 'adGroup' | 'level'>, sub?: string | null) => (
  <span className={s.pathCell}>
    <EntityPath items={[p.campaign, p.level === 'CAMPAIGN' ? null : p.adGroup]} linkAs={WorkspaceLink} label="Where" />
    {p.level === 'CAMPAIGN' && <span className="nds-summary-sub">whole campaign</span>}
    {sub && <span className="nds-summary-sub">{sub}</span>}
  </span>
)

function Overview({ row, answer, criteria, onTab }: { row: WordRow; answer: WordDetailAnswer | null; criteria: Pick<WasteCriteria, 'settledThrough' | 'ordersThrough'> | null; onTab(t: WordTab): void }) {
  const products = answer?.products ?? null
  const checks = products && products.length > 1 ? productChecks(row, products) : null
  const plan = answer ? blockPlanView(row, answer.places) : null
  const test = wordTestWords(row.test)
  const last = answer?.history[0] ? historyStep(answer.history[0]) : null
  const about: KeyValueItem[] = [
    { label: 'Places', value: <Button variant="link" inline onClick={() => onTab('where')}>{placesWords(row)}</Button>, hint: `Block word lands in ${row.places.open}` },
    { label: 'Block word adds', value: `A negative phrase "${row.word}"`, hint: 'It stops every search term with the word there' },
    { label: 'Test', value: test.value, hint: test.hint },
    ...(row.coveredBy ? [{ label: 'Covered by', value: `"${row.coveredBy}"`, hint: 'Blocking that word blocks this one' }] : []),
    ...(criteria ? [{ label: 'Counted to', value: `${dayWords(criteria.settledThrough)} for clicks and spend`, hint: `Orders to ${dayWords(criteria.ordersThrough)}: a late order can only save it` }] : []),
    ...(answer ? [last ? { label: 'Last change', value: last.label, hint: dayWords(answer.history[0].at) } : { label: 'Last change', value: 'None in the last 90 days' }] : []),
  ]

  const main = (
    <div className={s.col}>
      <RecordBanner view={wordBanner(row, products)} icon={row.state === 'PROTECTED' ? 'shield' : undefined} />
      <RecordMetrics metrics={wordMetrics(row)} />
      {checks && (
        <Card header="Each product on its own" description={checks.desc} headingLevel={3}>
          <SummaryTable
            label="Each product on its own"
            columns={['Product', 'Spend', 'Search terms', 'Ad groups', 'Limit', 'Result']}
            widths={['24%', '12%', '13%', '11%', '22%', '18%']}
            align={[undefined, 'right', 'right', 'right', undefined, 'right']}
            stackOnPhone
            rows={checks.rows.map((p) => ({
              id: p.id,
              cells: [
                productCell(p.product, p.products),
                <span key="s" className={s.num}>{p.spend}</span>,
                <span key="t" className={s.num}>{p.terms}</span>,
                <span key="a" className={s.num}>{p.adGroups}</span>,
                p.limit,
                <Tag key="r" tone={p.result.tone}>{p.result.word}</Tag>,
              ],
            }))}
          />
        </Card>
      )}
    </div>
  )
  const aside = (
    <Card header="About this word" headingLevel={3}>
      <KeyValue items={about.slice(0, 6)} dense labelCase="sentence" />
    </Card>
  )
  return (
    <div className={s.col}>
      <RecordLayout main={main} aside={aside} asideLabel="About this word" />
      {plan && plan.rows.length > 0 && (
        <Card header="What Block word does" description={plan.desc} headingLevel={3}>
          <SummaryTable
            label="What Block word does"
            columns={['Campaign › ad group', 'Block word', 'Why']}
            widths={['40%', '16%', '44%']}
            align={[undefined, undefined, 'left']}
            stackOnPhone
            rows={plan.rows.map((p) => ({
              id: p.id,
              cells: [placePath(p.place), p.lands ? p.block : <Tag key="b" tone="neutral">{p.block}</Tag>, p.why],
            }))}
          />
        </Card>
      )}
    </div>
  )
}

/* ── Search terms ────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Every search term holding the word (one row each: as many as its count): its places, product, spend, clicks, orders,
 *  a tag when it sold. Each opens its own record on the Wasting view. */
function TermsTab({ row, terms }: { row: WordRow; terms: WordTerm[] }) {
  const w = wordWhereWords(row)
  const groups = groupTerms(terms)
  return (
    <div className={s.col}>
      <p className={s.intro}>{w.terms}</p>
      <Card header={<Counted label="Search terms" n={row.terms} />} description={termsCardWords(row)} headingLevel={3}>
        {groups.length ? (
          <SummaryTable
            label="Search terms"
            columns={['Search term', 'Campaign › ad group', 'Product', 'Spend', 'Clicks', 'Orders']}
            widths={['22%', '34%', '16%', '10%', '9%', '9%']}
            align={[undefined, undefined, undefined, 'right', 'right', 'right']}
            stackOnPhone
            rows={groups.map((g) => {
              // The term's own record on the Wasting view (its place that spent most): its places, its verb, its history.
              const href = `${PAGE}?${new URLSearchParams({ market: row.market, view: 'wasting', show: 'all', row: g.places[0].rowId })}`
              return {
                id: g.key,
                cells: [
                  <span key="t" className={s.inline}>
                    <Link href={href} className={`nds-entitylink ${s.ellipsis}`} title={`${g.text} — open the search term`}>{g.text}</Link>
                    {g.sold && <Tag tone="success" title="It sold in its window: a negative phrase there would block it">Sold</Tag>}
                  </span>,
                  <span key="w" className={s.pathCell}>
                    {g.places.map((t) => <EntityPath key={t.rowId} items={[t.campaign, t.adGroup]} linkAs={WorkspaceLink} label="Where" />)}
                  </span>,
                  g.product ? productCell(g.product, 1) : <span key="p">{g.products > 1 ? plural(g.products, 'product') : '—'}</span>,
                  <span key="s" className={s.num}>{moneyOr(g.d.spendCents, row.currency)}</span>,
                  <span key="c" className={s.num}>{g.d.clicks.toLocaleString('en-IE')}</span>,
                  <span key="o" className={s.num}>{g.d.orders.toLocaleString('en-IE')}</span>,
                ],
              }
            })}
          />
        ) : <p className={s.quiet}>No search term holds it in the window.</p>}
      </Card>
    </div>
  )
}

/* ── Where it runs ───────────────────────────────────────────────────────────────────────────────────────────────── */

function WhereTab({ row, places }: { row: WordRow; places: WordPlace[] }) {
  const w = wordWhereWords(row)
  const spends = places.filter((p) => p.state !== 'BLOCKED')
  const blocked = places.filter((p) => p.state === 'BLOCKED')
  return (
    <div className={s.col}>
      <p className={s.intro}>{w.intro}</p>
      <Card header={<Counted label="Spends here" n={spends.length} />} description={w.spends} headingLevel={3}>
        {spends.length ? (
          <SummaryTable
            label="Spends here"
            columns={['Campaign › ad group', 'Product', 'State', 'Spend', 'Orders', 'Search terms']}
            widths={['38%', '16%', '14%', '10%', '9%', '13%']}
            align={[undefined, undefined, undefined, 'right', 'right', 'right']}
            stackOnPhone
            rows={spends.map((p) => {
              const why = placeWhy(p)
              const pill = wordPlacePill(p.state)
              return {
                id: `${p.campaignId}|${p.adGroupId ?? ''}`,
                cells: [
                  placePath(p, why),
                  productCell(p.product, p.productCount),
                  <Pill key="s" tone={pill.tone} title={why ?? undefined}>{pill.word}{why && <span className="nds-vh">: {why}</span>}</Pill>,
                  <span key="sp" className={s.num}>{moneyOr(p.d.spendCents, row.currency)}</span>,
                  <span key="o" className={s.num}>{p.d.orders.toLocaleString('en-IE')}</span>,
                  <span key="t" className={s.num}>{p.terms}</span>,
                ],
              }
            })}
          />
        ) : <p className={s.quiet}>Not spending anywhere.</p>}
      </Card>
      <Card header={<Counted label="Blocked here" n={blocked.length} />} description={w.blocked} headingLevel={3}>
        {blocked.length ? (
          <SummaryTable
            label="Blocked here"
            columns={['Campaign › ad group', 'Negative', 'Spend', 'Search terms']}
            widths={['46%', '22%', '14%', '18%']}
            align={[undefined, undefined, 'right', 'right']}
            stackOnPhone
            rows={blocked.map((p) => ({
              id: `${p.campaignId}|${p.adGroupId ?? ''}`,
              cells: [
                placePath(p),
                p.blockedBy ? `Negative phrase "${p.blockedBy.text}"${p.blockedBy.level === 'CAMPAIGN' ? ' · whole campaign' : ''}` : 'Negative phrase',
                <span key="sp" className={s.num}>{moneyOr(p.d.spendCents, row.currency)}</span>,
                <span key="t" className={s.num}>{p.terms}</span>,
              ],
            }))}
          />
        ) : <p className={s.quiet}>Not blocked anywhere.</p>}
      </Card>
    </div>
  )
}
