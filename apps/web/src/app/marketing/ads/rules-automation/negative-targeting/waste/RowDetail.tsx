'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW; redone 2026-10-26, RECORD-SPEC R1–R15) — one row's record: the DS
 * `DetailModal` (centred, header and tabs fixed, the body scrolls; a full-screen sheet on a phone), its address
 * `?row=<id>&tab=overview|where|history`.
 *
 *   header   kind mark · words                                                     ▲ 3 of 14 ▼ (K / J)   ✕
 *            "<kind> in <campaign › ad group> · Amazon IT"   the state pill · "Looked after by …"
 *   tabs     Overview · Where it runs N · History N
 *   overview the banner (the answer in one look) · four tiles · the cards that say why (the page's test as three checks;
 *            what protects it; what Approve does; how the saving is counted) — and on the right "About this …" and the
 *            spend per week
 *   where    Spends here · Blocked here, two tables; the row of this record says so
 *   history  the DS Timeline: who did what, why under it, Undo only where the server can undo it
 *   footer   secondary menus (Skip ▾, Keep until ▾) · the quiet line · secondary buttons · ONE primary that says what it
 *            does ("Add negative exact"); while it waits for you Reject · Approve; a stopped row stays all-secondary
 *
 * Every verb opens the review ABOVE this modal (`onAsk`); the record is read again after it (`version`). A verb the
 * server holds stays on screen, held, with its reason (Button `heldReason`); so does every verb for a person who may not
 * change ads. Words and rules: `recordModel.ts`; a protected row's: `protectionModel.ts`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Ban, ChevronDown, CloudOff, Hourglass, Pause, Play, ShieldCheck, TriangleAlert } from 'lucide-react'
import { usePermission } from '@/lib/auth/AuthProvider'
import { Button, Pill, Tag } from '@/design-system/primitives'
import {
  Banner, Card, EmptyState, EntityPath, KeyValue, Menu, MetricStrip, RecordLayout, Sparkline, SummaryTable, Timeline, useNarrow,
  type EntityLinkComponent, type KeyValueItem, type MenuItemDef,
} from '@/design-system/components'
import { DetailModal, type DetailModalProps, type DetailNav } from '@/design-system/patterns'
import Link from '@/lib/workspaces/Link'
import { dayWords, money, relWords } from '../../bid/_shared/format'
import { KindMark } from './marks'
import { readRow } from './wasteApi'
import {
  isAsinText, matchWord, moneyOr, NO_WRITE, NOT_KEPT, pathOf, plural, productWords, sinceView, stoppedVerb, verbLabel, verbSentence, waitingOf,
  wasteVerb, type DetailTab,
} from './wasteModel'
import type { WasteAsk } from './useWasteReview'
import { KEEP_PROTECTED_DAYS, KEEP_PROTECTED_HINT, protectsView, removeProtectionHeld, removeProtectionItems, UNPROTECT_PERMISSIONS } from './protectionModel'
import {
  addedByWords, approveView, askedWords, historyIntro, historyStep, isStoppedRow, keepUntilWords, kindLead, lastChangeWords, lookedAfter,
  negativeWords, otherNegativeWords, ownerWords, placePill, recordNoun, REVIEW_FIRST, savingSum, skipWords, sparkWords, statePill,
  stillSpendsPlaces, stoppedBanner, stoppedMetrics, verbPhrase, wasteBanner, wasteChecks, wasteMetrics, whereWords,
  type BannerView, type MetricView, type PillGlyph, type StatePillView,
} from './recordModel'
import type { HistoryItem, Place, Ref, RowDetail as RowDetailAnswer, StoppedRow, WasteAction, WasteItem, WasteRow, Where } from './wasteTypes'
import s from './record.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent

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
  const runsIn = answer?.runsIn ?? null
  const blockedIn = answer?.blockedIn ?? null
  const history = answer?.history ?? null
  const held = canWrite ? null : NO_WRITE
  const retry = () => setAgain((n) => n + 1)

  const title: ReactNode = row ? (
    <span className={s.title}>
      <KindMark kind={row.kind} match={row.match} />
      <span className={s.ellipsis}>{row.text}</span>
    </span>
  ) : 'Row'

  const subtitle: ReactNode = row ? (
    <span className={s.subtitle}>
      <span className={s.lead}>{kindLead(row)} in</span>
      <EntityPath items={[row.campaign, row.adGroup]} linkAs={WorkspaceLink} label="Where" />
      {!row.adGroup && <span className={s.lead}>whole campaign</span>}
      <span className={s.sep} aria-hidden>·</span>
      <span>{`Amazon ${row.market}`}</span>
    </span>
  ) : undefined

  const tag = row ? lookedAfter(row.owner) : null
  const meta: ReactNode = row ? (
    <span className={s.meta}>
      <RecordPill view={statePill(row)} />
      {tag && <Tag tone="neutral" title={tag.title} truncate>{tag.label}</Tag>}
    </span>
  ) : undefined

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'where', label: 'Where it runs', count: runsIn && blockedIn ? runsIn.length + blockedIn.length : null },
    { id: 'history', label: 'History', count: history ? history.length : null },
  ]

  const notRead = <p className={s.quiet}>Not read: {err} <Button size="xs" variant="link" onClick={retry}>Try again</Button></p>
  const reading_ = <p className={s.quiet}>Reading…</p>

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
      onRetry={retry}
      returnFocusTo={returnFocusTo}
      footer={row ? <Footer row={row} held={held} onAsk={onAsk} /> : undefined}
    >
      {row && tab === 'overview' && (isStoppedRow(row)
        ? <StoppedOverview row={row} runsIn={runsIn} onWhere={() => onTab('where')} />
        : <WasteOverview row={row} blockedIn={blockedIn} ruleHref={ruleHref} onWhere={() => onTab('where')} onOpen={onOpen} />)}
      {row && tab === 'where' && (
        err && !answer ? notRead : !answer ? reading_
          : <WhereTab row={row} runsIn={answer.runsIn} blockedIn={answer.blockedIn} onOpen={onOpen} held={held} onAsk={onAsk} />
      )}
      {row && tab === 'history' && (
        err && !answer ? notRead : !answer ? reading_
          : <HistoryTab items={answer.history} canWrite={canWrite} noun={recordNoun(row)} onUndo={(item) => onAsk({ kind: 'undo', item })} />
      )}
    </DetailModal>
  )
}

