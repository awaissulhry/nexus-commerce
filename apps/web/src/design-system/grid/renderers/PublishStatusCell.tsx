'use client'

import { memo } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'
import { ArrowRight, Check } from 'lucide-react'
import { DetailPopover } from '../../components/DetailPopover'
import { Button } from '../../primitives/Button'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import type { Tone } from '../../primitives/tone'
import { EMPTY_DASH } from './format'
import { publishCardModel, publishCellModel, type PublishCardModel, type PublishIssue, type PublishStatusMeta, type PublishStatusValue } from './publishStatus'

/**
 * A publish status as a pill — the ONLY way to draw one, so every surface marks Verified the same way: a check glyph
 * where every other status has the dot. The DS success and info pills are both blue (H10 parity); the glyph is what
 * tells Verified from Accepted without relying on a shade (WCAG 1.4.1).
 */
export function PublishStatusPill({ meta }: { meta: PublishStatusMeta }) {
  // `nds-publish-pill` centres both shapes on the line: an inline-flex box takes its baseline from its FIRST item, and
  // the 11px glyph and the 7px dot end at different heights — measured 2px apart beside each other in a text line.
  if (meta.glyph === 'check') {
    return <Pill tone={meta.tone} className="nds-publish-pill" icon={<Check size={11} strokeWidth={3} aria-hidden="true" />}>{meta.label}</Pill>
  }
  return <Pill tone={meta.tone} className="nds-publish-pill" dot>{meta.label}</Pill>
}

/** What a "Last publish" column hands its cells. Both callbacks are read when an action runs, never per render. */
export interface PublishStatusCellParams {
  /** "Go to field" was chosen in the card: put the cursor in that column of this row (`landOnCell`). */
  onGoToField?: (columnKey: string, params: ICellRendererParams) => void
  /** "See publish history" was chosen in the card. */
  onOpenHistory?: (publicationId: string, params: ICellRendererParams) => void
}

/**
 * A "Last publish" cell (sheet publish parity, 2026-10-02): what became of this row's last publish to the column's
 * destination — a Pill with a dot and the status word, and the time. Hover, click, Enter or Space opens the card
 * (`cellDetailKeys` on the column); Esc returns focus to the cell.
 *
 * The cell is never painted red: red on a sheet cell already means "a required field is empty". A channel's refusal
 * is a status word here and a list of fields, each with "Go to field", in the card.
 *
 * `value === undefined` = the row-status read has not answered yet (skeleton). `readError` = it failed (a dash that
 * says so). No `last` and nothing in flight = never published from Nexus (a dash).
 */
export const PublishStatusCell = memo(function PublishStatusCell(p: ICellRendererParams & PublishStatusCellParams) {
  if (!p.data) return null
  const focusCell = () => { if (p.node?.rowIndex != null && p.column) p.api?.setFocusedCell(p.node.rowIndex, p.column) }
  return (
    <PublishStatusView
      value={p.value as PublishStatusValue | undefined}
      returnFocus={focusCell}
      onGoToField={p.onGoToField ? key => p.onGoToField?.(key, p) : undefined}
      onOpenHistory={p.onOpenHistory ? id => p.onOpenHistory?.(id, p) : undefined}
    />
  )
})

export interface PublishStatusViewProps {
  value: PublishStatusValue | undefined
  /** The read's clock, for "12:04" vs "1 Oct". Default: now. */
  now?: number
  /** Where Esc puts focus. Default: the trigger. A grid passes its cell. */
  returnFocus?: () => void
  onGoToField?: (columnKey: string) => void
  onOpenHistory?: (publicationId: string) => void
}

/** The cell's content without AG Grid — the catalog, a dialog row or the history can show the same thing. */
export function PublishStatusView({ value, now, returnFocus, onGoToField, onOpenHistory }: PublishStatusViewProps) {
  const model = publishCellModel(value, now)
  if (model.state === 'loading') {
    return (
      <span className="nds-publish-cell is-loading">
        <Skeleton width={84} height={16} radius="var(--nds-radius-pill)" />
        <span className="nds-vh">{model.ariaLabel}</span>
      </span>
    )
  }
  if (model.state !== 'status' || !value) {
    return (
      <span className="nds-publish-cell is-empty" title={model.title}>
        <span aria-hidden="true">{EMPTY_DASH}</span>
        <span className="nds-vh">{model.ariaLabel}</span>
      </span>
    )
  }
  return (
    <DetailPopover
      trigger={(
        <span className="nds-publish-cell">
          <PublishStatusPill meta={model.meta} />
          {model.shortTime && <span className="nds-publish-cell-time">{model.shortTime}</span>}
          {value.editedSince && <span className="nds-publish-cell-edited">Edited</span>}
        </span>
      )}
      triggerLabel={model.ariaLabel}
      triggerClassName="nds-publish-trigger"
      panelClassName="nds-detailpop-scroll nds-publish-pop"
      label={`Last publish to ${value.destinationLabel}`}
      returnFocus={returnFocus}
    >
      {({ close }) => (
        <PublishStatusCard
          model={publishCardModel(value, now)}
          onGoToField={onGoToField ? key => { close(); onGoToField(key) } : undefined}
          onOpenHistory={onOpenHistory ? id => { close(); onOpenHistory(id) } : undefined}
        />
      )}
    </DetailPopover>
  )
}

