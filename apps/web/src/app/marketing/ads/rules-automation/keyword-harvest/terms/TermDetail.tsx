'use client'

/**
 * Keyword Harvest page — one term's detail (2026-10-11, lane TERMS): the DS `DetailModal`, centered, a full-screen sheet
 * on a phone. Its address is `?term=<candidateId>&tab=overview|where|results|history` (the view's `useDetailParam`:
 * opening it is a step in the history, so Back closes it; a tab and ▲ / ▼ replace it). ▲ / ▼ and J / K walk the table's
 * rows as shown — every page (DS recordNav). Esc closes it and the focus goes back to the row's cell.
 *
 *   Overview       the term's numbers · Goes to · As (match · start bid) · In source · Funnel · Bar · Who decides
 *   Where it runs  every source ad group of the product where it ran (what a harvest does there), and the funnel blocks
 *   Results        the harvest's verdict after the attribution window + 72 h: Better / Worse / Too early
 *   History        the harvest record: who, when, where it went, what became of each block — Undo… while it can
 *
 * Footer: Skip… (7 d · 30 d · for good) or Unskip · Approve / Reject (waiting) · Undo… (harvested) · Harvest to….
 * Every change is asked of the view (its review opens ABOVE this dialog); nothing here writes.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Tag } from '@/design-system/primitives'
import { EntityLinks, EntityPath, KeyValue, Menu, MetricStrip, SummaryTable, type EntityLinkComponent, type MenuItemDef } from '@/design-system/components'
import { DetailModal, type DetailModalProps, type DetailNav } from '@/design-system/patterns'
import Link from '@/lib/workspaces/Link'
import { CHANGE_STATE_TONE, CHANGE_STATE_WORD } from '../../bid/_shared/delivery'
import { dayWords, whenWords } from '../../bid/_shared/format'
import { readHistory } from '../_shared/harvestApi'
import type { HarvestCandidateRow, HistoryRow, Ref, SkipDays } from '../_shared/types'
import {
  acosText, actorWord, approveHeld, barWords, decideHeld, harvestToHeld, historyStateOf, inSourceWords, isTermTab, numbersWindowWords, plural, roleWord,
  rowMoney, rowNumbers, skipHeld, sourceActionWord, statusOf, undoHeld, undoWhyWords, VERDICT_VIEW, type TermTab,
} from './termsModel'
import styles from './terms.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const AD_GROUP_NOUN = { one: 'ad group', many: 'ad groups' }
const PRODUCT_NOUN = { one: 'product', many: 'products' }

export interface TermDetailActions {
  harvestTo(row: HarvestCandidateRow): void
  decide(row: HarvestCandidateRow, kind: 'approve' | 'reject'): void
  skip(row: HarvestCandidateRow, days: SkipDays): void
  unskip(row: HarvestCandidateRow): void
  undo(row: HarvestCandidateRow): void
}

type Load<T> = { state: 'loading' } | { state: 'failed'; error: string } | { state: 'ready'; value: T }

/** The term's harvest record (one per product × market × term), read when Results or History opens. */
function useHarvestRecord(row: HarvestCandidateRow | null, wanted: boolean, version: number): Load<HistoryRow | null> {
  // The answer is kept with the term it is for: after ▲ / ▼ the next term reads "Reading…", never the last one's record.
  const [loaded, setLoaded] = useState<{ for: string | null; load: Load<HistoryRow | null> }>({ for: null, load: { state: 'loading' } })
  const id = row?.id ?? null
  const market = row?.market ?? null
  const productId = row?.product.id ?? null
  const harvestId = row?.lastHarvest?.harvestId ?? null
  useEffect(() => {
    if (!wanted || !id || !market || !productId) return
    if (!harvestId) { setLoaded({ for: id, load: { state: 'ready', value: null } }); return }
    let alive = true
    setLoaded({ for: id, load: { state: 'loading' } })
    readHistory({ market, productId, days: 365 })
      .then((a) => { if (alive) setLoaded({ for: id, load: { state: 'ready', value: a.rows.find((r) => r.harvestId === harvestId || r.candidateId === id) ?? null } }) })
      .catch((e: unknown) => { if (alive) setLoaded({ for: id, load: { state: 'failed', error: e instanceof Error ? e.message : String(e) } }) })
    return () => { alive = false }
  }, [wanted, id, market, productId, harvestId, version])
  return loaded.for === id ? loaded.load : { state: 'loading' }
}