/* ── shared parts (WordDetail uses them too) ─────────────────────────────────────────────────────────────────────── */

const GLYPH = { size: 12, strokeWidth: 2.25, 'aria-hidden': true as const, className: 'nds-cell-glyph' }
const glyphOf = (g: PillGlyph): ReactNode => {
  switch (g) {
    case 'play': return <Play {...GLYPH} />
    case 'pause': return <Pause {...GLYPH} />
    case 'kept': return <Pause {...GLYPH} />
    case 'ban': return <Ban {...GLYPH} />
    case 'shield': return <ShieldCheck {...GLYPH} />
    case 'alert': return <TriangleAlert {...GLYPH} />
    case 'cloud': return <CloudOff {...GLYPH} />
    case 'hourglass': return <Hourglass {...GLYPH} />
    default: return null
  }
}

/** The record's state pill: the state word in its tone; its sentence after it for a screen reader and on hover. */
export function RecordPill({ view }: { view: StatePillView }) {
  const icon = glyphOf(view.glyph)
  const body = <>{view.word}<span className="nds-vh">: {view.sentence}</span></>
  return icon
    ? <Pill tone={view.tone} icon={icon} truncate title={`${view.word}: ${view.sentence}`}>{body}</Pill>
    : <Pill tone={view.tone} truncate title={`${view.word}: ${view.sentence}`}>{body}</Pill>
}

const BANNER_ICON: Partial<Record<string, ReactNode>> = {
  shield: <ShieldCheck size={18} aria-hidden />,
  hourglass: <Hourglass size={18} aria-hidden />,
}

/** The banner: the answer in one look (its tone, one sentence, what it means and what the main button does). */
export function RecordBanner({ view, icon }: { view: BannerView; icon?: 'shield' | 'hourglass' }) {
  return <Banner tone={view.tone} title={view.title} icon={icon ? BANNER_ICON[icon] : undefined}>{view.desc ?? undefined}</Banner>
}

