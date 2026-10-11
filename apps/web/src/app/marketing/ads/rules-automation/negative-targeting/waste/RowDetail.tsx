'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — one row's record: the DS `DetailModal` (centered, header and tabs
 * fixed, the body scrolls; a full-screen sheet on a phone), its address `?row=<id>&tab=overview|where|history`.
 *
 *   header   kind mark · words · match          state · waiting · owner          ▲ 3 of 14 ▼   ✕
 *            Amazon IT › portfolio › campaign › ad group · product                (each a link)
 *   tabs     Overview · Where it runs · History
 *   footer   Skip (7 d / 30 d)                          other verbs ▾  [the row's verb]   — or Reject · Approve while
 *            it waits for you; a stopped row: Keep paused ▾ · Release · Turn on… · Remove negative…
 *
 * Every verb opens the review ABOVE this modal (`onAsk`); the record is read again after it (`version`). A verb the
 * server holds stays on screen, held, with its reason (Button `heldReason`); so does every verb for a person who may not
 * change ads.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button, Tag, Tooltip } from '@/design-system/primitives'
import { EntityPath, KeyValue, Menu, Sparkline, SummaryTable, useNarrow, type EntityLinkComponent, type MenuItemDef } from '@/design-system/components'
import { DetailModal, type DetailModalProps, type DetailNav } from '@/design-system/patterns'
import Link from '@/lib/workspaces/Link'
import { dayWords, money, relWords, whenWords } from '../../bid/_shared/format'
import { OwnerChip } from '../../_shared/OwnerChip'
import { ClashMark, KindMark, MatchChip, SkippedMark, StateMark, WaitingMark } from './marks'
import { readRow } from './wasteApi'
import {
  chipOwner, deliveryView, historyWord, isAsinText, moneyOr, NOT_KEPT, pathOf, planWords, plural, stoppedVerb, verbLabel, verbSentence, waitingOf, wasteVerb, xCpaText,
  type DetailTab,
} from './wasteModel'
import type { WasteAsk } from './useWasteReview'
import type { HistoryItem, Place, RowDetail as RowDetailAnswer, StoppedRow, WasteAction, WasteItem, WasteRow, Where } from './wasteTypes'
import styles from '../negatives.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const isStopped = (r: WasteRow | StoppedRow): r is StoppedRow => 'actions' in r

export interface RowDetailProps {
  id: string
  /** The row as the table holds it (shown at once, while its record is read). */
  listRow: WasteRow | StoppedRow | null
  market: string | null
  tab: DetailTab
  onTab(tab: DetailTab): void
  nav?: DetailNav
  /** The person may change ads (ads.campaigns.manage); otherwise every verb is held and says why. */
  canWrite: boolean
  /** Bumped after every write: the record is read again. */
  version: number
  onAsk(a: WasteAsk): void
  onClose(): void
  /** Another row's record (a place in Where it runs). */
  onOpen(id: string): void
  ruleHref(ruleId: string): string
  returnFocusTo?: DetailModalProps['returnFocusTo']
}

const NO_WRITE = 'You can see ads here, not change them'