/** An ad group as two lines: its link, and its campaign (a link) under it — never cut beside empty room (S14). */
function Place({ adGroup, campaign, portfolio }: { adGroup: Ref; campaign?: Ref | null; portfolio?: Ref | null }) {
  return (
    <span className={styles.two}>
      <EntityLinks items={[adGroup]} noun={AD_GROUP_NOUN} linkAs={WorkspaceLink} />
      {(campaign || portfolio) && <span className={styles.sub}><EntityPath items={[portfolio ?? null, campaign ?? null]} linkAs={WorkspaceLink} label="In" /></span>}
    </span>
  )
}

function Overview({ row }: { row: HarvestCandidateRow }) {
  const n = rowNumbers(row)
  const d = row.destination
  const status = statusOf(row)
  const match = d?.match === 'PHRASE' ? 'Phrase' : 'Exact'
  const cpc = typeof row.metrics.cpcCents === 'number' ? ` · CPC now ${rowMoney(row, row.metrics.cpcCents)}` : ''
  const blockedIn = row.funnel.map((f) => f.adGroup)
  return (
    <div className={styles.detail}>
      <MetricStrip metrics={[
        { label: 'Orders', value: n.orders, hint: numbersWindowWords(n) },
        { label: 'ACoS', value: acosText(n.acosPct) },
        { label: 'Spend', value: rowMoney(row, n.spendCents) },
        { label: 'Clicks', value: n.clicks.toLocaleString('en-IE') },
        { label: 'CPC', value: rowMoney(row, n.cpcCents) },
      ]} />
      <KeyValue columns={2} items={[
        {
          label: 'Goes to',
          value: d?.kind === 'new'
            ? <span className={styles.inline}><Tag tone="info">New campaign</Tag><span>{d.plan.name}</span></span>
            : d ? <Place adGroup={d.adGroup} campaign={d.campaign} portfolio={d.portfolio} /> : <span className={styles.muted}>—</span>,
          hint: !d && row.heldBy ? row.heldBy.reason : undefined,
        },
        { label: 'As', value: <span title={`Bid for your ACoS target${cpc}`}>{match} · {rowMoney(row, row.startBidCents)}</span> },
        { label: 'Blocked where found', value: inSourceWords(row.sources) },
        { label: 'Also blocked in', value: blockedIn.length ? <EntityLinks items={blockedIn} noun={AD_GROUP_NOUN} linkAs={WorkspaceLink} /> : '—' },
        { label: 'Sells', value: <span className={styles.inline}><Tag tone={row.bar.passes ? 'success' : 'neutral'}>{row.bar.passes ? 'Yes' : 'Not yet'}</Tag><span className={styles.muted}>{barWords(row.bar.label)} · {row.metrics.windowDays} days</span></span> },
        { label: 'Run by', value: row.owner.name },
        { label: 'Status', value: <Tag tone={status.tone}>{status.word}</Tag>, hint: status.hint ?? undefined },
      ]} />
    </div>
  )
}

function WhereItRuns({ row }: { row: HarvestCandidateRow }) {
  return (
    <div className={styles.detail}>
      <section className={styles.section} aria-label="Runs in">
        <h3 className={styles.h}>Runs in · {plural(row.sources.length, 'ad group')}</h3>
        {row.sources.length ? (
          <SummaryTable
            label="Where the term runs"
            columns={['Ad group', 'Match', 'Clicks', 'Harvest adds']}
            rows={row.sources.map((s) => ({
              id: s.adGroup.id,
              cells: [
                <Place key="p" adGroup={s.adGroup} campaign={s.campaign} portfolio={s.portfolio} />,
                roleWord(s.role) ?? '—',
                s.clicks.toLocaleString('en-IE'),
                <span key="a" title={s.why}>{sourceActionWord(s.action)}</span>,
              ],
            }))}
          />
        ) : <p className={styles.muted}>—</p>}
      </section>
      {row.funnel.length > 0 && (
        <section className={styles.section} aria-label="Also blocked in">
          <h3 className={styles.h}>Also blocked in · {plural(row.funnel.length, 'ad group')}</h3>
          <SummaryTable
            label="Wider matches blocked"
            columns={['Ad group', 'Adds']}
            rows={row.funnel.map((f) => ({
              id: f.adGroup.id,
              cells: [<Place key="p" adGroup={f.adGroup} campaign={f.campaign} />, f.match === 'PHRASE' ? 'Negative phrase' : 'Negative exact'],
            }))}
          />
        </section>
      )}
    </div>
  )
}