/** Four tiles, each with its plain line; a bad value in the danger colour. */
export function RecordMetrics({ metrics }: { metrics: readonly MetricView[] }) {
  return (
    <MetricStrip metrics={metrics.map((m) => ({
      label: m.label,
      value: m.tone ? <span className={s[m.tone]}>{m.value}</span> : m.value,
      hint: m.hint,
    }))} />
  )
}

/** The footer's quiet line. */
export const FooterNote = () => <span className={s.footerNote}>{REVIEW_FIRST}</span>
/** A footer button's place: side by side on a phone; the primary across the width. */
export const Slot = ({ primary, children }: { primary?: boolean; children: ReactNode }) => <span className={`${s.slot}${primary ? ` ${s.slotPrimary}` : ''}`}>{children}</span>

/** A record's History tab: the DS Timeline, newest first (the Wasting and Stopped rows, and a word's negatives). */
export function HistoryTab({ items, canWrite, onUndo, noun = 'term', empty }: { items: HistoryItem[]; canWrite: boolean; onUndo(item: HistoryItem): void; noun?: string; empty?: string }) {
  if (!items.length) {
    return <EmptyState title="No changes in the last 90 days" description={empty ?? `Every change to this ${noun} shows here, newest first.`} />
  }
  return (
    <div className={s.col}>
      <p className={s.intro}>{historyIntro(noun, true)}</p>
      <Card padded>
        <Timeline
          label="History"
          steps={items.map((it, i) => {
            const v = historyStep(it, i)
            return {
              key: v.key,
              label: v.label,
              tone: v.tone,
              at: it.at,
              detail: v.detail ?? undefined,
              action: v.undo ? <Button size="xs" heldReason={canWrite ? null : NO_WRITE} aria-label={v.undoLabel} onClick={() => onUndo(it)}>Undo</Button> : undefined,
            }
          })}
        />
      </Card>
    </div>
  )
}