export function RowDetail({ id, listRow, tab, onTab, nav, canWrite, version, onAsk, onClose, onOpen, ruleHref, returnFocusTo }: RowDetailProps) {
  const [detail, setDetail] = useState<{ id: string; answer: RowDetailAnswer } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [again, setAgain] = useState(0)
  useEffect(() => {
    const ctl = new AbortController()
    setReading(true)
    setErr(null)
    readRow(id, ctl.signal)
      .then((answer) => { setDetail({ id, answer }); setReading(false) })
      .catch((e) => { if (!ctl.signal.aborted) { setErr(e instanceof Error ? e.message : String(e)); setReading(false) } })
    return () => ctl.abort()
  }, [id, version, again])

  const answer = detail?.id === id ? detail.answer : null
  // The list's row is today's (the page read it last); the record's row fills in what the list did not load.
  const row: WasteRow | StoppedRow | null = listRow?.id === id ? listRow : answer?.row ?? null
  const owner = row ? chipOwner(row.owner) : null
  const runsIn = answer?.runsIn ?? null
  const blockedIn = answer?.blockedIn ?? null
  const history = answer?.history ?? null
  const held = canWrite ? null : NO_WRITE

  const title: ReactNode = row ? (
    <span className={styles.detailTitle}>
      <KindMark kind={row.kind} match={row.match} />
      <span className={styles.ellipsis}>{row.text}</span>
      {row.kind !== 'TERM' || row.id.startsWith('neg:') ? <MatchChip match={row.match} /> : null}
    </span>
  ) : 'Row'

  const subtitle: ReactNode = row ? (
    <span className={styles.detailPath}>
      <EntityPath items={[{ id: 'market', name: `Amazon ${row.market}` }, ...pathOf(row)]} linkAs={WorkspaceLink} label="Where" />
      {row.product?.href && (
        <>
          <span className={styles.sep} aria-hidden>·</span>
          <Link href={row.product.href} className="nds-entitylink">{row.product.name}</Link>
        </>
      )}
    </span>
  ) : undefined

  const meta: ReactNode = row && owner ? (
    <span className={styles.marks}>
      <StateMark row={row} focusable />
      {!isStopped(row) && row.clash && <ClashMark clash={row.clash} focusable />}
      {!isStopped(row) && row.waiting && <WaitingMark waiting={row.waiting} />}
      {!isStopped(row) && row.skipped && <SkippedMark skipped={row.skipped} />}
      <OwnerChip kind={owner.kind} label={owner.label} hint={owner.hint} locked={owner.locked} href={owner.ruleId ? ruleHref(owner.ruleId) : null} />
    </span>
  ) : undefined

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'where', label: 'Where it runs', count: runsIn && blockedIn ? runsIn.length + blockedIn.length : null },
    { id: 'history', label: 'History', count: history ? history.length : null },
  ]

  return (
    <DetailModal
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      meta={meta}
      tabs={tabs}
      activeTab={tab}
      onTabChange={(t) => onTab(t as DetailTab)}
      tabsLabel="Row"
      nav={nav}
      loading={!row && reading}
      error={!row && err ? err : undefined}
      onRetry={() => setAgain((n) => n + 1)}
      returnFocusTo={returnFocusTo}
      footer={row ? <Footer row={row} held={held} onAsk={onAsk} /> : undefined}
    >
      {row && tab === 'overview' && <Overview row={row} ruleHref={ruleHref} onWhere={() => onTab('where')} onOpen={onOpen} />}
      {row && tab === 'where' && (
        err && !answer ? <p className={styles.quiet}>Not read: {err} <Button size="xs" variant="link" onClick={() => setAgain((n) => n + 1)}>Try again</Button></p>
          : !answer ? <p className={styles.quiet}>Reading…</p>
            : <WhereTab current={id} currency={row.currency} runsIn={answer.runsIn} blockedIn={answer.blockedIn} onOpen={onOpen} held={held} onAsk={onAsk} />
      )}
      {row && tab === 'history' && (
        err && !answer ? <p className={styles.quiet}>Not read: {err} <Button size="xs" variant="link" onClick={() => setAgain((n) => n + 1)}>Try again</Button></p>
          : !answer ? <p className={styles.quiet}>Reading…</p>
            : <HistoryTab items={answer.history} canWrite={canWrite} onUndo={(item) => onAsk({ kind: 'undo', item })} />
      )}
    </DetailModal>
  )
}

/* ── the footer: the row's verbs ─────────────────────────────────────────────────────────────────────────────────── */

const change = (rowId: string, action: WasteAction, where?: Where | null, keepUntil?: string | null, text?: string): WasteAsk => ({
  kind: 'change', items: [{ rowId, action, ...(where ? { where } : {}), ...(keepUntil !== undefined ? { keepUntil } : {}) } as WasteItem],
  ...(text ? { texts: { [rowId]: text } } : {}),
})
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
/** A kept-paused keyword's new end (KEEP_UNTIL, with its old end for the review and the Undo); a plain paused one is
 *  paused AND kept paused with that end. */
const keepAsk = (row: StoppedRow, until: string | null): WasteAsk => ({
  kind: 'change', items: [{ rowId: row.id, action: 'KEEP_UNTIL', keepUntil: until }],
  keepFrom: { [row.id]: row.state === 'KEPT_PAUSED' ? row.keptPaused?.until ?? 'ALWAYS' : NOT_KEPT },
})
const askRow = (row: WasteRow) => ({ id: row.id, text: row.text, place: pathOf(row) })