function RecordState({ load, children }: { load: Load<HistoryRow | null>; children: (r: HistoryRow | null) => ReactNode }) {
  if (load.state === 'loading') return <p className={styles.muted} aria-busy="true">Reading…</p>
  if (load.state === 'failed') return <p className={styles.muted} role="alert">{load.error}</p>
  return <>{children(load.value)}</>
}

function Results({ row, load }: { row: HarvestCandidateRow; load: Load<HistoryRow | null> }) {
  return (
    <RecordState load={load}>
      {(r) => {
        if (!r) return <p className={styles.muted}>Not harvested</p>
        const v = r.judge.verdict ? VERDICT_VIEW[r.judge.verdict] : null
        const why = r.judge.why?.trim() || row.lastHarvest?.judge?.why?.trim() || null
        const since = row.state === 'HARVESTED' ? row.sinceHarvest : null
        return (
          <div className={styles.detail}>
            <KeyValue items={[
              { label: 'Result', value: v ? <Tag tone={v.tone}>{v.word}</Tag> : <span className={styles.muted}>Not checked yet</span> },
              { label: 'Checked', value: r.judge.judgedAt ? dayWords(r.judge.judgedAt) : r.judge.judgeAfter ? `after ${dayWords(r.judge.judgeAfter)}` : '—' },
              // Why and the keyword's own numbers only when there are some (S7: never the search term's old window).
              ...(why ? [{ label: 'Why', value: why }] : []),
              ...(since ? [{ label: 'Since harvest', value: `${plural(since.orders, 'order')} · ${acosText(since.acosPct)} · ${rowMoney(row, since.spendCents)} · ${since.days} days` }] : []),
            ]} />
          </div>
        )
      }}
    </RecordState>
  )
}

const HISTORY_STATE: Readonly<Record<'paused' | 'off', { word: string; tone: 'neutral' }>> = { paused: { word: 'Paused', tone: 'neutral' }, off: { word: 'Not running', tone: 'neutral' } }

function History({ row, load }: { row: HarvestCandidateRow; load: Load<HistoryRow | null> }) {
  return (
    <RecordState load={load}>
      {(r) => {
        if (!r) return <p className={styles.muted}>{row.skipped ? `Skipped · ${whenWords(row.skipped.at)}` : 'Not harvested'}</p>
        const state = historyStateOf(r.status, { keyword: row.lastHarvest ? row.lastHarvest.keyword : undefined })
        const view = state === 'paused' || state === 'off' ? HISTORY_STATE[state] : { word: CHANGE_STATE_WORD[state], tone: CHANGE_STATE_TONE[state] }
        return (
          <div className={styles.detail}>
            <KeyValue columns={2} items={[
              { label: 'When', value: whenWords(r.at) },
              { label: 'By', value: actorWord(r.by) },
              { label: 'State', value: <Tag tone={view.tone}>{view.word}</Tag> },
              { label: 'To', value: r.destination?.adGroup ? <Place adGroup={r.destination.adGroup} campaign={r.destination.campaign} portfolio={r.destination.portfolio} /> : '—' },
              { label: 'As', value: r.match === 'PHRASE' ? 'Phrase' : 'Exact' },
              { label: 'Undo', value: r.undo.available ? 'Possible' : <span className={styles.muted}>{undoWhyWords(r.undo.why)}</span> },
            ]} />
            {(r.sources.length > 0 || r.funnel.length > 0) && (
              <SummaryTable
                label="Blocks it added"
                columns={['Ad group', 'Adds', 'Result']}
                rows={[
                  ...r.sources.map((s, i) => ({ id: `s${i}`, cells: [<Place key="p" adGroup={s.adGroup} />, sourceActionWord(s.action), s.result ?? '—'] })),
                  ...r.funnel.map((f, i) => ({ id: `f${i}`, cells: [<Place key="p" adGroup={f.adGroup} />, f.match === 'PHRASE' ? 'Negative phrase' : 'Negative exact', f.result ?? '—'] })),
                ]}
              />
            )}
          </div>
        )
      }}
    </RecordState>
  )
}

const TAB_LABEL: Readonly<Record<TermTab, string>> = { overview: 'Overview', where: 'Where it runs', results: 'Results', history: 'History' }