/** A card's title with its count ("Spends here 1"). */
export const Counted = ({ label, n }: { label: string; n: number }) => <>{label} <span className="nds-tab-count">{n}</span></>

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
  const menu = (label: string, items: MenuItemDef[], aria: string, align: 'left' | 'right' = 'left') => (
    <Slot>
      {held
        ? <Button size="sm" heldReason={held}>{label}</Button>
        : <Menu label={<span className={s.inline}>{label}<ChevronDown size={14} aria-hidden /></span>} items={items} align={align} triggerProps={{ className: 'nds-btn sm', 'aria-label': aria }} />}
    </Slot>
  )
  const adGroup = row.adGroup?.name ?? null
  const verb = (action: WasteAction, where: Where | null, reason: string | null, primary: boolean, label?: string, targetRowId?: string | null) => {
    const words = verbPhrase(action, where, adGroup, label)
    return (
      <Slot primary={primary}>
        <Button size="sm" variant={primary ? 'primary' : 'secondary'} heldReason={held ?? reason} aria-label={action.startsWith('NEGATE') ? words.sentence : verbSentence(action, where)}
          onClick={() => onAsk(targetRowId ? { kind: 'change', items: [{ rowId: row.id, action, targetRowId }], texts: { [row.id]: row.text } } : change(row.id, action, where, undefined, row.text))}>
          {words.label}
        </Button>
      </Slot>
    )
  }

  if (isStoppedRow(row)) {
    const v = stoppedVerb(row)
    const keep = (row.state === 'KEPT_PAUSED' || row.state === 'PAUSED') && row.id.startsWith('kw:')
    return (
      <div className={s.footer}>
        {keep && menu(row.state === 'KEPT_PAUSED' ? 'Keep until' : 'Keep paused', [
          // An end at most 30 d ahead, or Always.
          { id: '7', label: keepUntilWords(7), onSelect: () => onAsk(keepAsk(row, inDays(7))) },
          { id: '30', label: keepUntilWords(30), onSelect: () => onAsk(keepAsk(row, inDays(30))) },
          { id: 'always', label: keepUntilWords(null), onSelect: () => onAsk(keepAsk(row, null)) },
        ], 'Keep paused until')}
        <FooterNote />
        <span className={s.grow} />
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
      <div className={s.footer}>
        <FooterNote />
        <span className={s.grow} />
        <Slot><Button size="sm" heldReason={held} onClick={() => onAsk({ kind: 'decide', decide: 'reject', waits: [w] })}>Reject</Button></Slot>
        <Slot primary><Button size="sm" variant="primary" heldReason={held} onClick={() => onAsk({ kind: 'decide', decide: 'approve', waits: [w] })}>Approve</Button></Slot>
      </div>
    )
  }

  // Step 4 — a protected row: Keep protected, or Remove protection and stop.
  if (row.state === 'PROTECTED' && row.protection?.terms.length) return <ProtectedFooter row={row} held={held} onAsk={onAsk} />

  // A keyword turned on outside Nexus is not skipped: it spends again (audit S9).
  const skip = row.state === 'TURNED_ON_ELSEWHERE' ? null : row.skipped
    ? <Slot><Button size="sm" heldReason={held} onClick={() => onAsk({ kind: 'unskip', rows: [askRow(row)] })}>Unskip</Button></Slot>
    : menu('Skip', [
      { id: '7', label: skipWords(7), onSelect: () => onAsk({ kind: 'skip', rows: [askRow(row)], days: 7 }) },
      { id: '30', label: skipWords(30), onSelect: () => onAsk({ kind: 'skip', rows: [askRow(row)], days: 30 }) },
    ], 'Skip for')
  const v = wasteVerb(row)
  if (!v) {
    // Not running (paused, kept paused, a negative): the Stopped view's verbs.
    return (
      <div className={s.footer}>
        <FooterNote />
        <span className={s.grow} />
        {row.kind !== 'TERM' && (row.state === 'PAUSED' || row.state === 'KEPT_PAUSED') && verb('TURN_ON', null, null, false, 'Turn on…')}
      </div>
    )
  }
  // A wasting keyword with a negative over it: Pause is its verb, Remove negative… the second action (audit N1).
  if (v.second) {
    return (
      <div className={s.footer}>
        {skip}
        <FooterNote />
        <span className={s.grow} />
        {verb(v.second.action, null, v.second.held, false, v.second.label, v.second.targetRowId)}
        {verb(v.action, null, v.held, v.primary, v.label)}
      </div>
    )
  }
  // A clash: the fix is to remove the negative that blocks our keyword (it acts on that negative's row).
  if (v.action === 'REMOVE_NEGATIVE') {
    return (
      <div className={s.footer}>
        {skip}
        <FooterNote />
        <span className={s.grow} />
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
    <div className={s.footer}>
      {skip}
      <FooterNote />
      <span className={s.grow} />
      {others.length > 0 && (v.held || held
        ? <Slot><Button size="sm" heldReason={held ?? v.held}>Other negatives</Button></Slot>
        : menu('Other negatives', others.map((o) => ({
          id: `${o.action}:${o.where}`, label: otherNegativeWords(o.action, o.where, adGroup), title: verbSentence(o.action, o.where),
          onSelect: () => onAsk(change(row.id, o.action, o.where, undefined, row.text)),
        })), 'Other negatives', 'right'))}
      {verb(v.action, v.where, v.held, v.primary, v.action === 'PAUSE' ? v.label : undefined)}
    </div>
  )
}

/**
 * Step 4 — a protected row's two actions: Keep protected (the Skip for 30 d: it stays protected, out of view; Unskip once
 * kept) and Remove protection and stop… (the removal of each protected term that holds it, then its own verb, ONE review).
 */
