'use client'

import { useMemo } from 'react'
import { ArrowLeft, CalendarX2, Download } from 'lucide-react'
import { Banner, Disclosure, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { PlanningBoard } from '@nexus/ui/patterns/planning-board/index'
import { ExportJobDialog } from '../../../../../list-frame/tools/dialogs'
import type { ExportJob, ToolsProblem } from '../../../../../list-frame/tools/transport'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { BOARD_KIT_NAMESPACE, useBoardWords } from '../../../../_shared/planning-board/words'
import { laneKeyOf } from '../../model'
import type { Loaded } from '../../view-model'
import type { VersionBoard } from '../api'
import { DEPTH_NAMESPACE, drawVersion, spanWords, versionBand, type DepthWords } from '../model'
import '../../board.css'
import '../depth.css'

/** The published version tab (design tab:version "Published version v12 (read-only)", SCR-408; B-W2b-337 on B-W2b-329). */
export interface VersionTabModel {
  prefix: string
  read: Loaded<VersionBoard> | { status: 'notFound' }
  /** The site's day (the today column); null until read. */
  today: string | null
  offline: boolean
  mayExport: boolean
  exportJob: { job: ExportJob | null; problem: ToolsProblem | null } | null
}

export interface VersionTabActions {
  onRetry?: () => void
  onExport?: () => void
  onExportDownload?: () => void
  onExportAgain?: () => void
  onCloseExport?: () => void
}

/**
 * What the floor was given, read-only, beside the working plan: the version's bars on the DS board (no move, no pin, no
 * publish), each saying its state on the floor now and where the working plan has it now (moved, or taken off), the band in
 * words ("Since v12 the working plan has 1 moved, 0 added, 0 removed on its days"), the bars the working plan added, and
 * Export this version (XLSX). Opened in a new tab from the board (its published versions, its plan line).
 */
export function VersionTabView({ model, actions }: { model: VersionTabModel; actions?: VersionTabActions }) {
  return (
    <WithMessages namespaces={[DEPTH_NAMESPACE, BOARD_KIT_NAMESPACE, 'lists']}>
      <VersionBody model={model} actions={actions} />
    </WithMessages>
  )
}

function VersionBody({ model, actions }: { model: VersionTabModel; actions?: VersionTabActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const kit = useBoardWords()
  const board = model.read.status === 'ready' ? model.read.value : null
  const words = useMemo<DepthWords>(() => ({ t, locale, timeZone: board?.site.timeZone ?? 'Europe/Rome' }), [t, locale, board?.site.timeZone])
  const drawn = useMemo(() => (board ? drawVersion(board, model.today ?? board.version.coversFrom, words) : null), [board, model.today, words])
  const band = board ? versionBand(board, words) : null
  const exportHeld = !model.mayExport ? t('version.exportHeld') : model.offline ? t('held.offline') : !board ? t('held.reading') : null
  const back = `${model.prefix}/planning/board`
  return (
    <div className="fw-pb">
      <div className="fw-pb-band">
        <div className="fw-pb-scope">
          <h1 className="fw-pbd-h1">{board ? t('version.title', { version: board.version.number }) : t('version.titlePlain')}</h1>
          <Tag tone="neutral">{t('version.readOnly')}</Tag>
          {board ? <span className="fw-pb-status">{`${board.site.code} · ${board.site.name}`}</span> : null}
        </div>
        <div className="fw-pb-actions">
          <Button size="sm" variant="quiet" asChild>
            <a href={back}>
              <ArrowLeft size={14} aria-hidden /> {t('version.back')}
            </a>
          </Button>
          <Button size="sm" variant="secondary" heldReason={exportHeld} onClick={() => actions?.onExport?.()}>
            <Download size={14} aria-hidden /> {t('version.export')}
          </Button>
        </div>
      </div>
      {model.read.status === 'loading' ? (
        <div className="fw-pb-skeleton" aria-busy="true" aria-label={t('version.reading')}>
          <Skeleton width="40%" />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      ) : model.read.status === 'notFound' ? (
        <EmptyState icon={<CalendarX2 size={28} aria-hidden />} title={t('version.notFound')} description={t('version.notFoundBody')} />
      ) : model.read.status === 'error' ? (
        <EmptyState
          icon={<CalendarX2 size={28} aria-hidden />}
          title={t('version.errorTitle')}
          description={t(`error.${model.read.problem}`)}
          action={
            model.read.problem === 'forbidden' ? undefined : (
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('dialog.retry')}
              </Button>
            )
          }
        />
      ) : board && drawn && band ? (
        <>
          <Banner tone={board.floor === 'REPLACED' ? 'neutral' : 'info'} title={band.title}>
            {band.compare}
          </Banner>
          {board.version.note ? <p className="fw-pb-hint">{t('version.note', { note: board.version.note })}</p> : null}
          <section className="fw-pb-board" aria-labelledby="fw-pbd-version">
            <div className="fw-pb-section-head">
              <h2 className="fw-pb-h2" id="fw-pbd-version">
                {t('version.board')}
              </h2>
              <span className="fw-pb-hint">{t('version.boardHint')}</span>
            </div>
            <PlanningBoard
              label={t('version.label', { version: board.version.number, site: board.site.name })}
              lanes={drawn.lanes}
              buckets={drawn.buckets}
              cards={drawn.cards}
              tray={false}
              cellDetails={false}
              heldReason={t('version.held', { version: board.version.number })}
              words={{ ...kit.board, empty: t('version.empty') }}
              loadWords={kit.load}
              locale={INTL_LOCALE[locale]}
            />
          </section>
          {board.compare.addedSlots.length > 0 ? (
            <Disclosure summary={t('version.added', { count: board.compare.addedSlots.length, bars: String(board.compare.addedSlots.length) })}>
              <ul className="fw-pbd-list">
                {board.compare.addedSlots.map((slot) => {
                  const lane = board.lanes.find((entry) => laneKeyOf(entry) === laneKeyOf(slot.lane))
                  return <li key={slot.id}>{t('version.addedOne', { lane: lane?.code ?? '—', when: spanWords(slot.startAt, slot.endAt, words) })}</li>
                })}
              </ul>
            </Disclosure>
          ) : null}
          <p className="fw-pb-hint">{t('version.legend')}</p>
        </>
      ) : null}
      {model.exportJob ? (
        model.exportJob.job ? (
          <ExportJobDialog job={model.exportJob.job} problem={model.exportJob.problem} onDownload={() => actions?.onExportDownload?.()} onAgain={() => actions?.onExportAgain?.()} onClose={() => actions?.onCloseExport?.()} />
        ) : model.exportJob.problem ? (
          <Banner tone="danger" title={t('export.failed')} />
        ) : null
      ) : null}
    </div>
  )
}