function Footer({ row, held, onAsk }: { row: WasteRow | StoppedRow; held: string | null; onAsk(a: WasteAsk): void }) {
  const menu = (label: string, items: MenuItemDef[], aria: string) => (
    held
      ? <Button size="sm" heldReason={held}>{label}</Button>
      : <Menu label={<span className={styles.inline}>{label}<ChevronDown size={14} aria-hidden /></span>} items={items} align="left" triggerProps={{ className: 'nds-btn sm', 'aria-label': aria }} />
  )
  const verb = (action: WasteAction, where: Where | null, reason: string | null, primary: boolean, label?: string, targetRowId?: string | null) => (
    <Button size="sm" variant={primary ? 'primary' : 'secondary'} heldReason={held ?? reason} aria-label={verbSentence(action, where)}
      onClick={() => onAsk(targetRowId ? { kind: 'change', items: [{ rowId: row.id, action, targetRowId }], texts: { [row.id]: row.text } } : change(row.id, action, where, undefined, row.text))}>
      {label ?? verbLabel(action, where)}
    </Button>
  )

  if (isStopped(row)) {
    const v = stoppedVerb(row)
    const keep = (row.state === 'KEPT_PAUSED' || row.state === 'PAUSED') && row.id.startsWith('kw:')
    return (
      <div className={styles.footer}>
        {keep && menu(row.state === 'KEPT_PAUSED' ? 'Keep until' : 'Keep paused', [
          // An end at most 30 d ahead, or Always.
          { id: '7', label: '7 d', onSelect: () => onAsk(keepAsk(row, inDays(7))) },
          { id: '30', label: '30 d', onSelect: () => onAsk(keepAsk(row, inDays(30))) },
          { id: 'always', label: 'Always', onSelect: () => onAsk(keepAsk(row, null)) },
        ], 'Keep paused until')}
        <span className="grow" />
        {row.state === 'KEPT_PAUSED' && verb('RELEASE', null, row.actions.release.allowed ? null : row.actions.release.why, false)}
        {row.state === 'TURNED_ON_ELSEWHERE' && verb('PAUSE', null, null, true, 'Pause again')}
        {/* The Owner's job on a stopped row is to keep it stopped: Turn on and Remove are never the blue fill (audit S8). */}
        {verb(v.action, null, v.held, false, v.action === 'RELEASE' ? 'Release lock' : `${verbLabel(v.action)}…`)}
      </div>
    )
  }

  // Waiting for you: decided here (never on another page).
  if (row.waiting) {
    const [w] = waitingOf([row])
    return (
      <div className={styles.footer}>
        <span className="grow" />
        <Button size="sm" heldReason={held} onClick={() => onAsk({ kind: 'decide', decide: 'reject', waits: [w] })}>Reject</Button>
        <Button size="sm" variant="primary" heldReason={held} onClick={() => onAsk({ kind: 'decide', decide: 'approve', waits: [w] })}>Approve</Button>
      </div>
    )
  }

  // A keyword turned on outside Nexus is not skipped: it spends again (audit S9).
  const skip = row.state === 'TURNED_ON_ELSEWHERE' ? null : row.skipped
    ? <Button size="sm" heldReason={held} onClick={() => onAsk({ kind: 'unskip', rows: [askRow(row)] })}>Unskip</Button>
    : menu('Skip', [
      { id: '7', label: '7 d', onSelect: () => onAsk({ kind: 'skip', rows: [askRow(row)], days: 7 }) },
      { id: '30', label: '30 d', onSelect: () => onAsk({ kind: 'skip', rows: [askRow(row)], days: 30 }) },
    ], 'Skip for')
  const v = wasteVerb(row)
  if (!v) {
    // Not running (paused, kept paused, a negative): the Stopped view's verbs.
    return (
      <div className={styles.footer}>
        <span className="grow" />
        {row.kind !== 'TERM' && (row.state === 'PAUSED' || row.state === 'KEPT_PAUSED') && verb('TURN_ON', null, null, false, 'Turn on…')}
      </div>
    )
  }
  // A wasting keyword with a negative over it: Pause is its verb, Remove negative… the second action (audit N1).
  if (v.second) {
    return (
      <div className={styles.footer}>
        {skip}
        <span className="grow" />
        {verb(v.second.action, null, v.second.held, false, v.second.label, v.second.targetRowId)}
        {verb(v.action, null, v.held, v.primary, v.label)}
      </div>
    )
  }
  // A clash: the fix is to remove the negative that blocks our keyword (it acts on that negative's row).
  if (v.action === 'REMOVE_NEGATIVE') {
    return (
      <div className={styles.footer}>
        {skip}
        <span className="grow" />
        {verb('REMOVE_NEGATIVE', null, v.held, false, v.label, v.targetRowId)}
      </div>
    )
  }
  const others: Array<{ action: WasteAction; where: Where }> = row.kind === 'TERM' && !isAsinText(row.text) && row.match !== 'ASIN'
    ? ([['NEGATE_EXACT', 'adGroup'], ['NEGATE_PHRASE', 'adGroup'], ['NEGATE_EXACT', 'campaign'], ['NEGATE_PHRASE', 'campaign']] as const)
      .map(([action, where]) => ({ action, where }))
      .filter((o) => !(o.action === v.action && o.where === v.where))
    : []
  return (
    <div className={styles.footer}>
      {skip}
      <span className="grow" />
      {others.length > 0 && (v.held || held
        ? <Button size="sm" heldReason={held ?? v.held}>Other</Button>
        : <Menu label={<span className={styles.inline}>Other<ChevronDown size={14} aria-hidden /></span>} align="right" triggerProps={{ className: 'nds-btn sm', 'aria-label': 'Other negatives' }}
            items={others.map((o) => ({ id: `${o.action}:${o.where}`, label: verbLabel(o.action, o.where), title: verbSentence(o.action, o.where), onSelect: () => onAsk(change(row.id, o.action, o.where, undefined, row.text)) }))} />)}
      {verb(v.action, v.where, v.held, v.primary, v.label)}
    </div>
  )
}