function ProtectedFooter({ row, held, onAsk }: { row: WasteRow; held: string | null; onAsk(a: WasteAsk): void }) {
  // The removal's tool (Claude's guardrail tool) asks these on top of changing ads here: the same permissions as today.
  const [automation, bids, budgets, spend] = [usePermission(UNPROTECT_PERMISSIONS[0]), usePermission(UNPROTECT_PERMISSIONS[1]), usePermission(UNPROTECT_PERMISSIONS[2]), usePermission(UNPROTECT_PERMISSIONS[3])]
  const removeHeld = removeProtectionHeld(row, { write: !held, unprotect: automation && bids && budgets && spend })
  return (
    <div className={s.footer}>
      <FooterNote />
      <span className={s.grow} />
      <Slot>
        {row.skipped
          ? <Button size="sm" heldReason={held} onClick={() => onAsk({ kind: 'unskip', rows: [askRow(row)] })}>Unskip</Button>
          : <Button size="sm" heldReason={held} title={KEEP_PROTECTED_HINT} aria-label="Keep protected: hide it for 30 days, the protection stays"
              onClick={() => onAsk({ kind: 'skip', keep: 'protected', days: KEEP_PROTECTED_DAYS, rows: [askRow(row)] })}>Keep protected</Button>}
      </Slot>
      <Slot primary={row.test.met && !removeHeld}>
        <Button size="sm" variant={row.test.met && !removeHeld ? 'primary' : 'secondary'} heldReason={removeHeld}
          aria-label={`Remove the protection and ${row.verb.action === 'PAUSE' ? 'pause it' : 'add the negative'}: one review, the protection first`}
          onClick={() => onAsk({ kind: 'change', items: removeProtectionItems(row), texts: { [row.id]: row.text } })}>Remove protection and stop…</Button>
      </Slot>
    </div>
  )
}

/* ── Overview: a Wasting-view row ────────────────────────────────────────────────────────────────────────────────── */

const linkTo = (ref: Ref | null | undefined, fallback: string): ReactNode => (ref?.href ? <Link href={ref.href} className="nds-entitylink">{ref.name}</Link> : ref?.name ?? fallback)

