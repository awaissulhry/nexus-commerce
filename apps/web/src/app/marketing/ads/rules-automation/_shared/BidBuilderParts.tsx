'use client'

/**
 * The bid rule builder's own parts (2026-10-10): the live preview that is always on screen, the starts, the four-step
 * mode, "Over" with its note, and the confirm before unsaved changes are dropped. Design-system parts only; the words
 * and rules are in bidRuleBuilder.ts (pure, tested). RuleBuilder.tsx mounts them for the bid surface only.
 */
import type { ReactNode } from 'react'
import { Button, SegmentedControl, Skeleton, Tag, Tooltip } from '@/design-system/primitives'
import { Banner, Disclosure, Listbox, Modal, SummaryTable, type ListboxPanelOption } from '@/design-system/components'
import { ChangeValue, MODE_STEPS, modeOptions, type ModeReading } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { moneyText } from '../bid/_shared/format'
import { BID_MODE_MEANS, BID_START_LABEL, BID_STARTS, countWords, isBidMode, lookbackNote, type BidMode, type BidPreview, type BidStart, type PreviewRow } from './bidRuleBuilder'
import styles from './ruleBuilderBid.module.css'

// ── the live preview ─────────────────────────────────────────────────────────────────────────────────────────────────

export type BidPreviewState =
  | { phase: 'blocked'; blockers: string[] }
  | { phase: 'loading'; last: BidPreview | null }
  | { phase: 'ready'; data: BidPreview }
  | { phase: 'failed'; error: string }

const STATE_WORD: Readonly<Record<string, string>> = { ENABLED: 'On', PAUSED: 'Paused', ARCHIVED: 'Archived' }
const stateWord = (s: string | null) => (s ? STATE_WORD[s.toUpperCase()] ?? s : '—')

/** A chip whose reason shows on hover AND on keyboard focus. */
function ReasonTag({ reason, tone, children }: { reason: string; tone?: 'neutral' | 'info' | 'warning' | 'danger'; children: ReactNode }) {
  return (
    <Tooltip label={reason} portal>
      <span className={styles.focusable} tabIndex={0} aria-label={`${typeof children === 'string' ? children : ''} ${reason}`.trim()}>
        <Tag tone={tone ?? 'neutral'}>{children}</Tag>
      </span>
    </Tooltip>
  )
}

function KeywordCell({ row }: { row: PreviewRow }) {
  const href = row.campaign?.href ?? (row.campaign ? `/marketing/ads/campaigns/${encodeURIComponent(row.campaign.id)}` : null)
  return (
    <span className={styles.two}>
      <span>{row.keyword}</span>
      {row.campaign && (href ? <Link className={styles.sub} href={href}>{row.campaign.name}</Link> : <span className={styles.sub}>{row.campaign.name}</span>)}
    </span>
  )
}

function changeOf(row: PreviewRow, currency: string) {
  if (row.field === 'state') return { label: 'State', from: stateWord(row.from), to: stateWord(row.to) }
  return { label: 'Bid', from: moneyText(row.fromCents, currency), to: moneyText(row.toCents, currency) }
}