/* ── Overview ────────────────────────────────────────────────────────────────────────────────────────────────────── */

function Overview({ row, ruleHref, onWhere, onOpen }: { row: WasteRow | StoppedRow; ruleHref(id: string): string; onWhere(): void; onOpen(id: string): void }) {
  const cols = useNarrow() ? 2 : 3
  if (isStopped(row)) {
    const items = [
      { label: 'Since', value: row.since ? `${dayWords(row.since)} · ${relWords(row.since)}` : '—', hint: row.sinceWhy ?? undefined },
      ...(row.keptPaused ? [
        { label: 'Kept by', value: row.keptPaused.by.name },
        { label: 'Until', value: row.keptPaused.until ? dayWords(row.keptPaused.until) : 'Always' },
        ...(row.keptPaused.reason ? [{ label: 'Why', value: row.keptPaused.reason }] : []),
      ] : []),
      { label: 'Spend before', value: moneyOr(row.spendBeforeCents, row.currency), hint: '30 d before it stopped' },
      ...(row.level ? [{ label: 'Level', value: row.level === 'CAMPAIGN' ? 'Whole campaign' : 'Ad group' }] : []),
      ...(row.places > 1 ? [{ label: 'Same negative', value: plural(row.places, 'place') }] : []),
      { label: 'Still spends in', value: row.stillServesIn ? <Button size="xs" variant="link" onClick={onWhere}>{plural(row.stillServesIn, 'ad group')}</Button> : '—' },
    ]
    return <KeyValue items={items} columns={cols} />
  }
  const d = row.d
  const t = row.test
  const by = t.by ? (t.by.href ? <Link href={t.by.href} className="nds-entitylink">{t.by.name}</Link> : <span>{t.by.name}</span>) : <span>the page&apos;s default</span>
  const neg = row.clash?.negative ?? null
  const negOwner = neg ? chipOwner(neg.owner) : null
  const bar = [
    `${plural(t.clicksNeeded, 'click')}`,
    typeof t.spendBarCents === 'number' ? `${money(t.spendBarCents, row.currency)}${t.xCpaBar ? ` (${xCpaText(t.xCpaBar)})` : ''}` : null,
    '0 orders',
    `${t.windowDays} d`,
  ].filter(Boolean).join(' · ')
  return (
    <div className={styles.overview}>
      <div className={styles.numbers}>
        <KeyValue columns={cols} items={[
          { label: `Spend · ${t.windowDays} d`, value: d ? moneyOr(d.spendCents, row.currency) : '—', hint: row.stockOutDays ? `${plural(row.stockOutDays, 'day')} out of stock left out` : undefined },
          { label: 'Clicks', value: d ? d.clicks.toLocaleString('en-IE') : '—' },
          { label: 'Orders', value: d ? d.orders.toLocaleString('en-IE') : '—', hint: 'to today' },
          { label: '×CPA', value: xCpaText(d?.xCpa) },
          { label: 'CPC', value: moneyOr(d?.cpcCents, row.currency) },
          { label: '90 d', value: row.d90 ? `${moneyOr(row.d90.spendCents, row.currency)} · ${plural(row.d90.orders, 'order')}` : '—' },
        ]} />
        {row.spark && row.spark.length > 0 && (
          <span className={styles.spark}>
            <Sparkline values={row.spark} label="Spend per week, 8 weeks" format={(n) => money(n, row.currency)} width={160} />
          </span>
        )}
      </div>
      <KeyValue columns={2} items={[
        {
          label: 'Test',
          value: (
            <span className={styles.inline}>
              {/* No numbers held for it (a keyword switched on outside Nexus): "No data", never "Not wasting" (audit S9). */}
              <Tooltip label={d ? t.sentence : 'Amazon reported nothing for it in the window'} portal>
                <span tabIndex={0}><Tag tone={!d ? 'neutral' : t.met ? 'danger' : 'neutral'}>{!d ? 'No data' : t.met ? 'Wastes' : 'Not wasting'}</Tag></span>
              </Tooltip>
              <span>{bar}</span>
            </span>
          ),
          hint: <span className={styles.inline}>by {by}</span>,
        },
        ...(row.clash ? [{
          label: 'Clash',
          value: neg && negOwner ? (
            <span className={styles.inline}>
              <Button size="xs" variant="link" onClick={() => onOpen(neg.rowId)} aria-label={`Open the negative ${neg.text}`}>{neg.text}</Button>
              <MatchChip match={neg.match} />
              <EntityPath items={[neg.campaign, neg.level === 'CAMPAIGN' ? null : neg.adGroup]} linkAs={WorkspaceLink} label="Where the negative is" />
              {neg.level === 'CAMPAIGN' && <span className={styles.quietInline}>whole campaign</span>}
              <OwnerChip kind={negOwner.kind} label={negOwner.label} hint={negOwner.hint} locked={negOwner.locked} />
            </span>
          ) : row.clash.label,
          hint: neg ? row.clash.label : undefined,
        }] : []),
        ...(row.via ? [{ label: 'Bought by', value: row.via.href ? <Link href={row.via.href} className="nds-entitylink">{row.via.name}</Link> : row.via.name }] : []),
        ...(row.stillServesIn ? [{ label: 'Still spends in', value: <Button size="xs" variant="link" onClick={onWhere}>{plural(row.stillServesIn, 'other ad group')}</Button> }] : []),
        ...(row.waiting ? [{
          label: 'Waiting',
          value: `${row.waiting.by.name} · ${relWords(row.waiting.at)}${(row.waiting.rows ?? 1) > 1 ? ` · ${row.waiting.rows} places` : ''}`,
          hint: [row.waiting.expiresAt ? `expires ${relWords(row.waiting.expiresAt)}` : null].filter(Boolean).join(' · ') || undefined,
        }] : []),
        // NFIX — an ask that is a change plan says so before Approve: its steps run (or are dropped) together.
        ...(row.waiting?.plan ? [{ label: 'Part of', value: planWords(row.waiting.plan)!, hint: 'Approved or rejected together: Approve lists every step first' }] : []),
        ...(row.skipped ? [{ label: 'Skipped', value: `to ${dayWords(row.skipped.until)}` }] : []),
        ...(row.lastChange ? [{ label: 'Last change', value: `${row.lastChange.action} · ${relWords(row.lastChange.at)}`, hint: row.lastChange.by.name }] : []),
        ...(row.owner.kind === 'RULE' && row.owner.id ? [{ label: 'Rule', value: <Link href={ruleHref(row.owner.id)} className="nds-entitylink">{row.owner.name}</Link> }] : []),
      ]} />
    </div>
  )
}

