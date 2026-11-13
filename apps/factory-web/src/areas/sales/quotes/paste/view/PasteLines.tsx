'use client'

import { Banner, Field } from '@nexus/ui/components'
import type { ReviewPanelChange } from '@nexus/ui/patterns'
import { Tag } from '@nexus/ui/primitives'
import { ReviewChangesModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NS, reviewStateOf, sizesText, type DepthReviewState } from '../../record/lines-depth/model'
import { useDepthWords } from '../../record/lines-depth/words'
import type { PasteAnswer } from '../api'
import { leftOutWords, pasteColumns, pasteParts, PASTE_SAMPLE } from '../model'
import '../../record/lines-depth/depth.css'

export interface PasteLinesModel {
  /** The cells as pasted. */
  text: string
  /** What lands, row by row, for this text (the API's preview); null until asked. */
  preview: PasteAnswer | null
  state: DepthReviewState
}

export interface PasteLinesActions {
  onText?: (text: string) => void
  onSave?: () => void
  onClose?: () => void
  onRetry?: () => void
}

/**
 * SCR-416 — Paste lines (design pop:quotes.pasteLines, from Lines › Add a style; SAL-160): the paste area, the columns it
 * names (Style, Colourway, an optional Price, the sizes) read before anything is asked, then the review — each row that
 * lands (a new line or new pieces for a line on the quote) old → new, what could not land counted and said in words — and
 * "Add N lines" writes the same paste (B-W2b-302's POST …/lines/paste without `preview`). A price lands on a new line only.
 */
export function PasteLines({ model, actions }: { model: PasteLinesModel; actions?: PasteLinesActions }) {
  return (
    <WithMessages namespaces={['sales', DEPTH_NS]}>
      <Paste model={model} actions={actions} />
    </WithMessages>
  )
}

function Paste({ model, actions }: { model: PasteLinesModel; actions?: PasteLinesActions }) {
  const { t, say } = useDepthWords()
  const columns = pasteColumns(model.text)
  const { landing, skipped } = pasteParts(model.preview)
  const leftCells = landing.flatMap((row) => row.leftOut.map((entry) => ({ row: row.row, entry })))
  const changes: ReviewPanelChange[] = landing.map((row) => ({
    id: String(row.row),
    where: t('paste.where', { row: row.row, style: row.style, colourway: row.colourway }),
    what: t(row.action === 'ADD' ? 'paste.what.add' : 'paste.what.change'),
    now: row.before ? sizesText(row.before) || '—' : t('paste.notThere'),
    next: sizesText(row.after ?? row.sizes) || '—',
    note: [row.priceFrom ? t(`paste.price.${row.priceFrom}`) : null, ...row.leftOut.map((entry) => say(leftOutWords(entry, row.row)))].filter(Boolean).join(' · '),
  }))
  const counts = model.preview?.counts ?? null
  const leadHeld = model.text.trim() === '' ? t('paste.held.empty') : columns?.problem ? say(columns.problem) : null
  const lead = (
    <div className="fw-qd-lead">
      <Field label={t('paste.area')} hint={t('paste.areaHint')}>
        <Textarea value={model.text} onChange={(event) => actions?.onText?.(event.target.value)} rows={6} placeholder={PASTE_SAMPLE} autoFocus spellCheck={false} className="fw-qd-paste" />
      </Field>
      {columns &&
        (columns.problem ? (
          <Banner tone="warning" title={say(columns.problem)} />
        ) : (
          <p className="fw-q-hint" role="status">
            {t('paste.columns', { sizes: columns.sizes.join(' · '), rows: columns.rows })} {columns.price ? t('paste.columnsPrice') : ''}
          </p>
        ))}
      {counts && (
        <p className="fw-qd-counts" role="status">
          <Tag tone="success">{t('paste.count.added', { count: counts.added })}</Tag> <Tag tone="info">{t('paste.count.changed', { count: counts.changed })}</Tag>{' '}
          {counts.skipped > 0 && <Tag tone="warning">{t('paste.count.skipped', { count: counts.skipped })}</Tag>} {counts.cellsLeftOut > 0 && <Tag tone="warning">{t('paste.count.cells', { count: counts.cellsLeftOut })}</Tag>}
        </p>
      )}
      {(skipped.length > 0 || leftCells.length > 0) && (
        <Banner tone="warning" title={t('paste.leftTitle', { count: skipped.length + leftCells.length })}>
          <ul className="fw-q-list">
            {skipped.flatMap((row) => row.leftOut.map((entry, index) => <li key={`s-${row.row}-${index}`}>{say(leftOutWords(entry, row.row))}</li>))}
            {leftCells.map(({ row, entry }, index) => (
              <li key={`c-${row}-${index}`}>{say(leftOutWords(entry, row))}</li>
            ))}
          </ul>
        </Banner>
      )}
    </div>
  )
  return (
    <ReviewChangesModal
      open
      size="xl"
      onClose={() => actions?.onClose?.()}
      title={t('paste.title')}
      summary={t('paste.summary')}
      changes={changes}
      state={reviewStateOf(model.state, say)}
      lead={lead}
      leadHeld={leadHeld}
      saveLabel={t('paste.save', { added: counts?.added ?? 0, changed: counts?.changed ?? 0 })}
      onSave={() => actions?.onSave?.()}
      onRetry={() => actions?.onRetry?.()}
      doneVerb={t('review.verb.saved')}
    />
  )
}
