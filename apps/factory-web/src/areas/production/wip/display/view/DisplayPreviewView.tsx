'use client'

import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { LineBoardView, type LineBoardModel } from '../../../../../lib/line-board/view/LineBoardView'
import { WithMessages } from '../../../../../record-panels/i18n'
import '../../wip.css'

export interface PreviewLine {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** SCR-173 display.preview: the board as the wall shows it, with the office's own bar above it. */
export interface DisplayPreviewModel {
  readonly board: LineBoardModel
  readonly lines: readonly PreviewLine[] | null
  readonly lineId: string | null
  readonly paused: boolean
}

export interface DisplayPreviewActions {
  onLine?: (lineId: string) => void
  onStep?: (by: 1 | -1) => void
  onPause?: () => void
}

/**
 * SCR-173 display.preview — the Office's preview of a line TV (design floor.display): the same board, read as the person,
 * in a new tab. The bar above it picks the line and turns the views by hand; the wall has no bar.
 */
export function DisplayPreviewView({ model, actions }: { model: DisplayPreviewModel; actions?: DisplayPreviewActions }) {
  return (
    <WithMessages namespaces={['production-floor', 'line-board']}>
      <Preview model={model} actions={actions} />
    </WithMessages>
  )
}

function Preview({ model, actions }: { model: DisplayPreviewModel; actions?: DisplayPreviewActions }) {
  const t = useT('production-floor')
  if (model.lines && model.lines.length === 0 && !model.lineId) return <EmptyState title={t('tv.noLines.title')} description={t('tv.noLines.body')} />
  return (
    <div className="fw-fn-preview">
      <div className="fw-fn-preview-bar">
        {model.lines && model.lines.length > 1 && (
          <label className="fw-fn-tv">
            <span className="fw-pr-hint">{t('tv.line')}</span>
            <Select size="sm" value={model.lineId ?? ''} onChange={(event) => actions?.onLine?.(event.target.value)}>
              {model.lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.code} · {line.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <Button size="sm" aria-label={t('tv.previous')} onClick={() => actions?.onStep?.(-1)}>
          <ChevronLeft size={14} aria-hidden />
        </Button>
        <Button size="sm" aria-label={model.paused ? t('tv.resume') : t('tv.pause')} onClick={() => actions?.onPause?.()}>
          {model.paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />} {model.paused ? t('tv.resume') : t('tv.pause')}
        </Button>
        <Button size="sm" aria-label={t('tv.next')} onClick={() => actions?.onStep?.(1)}>
          <ChevronRight size={14} aria-hidden />
        </Button>
        <span className="fw-pr-hint">{t('tv.privacy')}</span>
      </div>
      {!model.lines && !model.lineId ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('loading')}
        </p>
      ) : (
        <LineBoardView model={model.board} />
      )}
    </div>
  )
}