/* ── Where it runs ───────────────────────────────────────────────────────────────────────────────────────────────── */

function PlaceTable({ label, places, current, currency, onOpen, fix }: { label: string; places: Place[]; current: string; currency: string; onOpen(id: string): void; fix?: { held: string | null; onAsk(a: WasteAsk): void } }) {
  if (!places.length) return <p className={styles.quiet}>None</p>
  return (
    <ul className={styles.places} aria-label={label}>
      {places.map((p, i) => {
        const o = chipOwner(p.owner)
        return (
          <li key={`${i}:${p.rowId ?? p.campaign.id}`} className={styles.place}>
            <span className={styles.placePath}><EntityPath items={[p.portfolio, p.campaign, p.adGroup]} linkAs={WorkspaceLink} label="Where" /></span>
            <span className={styles.marks}>
              <MatchChip match={p.match} />
              <StateMark row={{ state: p.state, match: p.match, level: p.adGroup ? 'AD_GROUP' : 'CAMPAIGN' }} />
              <OwnerChip kind={o.kind} label={o.label} hint={o.hint} locked={o.locked} />
            </span>
            <span className={styles.placeNum} title="Spend · orders in the window">{p.d ? `${moneyOr(p.d.spendCents, currency)} · ${plural(p.d.orders, 'order')}` : '—'}</span>
            <span className={styles.placeOpen}>
              {/* Still bought here: one click adds the negative exact in this ad group (audit S17); the review says what. */}
              {fix && p.rowId?.startsWith('term:') && p.rowId !== current && p.state === 'RUNNING' && (
                <Button size="xs" heldReason={fix.held} aria-label={`Negative exact in ${p.adGroup?.name ?? 'this ad group'}`}
                  onClick={() => fix.onAsk({ kind: 'change', items: [{ rowId: p.rowId!, action: 'NEGATE_EXACT', where: 'adGroup' }] })}>Negative exact</Button>
              )}
              {p.rowId && p.rowId !== current ? <Button size="xs" variant="link" onClick={() => onOpen(p.rowId!)}>Open</Button> : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function WhereTab({ current, currency, runsIn, blockedIn, onOpen, held, onAsk }: { current: string; currency: string; runsIn: Place[]; blockedIn: Place[]; onOpen(id: string): void; held: string | null; onAsk(a: WasteAsk): void }) {
  return (
    <div className={styles.whereTab}>
      <section aria-label="Runs in">
        <h3 className={styles.h3}>Runs in <span className={styles.count}>{runsIn.length}</span></h3>
        <PlaceTable label="Runs in" places={runsIn} current={current} currency={currency} onOpen={onOpen} fix={{ held, onAsk }} />
      </section>
      <section aria-label="Blocked in">
        <h3 className={styles.h3}>Blocked in <span className={styles.count}>{blockedIn.length}</span></h3>
        <PlaceTable label="Blocked in" places={blockedIn} current={current} currency={currency} onOpen={onOpen} />
      </section>
    </div>
  )
}

/* ── History ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

function HistoryTab({ items, canWrite, onUndo }: { items: HistoryItem[]; canWrite: boolean; onUndo(item: HistoryItem): void }) {
  if (!items.length) return <p className={styles.quiet}>No changes in 90 d</p>
  return (
    <SummaryTable
      label="History"
      columns={['When', 'What', 'Who', 'Status', '']}
      rows={items.map((it, i) => {
        const dv = deliveryView(it.delivery)
        const why = it.why ? <Tooltip label={it.why} portal><span tabIndex={0} className={styles.why}>{historyWord(it.action)}</span></Tooltip> : historyWord(it.action)
        return {
          id: `${i}:${it.changeId ?? it.at}`,
          cells: [
            <span key="w" title={whenWords(it.at)}>{relWords(it.at)}</span>,
            <span key="a" className={styles.inline}>{why}<span className={styles.quietInline}>{it.text}</span></span>,
            it.by.href ? <Link key="b" href={it.by.href} className="nds-entitylink">{it.by.name}</Link> : it.by.name,
            <Tag key="d" tone={dv.tone}>{dv.word}</Tag>,
            it.undo.available
              ? <Button key="u" size="xs" heldReason={canWrite ? null : NO_WRITE} onClick={() => onUndo(it)}>Undo</Button>
              : <Tooltip key="u" label={it.undo.why} portal><span tabIndex={0} className={styles.cant}>Can&apos;t undo</span></Tooltip>,
          ],
        }
      })}
    />
  )
}
