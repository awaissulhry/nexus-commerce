'use client'

/**
 * ADS AUTONOMY W1-4 — the save of one strategy change, in the pattern the Owner liked on the product sheet's import
 * (2026-09-26): ONE summary, ONE table of every setting from → to with raise or lower, what happens when it lands, and
 * ONE button that says what it does with its count. A raise says so before anything is asked; the tab then asks for
 * the authenticator code (StepUpModal). Done says the version it made, with Undo (the previous version written back).
 *
 * Presentational: the tab owns the calls. Everything in it comes from the API's preview (apps/api ads-strategy/write.ts).
 */
import { Banner, MetricStrip, Modal, SummaryTable } from '@/design-system/components'
import { Button, Tag } from '@/design-system/primitives'
import type { StrategyChange, StrategyPreview } from './strategyApi'
import { changeRows, effectLines, listWords, raiseList, saveButtonWords } from './strategyWords'
import styles from './strategy.module.css'

export type ReviewPhase = 'review' | 'saving' | 'done' | 'undoing' | 'undone'

export interface StrategyReviewProps {
  open: boolean
  /** "the IT market strategy", "the strategy for Full face". */
  what: string
  preview: StrategyPreview | null
  currency: string | null
  phase: ReviewPhase
  error: string | null
  /** The row moved since it was read (409): nothing was saved. */
  conflict: boolean
  saved: { version: number; changes: StrategyChange[] } | null
  /** The undo's own save: its version and what it changed back. */
  undone: { version: number; changes: StrategyChange[] } | null
  onSave: () => void
  onUndo: () => void
  onReload: () => void
  onClose: () => void
}

export function StrategyReview(p: StrategyReviewProps) {
  const { preview, currency, phase } = p
  if (!preview) return null
  const done = phase === 'done' || phase === 'undoing' || phase === 'undone'
  const busy = phase === 'saving' || phase === 'undoing'
  const changes = phase === 'undone' && p.undone ? p.undone.changes : done && p.saved ? p.saved.changes : preview.changes
  const rows = changeRows(changes, currency)
  const raises = raiseList(preview.changes)
  const lowers = preview.changes.filter((c) => c.direction === 'lower').length
  const settings = preview.changes.length
  const button = saveButtonWords({ changes: settings, raises: raises.length, mayRaise: preview.mayRaise })
  const removing = preview.op === 'remove'
  const title = done
    ? phase === 'undone' ? 'Undone' : 'Saved'
    : removing ? `Remove ${p.what}?` : `Save ${p.what}?`

  const footer = done ? (
    <>
      {phase !== 'undone' && <Button variant="secondary" disabled={busy} onClick={p.onUndo}>{phase === 'undoing' ? 'Undoing…' : 'Undo'}</Button>}
      <span className="grow" />
      <Button variant="primary" disabled={busy} onClick={p.onClose}>Done</Button>
    </>
  ) : (
    <>
      <span className="grow" />
      <Button variant="secondary" disabled={busy} onClick={p.onClose}>Cancel</Button>
      {p.conflict
        ? <Button variant="primary" onClick={p.onReload}>Reload the strategy</Button>
        : <Button variant="primary" disabled={busy || button.disabled} onClick={p.onSave}>{phase === 'saving' ? 'Saving…' : removing ? 'Remove it' : button.label}</Button>}
    </>
  )

  return (
    <Modal open={p.open} onClose={busy ? () => undefined : p.onClose} size="lg" title={title} footer={footer}>
      <div className={styles.review}>
        {phase === 'undone' && p.undone && (
          <Banner tone="success" title={`Undone: version ${p.undone.version} puts back what was there before.`}>
            Nothing else changed. The history keeps both versions.
          </Banner>
        )}
        {(phase === 'done' || phase === 'undoing') && p.saved && (
          <Banner tone="success" title={`Saved: ${p.what} is now at version ${p.saved.version}.`}>
            Undo writes the previous version back.{lowers > 0 ? ' Putting a higher number back counts as a raise, so that asks for your code.' : ''}
          </Banner>
        )}
        {!done && (
          <p className={styles.summaryLine}>
            {settings} {settings === 1 ? 'change' : 'changes'}: {raises.length} {raises.length === 1 ? 'raises' : 'raise'}, {lowers} {lowers === 1 ? 'lowers' : 'lower'}.
          </p>
        )}
        {!done && (
          <div className={styles.summaryTiles}><MetricStrip metrics={[
            { label: 'Changes', value: String(settings) },
            { label: 'Raise', value: String(raises.length), hint: raises.length ? 'asks for your code' : 'none' },
            { label: 'Lower', value: String(lowers), hint: lowers ? (raises.length ? 'no code for these' : 'saves at once') : 'none' },
          ]} /></div>
        )}
        {!done && raises.length > 0 && (
          preview.mayRaise
            ? <Banner tone="warning" title={`It raises ${listWords(raises)}.`}>Saving asks for the 6-digit code from your authenticator app. Lowering never does.</Banner>
            : <Banner tone="danger" title={`It raises ${listWords(raises)}.`}>{button.why}</Banner>
        )}
        {p.conflict && (
          <Banner tone="warning" title="This strategy changed since you opened it.">
            Someone saved a newer version meanwhile, so nothing was saved. Reload it to see what is there now, then make your change again.
          </Banner>
        )}
        {p.error && <Banner tone="danger" title={done ? 'That did not work' : 'Not saved'}>{p.error}</Banner>}

        <div className={styles.tableWrap}>
          <SummaryTable
            label={done ? 'What changed' : 'What changes'}
            columns={['Setting', done ? 'Before' : 'Now', done ? 'Saved' : 'After saving', 'Effect']}
            rows={rows.map((r) => ({ id: r.id, cells: [r.setting, r.now, r.next, <Tag key="e" tone={r.tone}>{r.effect}</Tag>] }))}
          />
        </div>

        <div>
          <p className={styles.groupLabel}>{done ? 'What it does now' : 'When you save'}</p>
          <ul className={styles.effects}>
            {effectLines(changes, preview.readBy, preview.scope.market, preview.affects).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      </div>
    </Modal>
  )
}