export function TermDetail({
  row, missing, loading, onRetry, tab, onTab, nav, onClose, returnFocusTo, actions, manageHeld, writeHeld = null, version,
}: {
  row: HarvestCandidateRow | null
  /** The address names a term this read does not hold. */
  missing: boolean
  loading: boolean
  onRetry(): void
  tab: string | null
  onTab(tab: TermTab): void
  nav?: DetailNav
  onClose(): void
  returnFocusTo?: DetailModalProps['returnFocusTo']
  actions: TermDetailActions
  /** Why this person may not harvest, decide or undo (permission), or null. */
  manageHeld: string | null
  /** Why a change that reaches Amazon cannot be sent in this term's market (Nexus only reads it), or null. */
  writeHeld?: string | null
  /** Bumped after every change: the record is read again. */
  version: number
}) {
  const active: TermTab = isTermTab(tab) ? tab : 'overview'
  const record = useHarvestRecord(row, active === 'results' || active === 'history', version)
  const tabs = (Object.keys(TAB_LABEL) as TermTab[]).map((id) => ({ id, label: id === 'where' && row ? `${TAB_LABEL.where} ${row.sources.length}` : TAB_LABEL[id] }))
  const held = (own: string | null) => own ?? manageHeld
  const send = (own: string | null) => own ?? manageHeld ?? writeHeld
  /** The record says it cannot be put back (read with Results or History). */
  const recordUndo = record.state === 'ready' && record.value && !record.value.undo.available ? record.value.undo.why ?? 'Nothing of it to put back' : null

  const status = row ? statusOf(row) : null
  const skipItems: MenuItemDef[] = row ? ([7, 30, null] as SkipDays[]).map((days) => {
    const why = held(skipHeld(row))
    const label = days == null ? 'For good' : `${days} d`
    return why ? { id: `skip${days ?? 'x'}`, label, disabled: true, description: why } : { id: `skip${days ?? 'x'}`, label, onSelect: () => actions.skip(row, days) }
  }) : []

  const footer = row ? (
    <div className={styles.footer}>
      <span className={styles.footerEnd}>
        {row.state === 'SKIPPED'
          ? <Button size="sm" variant="secondary" heldReason={held(null)} onClick={() => actions.unskip(row)}>Unskip</Button>
          : !skipHeld(row) && <Menu label="Skip…" items={skipItems} triggerProps={{ className: 'nds-btn sm', 'aria-label': 'Skip this term' }} />}
      </span>
      <span className={styles.footerEnd}>
        {row.state === 'WAITING' && (
          <>
            <Button size="sm" variant="secondary" heldReason={held(decideHeld(row))} onClick={() => actions.decide(row, 'reject')}>Reject</Button>
            <Button size="sm" variant="primary" heldReason={send(approveHeld(row))} onClick={() => actions.decide(row, 'approve')}>Approve</Button>
          </>
        )}
        {row.state === 'HARVESTED' && <Button size="sm" variant="secondary" heldReason={send(undoHeld(row) ?? recordUndo)} onClick={() => actions.undo(row)}>Undo…</Button>}
        {row.state !== 'WAITING' && row.state !== 'HARVESTED' && (
          <Button size="sm" variant="primary" heldReason={send(harvestToHeld(row))} onClick={() => actions.harvestTo(row)}>Harvest to…</Button>
        )}
      </span>
    </div>
  ) : undefined

  const role = row ? roleWord(row.source?.role) : null
  return (
    <DetailModal
      open
      onClose={onClose}
      title={row?.term ?? 'Search term'}
      subtitle={row?.source ? <EntityPath items={[row.source.portfolio, row.source.campaign, row.source.adGroup]} linkAs={WorkspaceLink} label="Found in" /> : undefined}
      meta={row ? (
        <span className={styles.chips}>
          <EntityLinks items={[row.product]} noun={PRODUCT_NOUN} linkAs={WorkspaceLink} />
          {role && <Tag tone="neutral">{role}</Tag>}
          <Tag tone="neutral">{row.market}</Tag>
          {status && <Tag tone={status.tone}>{status.word}</Tag>}
        </span>
      ) : undefined}
      tabs={tabs}
      activeTab={active}
      onTabChange={(id) => { if (isTermTab(id)) onTab(id) }}
      tabsLabel="Search term"
      nav={nav}
      loading={!row && loading}
      error={!row && !loading && missing ? 'This term is not in this view.' : undefined}
      onRetry={onRetry}
      footer={footer}
      returnFocusTo={returnFocusTo}
    >
      {row && active === 'overview' && <Overview row={row} />}
      {row && active === 'where' && <WhereItRuns row={row} />}
      {row && active === 'results' && <Results row={row} load={record} />}
      {row && active === 'history' && <History row={row} load={record} />}
    </DetailModal>
  )
}