function WasteOverview({ row, blockedIn, ruleHref, onWhere, onOpen }: { row: WasteRow; blockedIn: Place[] | null; ruleHref(id: string): string; onWhere(): void; onOpen(id: string): void }) {
  const narrow = useNarrow()
  const v = wasteVerb(row)
  const banner = wasteBanner(row, v ? { action: v.action, where: v.where, held: v.held } : null)
  const checks = wasteChecks(row)
  const protects = row.state === 'PROTECTED' ? protectsView(row) : null
  const approve = approveView(row)
  const trend = row.spark && row.spark.length ? sparkWords(row.spark, row.currency) : null
  const noun = recordNoun(row)
  const neg = row.clash?.negative ?? null

  const about: KeyValueItem[] = row.waiting ? [
    { label: 'Asked by', value: row.waiting.by.name },
    { label: 'Asked', value: askedWords(row.waiting.at).value, hint: askedWords(row.waiting.at).hint },
    ...(row.waiting.expiresAt ? [{ label: 'Expires', value: relWords(row.waiting.expiresAt) }] : []),
    { label: 'Product', value: row.product ? linkTo(row.product, '—') : productWords(row) },
    ...((row.waiting.rows ?? 1) > 1 ? [{ label: 'Also asked in', value: plural((row.waiting.rows ?? 1) - 1, 'other place'), hint: 'One answer decides every place' }] : []),
    ...(row.lastChange ? [{ label: 'Last change', ...lastChangeWords(row.lastChange, row.kind)! }] : []),
  ] : [
    // A clash: the negative that blocks our own keyword (it opens its record).
    ...(neg ? [{
      label: 'Blocked by',
      value: <Button variant="link" inline onClick={() => onOpen(neg.rowId)} aria-label={`Open the negative ${neg.text}`}>{neg.text}</Button>,
      hint: `${negativeWords(neg.match)} in ${neg.level === 'CAMPAIGN' ? `the whole campaign ${neg.campaign.name}` : `${neg.campaign.name} › ${neg.adGroup?.name ?? ''}`} · added by ${addedByWords(neg.owner)}`,
    }] : []),
    ...(row.skipped ? [{ label: row.state === 'PROTECTED' ? 'Kept protected' : 'Skipped', value: `until ${dayWords(row.skipped.until)}`, hint: row.skipped.by ? `by ${row.skipped.by}` : undefined }] : []),
    ...(row.kind === 'TERM' && row.via ? [{ label: 'Shown through', value: linkTo(row.via, '—'), hint: row.match === 'AUTO' ? 'The auto targeting that showed your ad' : 'The keyword or target that showed your ad' }] : []),
    ...(row.kind !== 'TERM' ? [{ label: 'Match', value: matchWord(row.match) }] : []),
    { label: 'Product', value: row.product ? linkTo(row.product, '—') : productWords(row) },
    { label: 'Looked after by', value: row.owner.kind === 'RULE' && row.owner.id ? <Link href={ruleHref(row.owner.id)} className="nds-entitylink">{row.owner.name}</Link> : ownerWords(row.owner) },
    ...(row.lastChange ? [{ label: 'Last change', ...lastChangeWords(row.lastChange, row.kind)! }] : []),
    ...(blockedIn?.length ? [{ label: 'Already blocked in', value: <Button variant="link" inline onClick={onWhere}>{plural(blockedIn.length, 'other ad group')}</Button> }] : []),
    ...(row.stillServesIn ? [{ label: 'Still spends in', value: <Button variant="link" inline onClick={onWhere}>{plural(row.stillServesIn, 'other ad group')}</Button> }] : []),
    ...(!trend && row.d90 ? [{ label: 'Last 90 days', value: `${moneyOr(row.d90.spendCents, row.currency)} · ${plural(row.d90.orders, 'order')}` }] : []),
  ]

  const main = (
    <div className={s.col}>
      <RecordBanner view={banner} icon={row.waiting ? 'hourglass' : row.state === 'PROTECTED' ? 'shield' : undefined} />
      <RecordMetrics metrics={wasteMetrics(row)} />
      {protects && (
        <Card header={<Counted label="What protects it" n={protects.rows.length} />} description={protects.desc} headingLevel={3}>
          <SummaryTable
            label="What protects it"
            columns={['Protected term', 'Match', 'Where', 'Why']}
            widths={['22%', '14%', '26%', '38%']}
            align={[undefined, undefined, undefined, 'left']}
            stackOnPhone
            rows={protects.rows.map((t) => ({ id: t.id, cells: [<span key="t" className={s.strong}>{t.term}</span>, t.match, t.where, t.why] }))}
          />
          <p className={s.note}>{protects.note}</p>
        </Card>
      )}
      {approve && (
        <Card header="What Approve does" description={approve.desc} headingLevel={3}>
          <SummaryTable
            label="What Approve does"
            columns={['Campaign › ad group', 'Change', 'Now', 'After']}
            widths={['40%', '30%', '15%', '15%']}
            stackOnPhone
            rows={[{
              id: row.id,
              cells: [
                <span key="w" className={s.pathCell}><EntityPath items={[row.campaign, row.adGroup]} linkAs={WorkspaceLink} label="Where" /><span className="nds-summary-sub">This row</span></span>,
                approve.change, approve.now, approve.after,
              ],
            }]}
          />
          <p className={s.note}>{approve.others ? `It covers ${plural(approve.others, 'other place')} too: the review lists each one first. ` : ''}{approve.foot}</p>
        </Card>
      )}
      {checks && (
        <Card header={checks.title} description={checks.verdict} headingLevel={3}>
          <SummaryTable
            label={checks.title}
            columns={narrow ? ['Check', checks.column, 'Result'] : ['Check', checks.column, 'Limit', 'Result']}
            rows={checks.rows.map((c) => ({
              id: c.id,
              cells: [
                c.check,
                narrow ? <span key="v" className={s.num}>{c.value}<span className="nds-summary-sub">Limit: {c.limit}</span></span> : <span key="v" className={s.num}>{c.value}</span>,
                ...(narrow ? [] : [c.limit]),
                <Tag key="r" tone={c.result.tone}>{c.result.word}</Tag>,
              ],
            }))}
          />
          <p className={s.note}>{checks.note}</p>
        </Card>
      )}
    </div>
  )

  const aside = (
    <div className={s.col}>
      <Card header={row.waiting ? 'About this ask' : `About this ${noun}`} headingLevel={3}>
        <KeyValue items={about.slice(0, 6)} dense labelCase="sentence" />
      </Card>
      {trend && row.spark && (
        <Card header="Spend per week" description={trend.desc} headingLevel={3}>
          <div className={s.trend}>
            <Sparkline values={row.spark} label={`Spend per week, ${row.spark.length} weeks`} format={(n) => money(n, row.currency)} width={252} height={44} fluid />
            <KeyValue columns={2} phoneColumns={2} dense labelCase="sentence" items={[
              { label: 'This week', value: trend.thisWeek },
              ...(row.d90 ? [{ label: 'Last 90 days', value: `${moneyOr(row.d90.spendCents, row.currency)} · ${plural(row.d90.orders, 'order')}` }] : []),
            ]} />
          </div>
        </Card>
      )}
    </div>
  )

  return <RecordLayout main={main} aside={aside} asideLabel={row.waiting ? 'About this ask' : `About this ${noun}`} />
}

