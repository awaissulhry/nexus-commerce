'use client'

import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { DuplicateCandidate, ImportDuplicateRow, ImportDuplicates } from '../api'
import { askOfRow, likelihoodTone, NAMESPACE, shownRows, type MergeAsk } from '../model'
import { DupMessages, ReasonTags, RecordLink } from './parts'

/**
 * "Possible duplicates" in the import wizard (B-W2b-427, SCR-622; design admin.import wizard step 3 "possible duplicates
 * W2b"): the sheet's new rows that look like a record already there, or like an earlier row of the same sheet, each with
 * its reasons and the record as a link. In the check nothing is written: the person fixes the sheet (the code of the
 * record already there makes the row an update) or applies. After the apply each new record may be merged into the one
 * it looks like (Merge…, a person's decision; the merge dialog says what moves). Nothing is drawn for an importer whose
 * records are not checked, nor when nothing looks alike.
 */

export interface ImportDuplicatesModel {
  readonly state: 'loading' | 'error' | 'ready'
  readonly answer: ImportDuplicates | null
  /** check: the dry run (nothing written); result: after the apply (merge offered). */
  readonly phase: 'check' | 'result'
  readonly prefix: string
  readonly canMerge: boolean
  readonly problem?: string | null
}

export interface ImportDuplicatesActions {
  onRetry?: () => void
  onMerge?: (ask: MergeAsk) => void
}

export function ImportDuplicatesPanel({ model, actions }: { model: ImportDuplicatesModel; actions?: ImportDuplicatesActions }) {
  if (model.state === 'ready' && shownRows(model.answer).length === 0) return null
  return (
    <DupMessages>
      <PanelInner model={model} actions={actions} />
    </DupMessages>
  )
}

interface Line {
  readonly id: string
  readonly row: ImportDuplicateRow
  readonly candidate: DuplicateCandidate | null
  readonly sheet: ImportDuplicateRow['sameSheet'][number] | null
}

function linesOf(rows: readonly ImportDuplicateRow[]): Line[] {
  return rows.flatMap((row) => [
    ...row.candidates.map((candidate) => ({ id: `${row.rowNumber}:${candidate.id}`, row, candidate, sheet: null })),
    ...row.sameSheet.map((sheet) => ({ id: `${row.rowNumber}:row${sheet.rowNumber}`, row, candidate: null, sheet })),
  ])
}

function PanelInner({ model, actions }: { model: ImportDuplicatesModel; actions?: ImportDuplicatesActions }) {
  const t = useT(NAMESPACE)
  if (model.state === 'loading')
    return (
      <section className="fw-dup-section" aria-label={t('dup.import.title')} aria-busy="true">
        <h3 className="fw-dup-h">{t('dup.import.title')}</h3>
        <div className="fw-dup-skeleton">
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      </section>
    )
  if (model.state === 'error')
    return (
      <section className="fw-dup-section" aria-label={t('dup.import.title')}>
        <h3 className="fw-dup-h">{t('dup.import.title')}</h3>
        <Banner
          tone="warning"
          title={t('dup.import.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('dup.retry')}
            </Button>
          }
        />
      </section>
    )
  const answer = model.answer!
  const rows = shownRows(answer)
  const lines = linesOf(rows)
  const result = model.phase === 'result'
  const recordType = answer.recordType ?? 'PARTY'
  const columns = [t('dup.col.row'), t('dup.col.sheet'), t('dup.col.looksLike'), t('dup.col.why'), ...(result ? [t('dup.col.action')] : [])]
  return (
    <section className="fw-dup-section" aria-label={t('dup.import.title')}>
      <h3 className="fw-dup-h">{t('dup.import.count', { count: rows.length })}</h3>
      <p className="fw-dup-hint">{t(result ? 'dup.import.resultHint' : 'dup.import.checkHint')}</p>
      <div className="fw-dup-table">
        <SummaryTable
          label={t('dup.import.title')}
          columns={columns}
          widths={result ? ['7%', '20%', '30%', '28%', '15%'] : ['8%', '22%', '34%', '36%']}
          align={result ? ['left', 'left', 'left', 'left', 'right'] : ['left', 'left', 'left', 'left']}
          density="roomy"
          stackOnPhone
          rows={lines.map((line) => {
            const ask = line.candidate ? askOfRow(recordType, line.row, line.candidate) : line.sheet?.recordId && line.row.recordId ? { recordType, kept: { id: line.sheet.recordId, code: line.sheet.key ?? '' }, dropped: { id: line.row.recordId, code: line.row.key ?? '' } } : null
            const merge = result ? (
              ask ? (
                <Button key="merge" size="sm" heldReason={model.canMerge ? null : t('dup.held.noRight')} onClick={() => actions?.onMerge?.(ask)}>
                  {t('dup.import.merge')}
                </Button>
              ) : (
                <span key="merge" className="fw-dup-hint">
                  {t('dup.import.notMade')}
                </span>
              )
            ) : null
            return {
              id: line.id,
              cells: [
                String(line.row.rowNumber),
                <span key="sheet" className="fw-dup-record">
                  <span className="fw-dup-code">{line.row.key ?? '—'}</span>
                  {line.row.name && <span className="fw-dup-name">{line.row.name}</span>}
                </span>,
                line.candidate ? (
                  <RecordLink key="like" prefix={model.prefix} record={line.candidate} newTab />
                ) : (
                  <span key="like" className="fw-dup-record">
                    <span>{t('dup.import.sameSheet', { row: line.sheet!.rowNumber })}</span>
                    {line.sheet!.key && <span className="fw-dup-code">{line.sheet!.key}</span>}
                  </span>
                ),
                <span key="why" className="fw-dup-record">
                  <Pill tone={likelihoodTone(line.candidate?.likelihood ?? line.sheet!.likelihood)}>
                    {t(`dup.likelihood.${line.candidate?.likelihood ?? line.sheet!.likelihood}`)}
                  </Pill>
                  <ReasonTags reasons={line.candidate?.reasons ?? line.sheet!.reasons} />
                </span>,
                ...(merge ? [merge] : []),
              ],
            }
          })}
        />
      </div>
      {answer.more && <p className="fw-dup-hint">{t('dup.import.more', { count: answer.checked })}</p>}
    </section>
  )
}