export interface PublishStatusCardProps {
  model: PublishCardModel
  /** The card has NOT closed yet when this runs; `PublishStatusView` closes it first. */
  onGoToField?: (columnKey: string) => void
  onOpenHistory?: (publicationId: string) => void
}

const SEVERITY: Record<PublishIssue['severity'], { word: string; tone: Tone }> = {
  error: { word: 'Error', tone: 'danger' },
  warning: { word: 'Warning', tone: 'warning' },
  info: { word: 'Note', tone: 'info' },
}

/**
 * The card behind a "Last publish" cell. It draws `publishCardModel` and decides nothing. Header and footer stay put;
 * the body scrolls between them (`nds-detailpop-scroll`), so a long list of refused fields never runs off screen.
 */
export function PublishStatusCard({ model, onGoToField, onOpenHistory }: PublishStatusCardProps) {
  return (
    <div className="nds-publish-card">
      <div className="nds-publish-card-head">
        <span className="nds-publish-card-title">{model.title}</span>
        <PublishStatusPill meta={model.meta} />
      </div>
      <div className="nds-publish-card-body">
        {model.headline && <p className="nds-publish-card-line nds-publish-card-strong">{model.headline}</p>}
        <p className="nds-publish-card-hint">{model.hint}</p>
        {model.rowResult && (
          <p className="nds-publish-card-line">
            <span className="nds-publish-card-strong">This row:</span> <PublishStatusPill meta={model.rowResult} /> {model.rowResult.hint}
          </p>
        )}
        {model.inFlight && (
          <p className="nds-publish-card-note">A newer publish is in progress: <span className="nds-publish-card-strong">{model.inFlight.label}</span>. {model.inFlight.hint}</p>
        )}
        {model.facts.length > 0 && (
          <dl className="nds-publish-card-facts">
            {model.facts.map(fact => (
              <div key={fact.label} className="nds-publish-card-fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {model.sentSummary && (
          <section className="nds-publish-card-section" aria-label="What was sent">
            <h3 className="nds-publish-card-gh">What was sent</h3>
            <p className="nds-publish-card-line">{model.sentSummary}</p>
            {model.sent.length > 0 && model.sent[0] !== 'Complete listing' && (
              <ul className="nds-publish-card-sent">{model.sent.map(field => <li key={field}>{field}</li>)}</ul>
            )}
          </section>
        )}
        {model.message && (
          <section className="nds-publish-card-section" aria-label="Channel message">
            <h3 className="nds-publish-card-gh">Channel message</h3>
            <p className="nds-publish-card-line nds-publish-card-message">{model.message}</p>
          </section>
        )}
        {model.issues.length > 0 && (
          <section className="nds-publish-card-section" aria-label="Problems the channel reported">
            <h3 className="nds-publish-card-gh">Problems the channel reported ({model.issues.length})</h3>
            <ul className="nds-publish-card-items">
              {model.issues.map((issue, i) => {
                const sev = SEVERITY[issue.severity] ?? SEVERITY.error
                const what = (
                  <span className="nds-publish-card-what">
                    <span className="nds-publish-card-issue-head">
                      <span className={`nds-publish-card-sev tone-${sev.tone}`}>{sev.word}</span>
                      {issue.fieldLabel && <span className="nds-publish-card-strong">{issue.fieldLabel}</span>}
                      {issue.code && <span className="nds-publish-card-code">{issue.code}</span>}
                    </span>
                    <span className="nds-publish-card-reason">{issue.message}</span>
                  </span>
                )
                return (
                  <li key={`${issue.columnKey ?? ''}:${i}`}>
                    {issue.canGoTo && onGoToField ? (
                      <button type="button" className="nds-publish-card-item" onClick={() => onGoToField(issue.columnKey as string)}>
                        {what}
                        <span className="nds-publish-card-act">Go to field<ArrowRight size={13} aria-hidden="true" /></span>
                      </button>
                    ) : (
                      <div className="nds-publish-card-item is-static">{what}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {model.editedNote && <p className="nds-publish-card-note">{model.editedNote}</p>}
      </div>
      {model.publicationId && onOpenHistory && (
        <div className="nds-publish-card-foot">
          <Button variant="link" size="sm" onClick={() => onOpenHistory(model.publicationId as string)}>
            See publish history<ArrowRight size={13} aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  )
}