/* ── Overview: a stopped row (did it work?) ──────────────────────────────────────────────────────────────────────── */

function StoppedOverview({ row, runsIn, onWhere }: { row: StoppedRow; runsIn: Place[] | null; onWhere(): void }) {
  const others = stillSpendsPlaces(row, runsIn)
  const sum = savingSum(row)
  const noun = recordNoun(row)
  const since = sinceView(row)
  const first = others[0]
  const about: KeyValueItem[] = [
    ...(row.keptPaused ? [
      { label: 'Kept paused by', value: row.keptPaused.by.name, hint: `Since ${dayWords(row.keptPaused.at)}. ${row.keptPaused.reason ? row.keptPaused.reason.replace(/\.?$/, '.') : 'No rule, Brain or plan turns it on.'}` },
      { label: 'Until', value: row.keptPaused.until ? dayWords(row.keptPaused.until) : 'Always', hint: row.keptPaused.until ? `${relWords(row.keptPaused.until).replace(/^in/, 'In')}. Keep until changes it.` : 'Keep until changes it.' },
    ] : [{ label: 'Since', value: since.text, hint: since.hint }]),
    { label: 'Spend before', value: moneyOr(row.spendBeforeCents, row.currency), hint: 'In the 30 days before it stopped' },
    ...(row.stillServesIn ? [{
      label: 'Still spends in',
      value: <Button variant="link" inline onClick={onWhere}>{plural(row.stillServesIn, 'other ad group')}</Button>,
      hint: first?.d ? `${first.adGroup?.name ?? first.campaign.name} · ${moneyOr(first.d.spendCents, row.currency)}` : undefined,
    }] : []),
    { label: 'Product', value: row.product ? linkTo(row.product, '—') : '—' },
    ...(row.id.startsWith('neg:')
      ? [{ label: 'Negative', value: negativeWords(row.match), hint: row.level === 'CAMPAIGN' ? 'In the whole campaign' : row.level === 'AD_GROUP' ? 'In this ad group' : undefined }]
      : [{ label: 'Match', value: matchWord(row.match) }]),
    ...(row.places > 1 ? [{ label: 'Same negative', value: plural(row.places, 'place') }] : []),
  ]
  const main = (
    <div className={s.col}>
      <RecordBanner view={stoppedBanner(row, others)} />
      <RecordMetrics metrics={stoppedMetrics(row)} />
      {sum && (
        <Card header="How the saving is counted" description="Spend a day before the stop, times the days since, minus what it spent since" headingLevel={3}>
          <SummaryTable
            label="How the saving is counted"
            columns={['Part', noun === 'negative' ? 'This negative' : `This ${noun}`, 'How']}
            align={[undefined, undefined, 'left']}
            stackOnPhone
            rows={sum.rows.map((p) => ({
              id: p.id,
              cells: p.id === 'saved'
                ? [<span key="p" className={s.strong}>{p.part}</span>, <span key="v" className={`${s.num} ${s.strong}`}>{p.value}</span>, <span key="h" className={s.strong}>{p.how}</span>]
                : [p.part, <span key="v" className={s.num}>{p.value}</span>, p.how],
            }))}
          />
          <p className={s.note}>{sum.note}</p>
        </Card>
      )}
    </div>
  )
  const aside = (
    <Card header={`About this ${noun}`} headingLevel={3}>
      <KeyValue items={about.slice(0, 6)} dense labelCase="sentence" />
    </Card>
  )
  return <RecordLayout main={main} aside={aside} asideLabel={`About this ${noun}`} />
}