export function BidPreviewPanel({ state, currency, ceilingEmpty, wide, onRetry }: {
  state: BidPreviewState
  /** The market's currency (ISO): the amounts are cents in it. */
  currency: string
  /** The rule has no highest bid: said, because a computed bid may then rise without a limit. */
  ceilingEmpty: boolean
  /** A wide screen: the list of bids is open; on a narrow one it folds under the count. */
  wide: boolean
  onRetry(): void
}) {
  const data = state.phase === 'ready' ? state.data : state.phase === 'loading' ? state.last : null
  const rows = data?.rows ?? []
  const sample = rows.length > 0 && (
    <div className={styles.table}>
      <SummaryTable
        label="Would change"
        columns={['Keyword', 'Now → new']}
        rows={rows.map((r) => ({
          id: r.key,
          cells: [
            <KeywordCell key="k" row={r} />,
            <span key="c" className={styles.two}>
              <ChangeValue changes={[changeOf(r, currency)]} hideLabels />
              {r.hold && <ReasonTag reason={r.hold.reason} tone={r.hold.label === 'Brain decides' ? 'info' : 'warning'}>{r.hold.label}</ReasonTag>}
            </span>,
          ],
        }))}
      />
    </div>
  )
  return (
    <aside className={styles.preview} aria-label="Preview">
      <div className={styles.card} aria-live="polite" aria-busy={state.phase === 'loading'}>
        {data?.sentence ? <p className={styles.sentence}>{data.sentence}</p> : state.phase === 'loading' && !data ? <Skeleton width="80%" height={16} /> : null}
        {state.phase === 'blocked' && (
          <div className={styles.chips}>
            <span className={styles.label}>Now</span>
            {state.blockers.map((b) => <Tag key={b} tone="warning">{b}</Tag>)}
          </div>
        )}
        {state.phase === 'failed' && (
          <Banner tone="danger" title="Preview not read" action={<Button size="sm" onClick={onRetry}>Try again</Button>}>{state.error}</Banner>
        )}
        {data && (
          <>
            <div className={styles.count}>
              <span className={styles.label}>Now:</span>
              <span>would change</span>
              <span className={styles.big}>{countWords(data.wouldChange, data.noun)}</span>
              {state.phase === 'loading' && <Skeleton width={40} height={12} />}
            </div>
            {(data.holds.length > 0 || data.unsampled > 0 || data.note || ceilingEmpty) && (
              <div className={styles.chips}>
                {data.holds.map((h) => <ReasonTag key={h.held} reason={h.reason} tone={h.held === 'brain' ? 'info' : 'warning'}>{`${h.label} ${h.count}`}</ReasonTag>)}
                {data.unsampled > 0 && <Tag>{`${data.unsampled} not listed`}</Tag>}
                {data.note && <Tag tone="warning">{data.note}</Tag>}
                {ceilingEmpty && <ReasonTag reason="A computed bid can rise without a limit. Set a highest bid in Limits." tone="warning">No highest bid</ReasonTag>}
              </div>
            )}
            {rows.length === 0 ? <p className={styles.empty}>No bid would change now.</p>
              : wide ? sample
              : <Disclosure summary={countWords(rows.length, data.noun)}>{sample}</Disclosure>}
          </>
        )}
        {state.phase === 'loading' && !data && <Skeleton width="60%" height={14} />}
      </div>
    </aside>
  )
}

// ── starts ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function BidStarts({ onApply }: { onApply(start: BidStart): void }) {
  return (
    <div className={`${styles.row} ${styles.starts}`} role="group" aria-label="Start from">
      <span className={styles.label}>Start from</span>
      {BID_STARTS.map((st) => (
        <Tooltip key={st.id} label={st.line} portal>
          <Button size="sm" onClick={() => onApply(st)}>{BID_START_LABEL[st.id] ?? st.name}</Button>
        </Tooltip>
      ))}
    </div>
  )
}

// ── Over ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const OVER_OPTIONS = ['7', '14', '30', '60', '90'].map((d) => ({ value: d, label: `${d} d` }))

export function OverField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const note = lookbackNote()
  return (
    <div className={`${styles.row} ${styles.over}`}>
      <span className={styles.label}>Over</span>
      <SegmentedControl size="sm" ariaLabel="Over" options={OVER_OPTIONS} value={OVER_OPTIONS.some((o) => o.value === value) ? value : '14'} onChange={onChange} />
      <ReasonTag reason={note.tip}>{note.tag}</ReasonTag>
    </div>
  )
}

// ── mode ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function BidModePicker({ value, reading, held, onChange }: {
  value: BidMode
  /** The step the rule is set to and the one it acts on (the DS reading), for the held line under the set step. */
  reading: ModeReading
  /** Why a step cannot be picked, or null. */
  held(step: string): string | null
  onChange(next: BidMode): void
}) {
  const options: ListboxPanelOption[] = modeOptions(MODE_STEPS, reading, held).map((o) => ({
    ...o,
    note: o.heldReason ?? o.note ?? (isBidMode(o.value) ? BID_MODE_MEANS[o.value] : undefined),
  }))
  return (
    <div className={styles.modeRow}>
      <Listbox width={170} ariaLabel="Mode" options={options} value={value} onChange={(v) => { if (isBidMode(v) && !held(v)) onChange(v) }} />
      <span className={styles.means}>{BID_MODE_MEANS[value]}</span>
    </div>
  )
}

// ── leave with unsaved changes ───────────────────────────────────────────────────────────────────────────────────────

export function DiscardConfirm({ open, isEdit, onKeep, onDiscard }: { open: boolean; isEdit: boolean; onKeep(): void; onDiscard(): void }) {
  return (
    <Modal
      open={open}
      onClose={onKeep}
      size="sm"
      title={isEdit ? 'Leave without saving?' : 'Leave without creating?'}
      footer={<>
        <span className="grow" />
        <Button onClick={onKeep} data-autofocus>Keep editing</Button>
        <Button variant="danger" onClick={onDiscard}>{isEdit ? 'Discard changes' : 'Discard rule'}</Button>
      </>}
    >
      {isEdit ? 'Your changes are not saved.' : 'This rule is not created.'}
    </Modal>
  )
}