/* ── Where it runs ───────────────────────────────────────────────────────────────────────────────────────────────── */

const placePath = (p: Pick<Place, 'campaign' | 'adGroup'>) => (
  <span className={s.pathCell}>
    <EntityPath items={[p.campaign, p.adGroup]} linkAs={WorkspaceLink} label="Where" />
    {!p.adGroup && <span className="nds-summary-sub">whole campaign</span>}
  </span>
)

function WhereTab({ row, runsIn, blockedIn, onOpen, held, onAsk }: { row: WasteRow | StoppedRow; runsIn: Place[]; blockedIn: Place[]; onOpen(id: string): void; held: string | null; onAsk(a: WasteAsk): void }) {
  const w = whereWords(row)
  const open = (p: Place, what: string) => (p.rowId && p.rowId !== row.id
    ? <Button size="sm" onClick={() => onOpen(p.rowId!)} aria-label={`Open the ${what} in ${p.adGroup?.name ?? p.campaign.name}`}>Open</Button>
    : null)
  return (
    <div className={s.col}>
      <p className={s.intro}>{w.intro}</p>
      <Card header={<Counted label="Spends here" n={runsIn.length} />} description={w.spends} headingLevel={3}>
        {runsIn.length ? (
          <SummaryTable
            label="Spends here"
            columns={['Campaign › ad group', 'Match', 'State', 'Spend', 'Orders', '']}
            widths={['36%', '10%', '13%', '10%', '8%', '23%']}
            density="roomy"
            align={[undefined, undefined, undefined, 'right', 'right', 'right']}
            stackOnPhone
            rows={runsIn.map((p, i) => {
              const pill = placePill(p, row)
              return {
                id: `${i}:${p.rowId ?? p.campaign.id}`,
                cells: [
                  placePath(p),
                  matchWord(p.match),
                  <Pill key="s" tone={pill.tone}>{pill.word}</Pill>,
                  <span key="sp" className={s.num}>{p.d ? moneyOr(p.d.spendCents, row.currency) : '—'}</span>,
                  <span key="o" className={s.num}>{p.d ? p.d.orders.toLocaleString('en-IE') : '—'}</span>,
                  p.rowId === row.id ? <span key="a" className={s.quiet}>This record</span> : (
                    <span key="a" className={s.actions}>
                      {/* Still bought here: one click adds the negative exact in this ad group (audit S17); the review says what. */}
                      {p.rowId?.startsWith('term:') && p.state === 'RUNNING' && (
                        <Button size="sm" heldReason={held} aria-label={`Add a negative exact in ${p.adGroup?.name ?? 'this ad group'}`}
                          onClick={() => onAsk({ kind: 'change', items: [{ rowId: p.rowId!, action: 'NEGATE_EXACT', where: 'adGroup' }] })}>Add negative exact</Button>
                      )}
                      {open(p, 'search term')}
                    </span>
                  ),
                ],
              }
            })}
          />
        ) : <p className={s.quiet}>Not spending anywhere.</p>}
      </Card>
      <Card header={<Counted label="Blocked here" n={blockedIn.length} />} description={w.blocked} headingLevel={3}>
        {blockedIn.length ? (
          <SummaryTable
            label="Blocked here"
            columns={['Campaign › ad group', 'Negative', 'Added by', '']}
            widths={['44%', '22%', '16%', '18%']}
            density="roomy"
            stackOnPhone
            rows={blockedIn.map((p, i) => ({
              id: `${i}:${p.rowId ?? p.campaign.id}`,
              cells: [
                placePath(p),
                negativeWords(p.match),
                addedByWords(p.owner),
                p.rowId === row.id ? <span key="a" className={s.quiet}>This record</span> : <span key="a" className={s.actions}>{open(p, 'negative')}</span>,
              ],
            }))}
          />
        ) : <p className={s.quiet}>Not blocked anywhere.</p>}
      </Card>
    </div>
  )
}
