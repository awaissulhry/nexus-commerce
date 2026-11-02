'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Card, DetailPopover, EmptyState, MetricStrip, PerformanceGraph } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import type { ColDef } from '@nexus/ui/grid'
import { Button, InfoTip, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useWords } from '../../_shared/parts'
import type { LineRow, TrendLine } from '../api'
import { deltaOf, hiddenDays, lineLabel, minutesText, overviewNotes, percentText, tileFigure, tileHref, TILES, trendDomain, trendRows, type EfficiencyProblem, type TileId } from '../model'
import type { EfficiencyActions, EfficiencyModel } from './EfficiencyView'

type Props = { model: EfficiencyModel; actions?: EfficiencyActions | undefined }

/** "Reading…" for a section; a note after a second is the skeleton's own quiet job. */
export function SectionLoading({ rows = 3 }: { rows?: number }) {
  const t = useT('people-efficiency')
  return (
    <div className="fw-pp-stack tight" aria-busy="true">
      <p className="fw-pp-hint" role="status">
        <Spinner size={12} /> {t('common.loading')}
      </p>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={20} />
      ))}
    </div>
  )
}

/** A failed read in our words with Try again: never drawn as empty. */
export function SectionFailed({ title, problem, onRetry }: { title: string; problem: EfficiencyProblem; onRetry?: (() => void) | undefined }) {
  const t = useT('people-efficiency')
  const people = useWords()
  return (
    <EmptyState
      title={title}
      description={problem.ns === 'efficiency' ? t(problem.words.key, problem.words.params) : people(problem.words.key, problem.words.params)}
      action={
        <Button size="sm" onClick={() => onRetry?.()}>
          {people('common.retry')}
        </Button>
      }
    />
  )
}

export function SectionHead({ title, hint, tools, id }: { title: string; hint?: ReactNode; tools?: ReactNode; id: string }) {
  return (
    <div className="fw-ef-head">
      <div>
        <h2 className="fw-ef-h2" id={id}>
          {title}
        </h2>
        {hint ? <p className="fw-pp-hint">{hint}</p> : null}
      </div>
      {tools ? <span className="fw-pp-actions">{tools}</span> : null}
    </div>
  )
}

// ---- What you see here ---------------------------------------------------------------------------------------------------------

/**
 * Before anything is read: the level of data, who may see more and the law (B-W2b-27's rules of this site). The four roles
 * of the design in words; a lead's "own team total" is not served by the API, so the page does not claim it. With the gate
 * off the words say why no person can be shown at all.
 */
export function PrivacyPanel({ model, actions }: Props) {
  const t = useT('people-efficiency')
  const people = useWords()
  const ds = useDsWords()
  const { sight } = model
  const ready = sight.status === 'ready' ? sight.sight : null
  const law = <LawRef law={people('privacy.law')} plain={people('privacy.lawPlain')} labels={ds.lawRef} />
  return (
    <Card padded>
      <SectionHead id="fw-ef-privacy" title={t('section.privacy')} />
      {sight.status === 'loading' ? (
        <SectionLoading rows={2} />
      ) : sight.status === 'failed' ? (
        <EmptyState
          title={t('privacy.failed')}
          description={t('privacy.failedBody')}
          action={
            <Button size="sm" onClick={() => actions?.onRetrySight?.()}>
              {people('common.retry')}
            </Button>
          }
        />
      ) : sight.status === 'allSites' ? (
        <EmptyState title={t('privacy.pickSite')} description={t('privacy.pickSiteBody')} />
      ) : (
        <div className="fw-pp-stack tight">
          <PrivacyNote
            level="line"
            variant="panel"
            text={t('privacy.pill')}
            whoMore={!ready?.open ? t('privacy.gateOff') : ready.level === 'ONE_PERSON_ON_REQUEST' ? t('privacy.youOnRequest') : t('privacy.workerHr')}
            law={law}
            labels={ds.privacyNote}
          />
          <ul className="fw-pp-list">
            <li>{t('privacy.lines', { count: ready?.minimumGroupSize ?? 0 })}</li>
            <li>{t(ready?.open ? 'privacy.hrOpen' : 'privacy.hrClosed')}</li>
            <li>{t('privacy.worker')}</li>
          </ul>
        </div>
      )}
    </Card>
  )
}

// ---- tiles and how it is computed -------------------------------------------------------------------------------------------

const FORMULAS = ['line', 'onStandard', 'planned', 'earned', 'actual'] as const
const SOURCES = ['scans', 'blocks', 'days', 'standards'] as const
const EXCLUSIONS = ['trainees', 'oneTap', 'offStandard', 'outside', 'groups'] as const

/** The how panel: our words for the API's `how`, one for one (the test holds the counts equal). */
export const HOW_COUNTS = { formulas: FORMULAS.length, sources: SOURCES.length, exclusions: EXCLUSIONS.length }

function HowPanel({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  const t = useT('people-efficiency')
  return (
    <DetailPopover trigger={<span className="fw-ef-link">{t('how.title')}</span>} triggerLabel={t('how.title')} label={t('how.title')} hoverDelay={0} open={open} onOpenChange={onOpen} panelClassName="nds-detailpop-scroll">
      <div className="fw-ef-how">
        <h3 className="fw-ef-h3">{t('how.formulas')}</h3>
        <ul className="fw-pp-list">
          {FORMULAS.map((key) => (
            <li key={key}>{t(`how.formula.${key}`)}</li>
          ))}
        </ul>
        <h3 className="fw-ef-h3">{t('how.sources')}</h3>
        <ul className="fw-pp-list">
          {SOURCES.map((key) => (
            <li key={key}>{t(`how.source.${key}`)}</li>
          ))}
        </ul>
        <h3 className="fw-ef-h3">{t('how.exclusions')}</h3>
        <ul className="fw-pp-list">
          {EXCLUSIONS.map((key) => (
            <li key={key}>{t(`how.exclusion.${key}`)}</li>
          ))}
        </ul>
      </div>
    </DetailPopover>
  )
}

export function TilesPanel({ model, actions, how, onHow }: Props & { how: boolean; onHow: (open: boolean) => void }) {
  const t = useT('people-efficiency')
  const locale = useLocale()
  const read = model.overview
  const overview = read.status === 'ready' ? read.value : null
  const figure = (tile: TileId, value: string | null | undefined) => (tile === 'efficiency' || tile === 'onStandard' ? percentText(value, locale) : minutesText(value, locale))
  return (
    <Card padded>
      <SectionHead
        id="fw-ef-tiles"
        title={t('section.tiles')}
        hint={overview ? t('tiles.period', { from: formatDate(`${overview.from}T12:00:00Z`, { locale }), to: formatDate(`${overview.to}T12:00:00Z`, { locale }) }) : null}
        tools={<HowPanel open={how} onOpen={onHow} />}
      />
      {read.status === 'error' ? (
        <SectionFailed title={t('tiles.failed')} problem={read.problem} onRetry={actions?.onRetry} />
      ) : read.status === 'idle' ? (
        <p className="fw-pp-hint">{t('common.waitsForPrivacy')}</p>
      ) : !overview ? (
        <SectionLoading rows={1} />
      ) : (
        <div className="fw-pp-stack tight">
          <MetricStrip
            metrics={TILES.map((tile) => {
              const value = tileFigure(overview.tiles, tile)
              const delta = overview.previous ? deltaOf(value, tileFigure(overview.previous.tiles, tile), tile === 'efficiency' || tile === 'onStandard' ? 'points' : 'minutes', locale) : null
              const href = tileHref(tile, model.prefix)
              return {
                label: t(`tile.${tile}`),
                value: figure(tile, value),
                hint: t(`tileHint.${tile}`),
                ...(delta ? { delta: { value: t('tiles.delta', { delta }), tone: 'neutral' as const } } : {}),
                ...(href ? { href } : {}),
              }
            })}
          />
          {overview.previous && (
            <p className="fw-pp-hint">
              {t(overview.previous.tiles ? 'tiles.comparedWith' : 'tiles.nothingBefore', { from: formatDate(`${overview.previous.from}T12:00:00Z`, { locale }), to: formatDate(`${overview.previous.to}T12:00:00Z`, { locale }) })}
            </p>
          )}
          <NotesList notes={overviewNotes(overview)} />
        </div>
      )}
    </Card>
  )
}

function NotesList({ notes }: { notes: readonly { key: string; count?: number }[] }) {
  const t = useT('people-efficiency')
  if (notes.length === 0) return null
  return (
    <ul className="fw-pp-list">
      {notes.map((note) => (
        <li key={note.key}>{t(note.key, note.count === undefined ? {} : { count: note.count })}</li>
      ))}
    </ul>
  )
}

// ---- lines over time ---------------------------------------------------------------------------------------------------------

function LineChart({ line }: { line: TrendLine }) {
  const t = useT('people-efficiency')
  const locale = useLocale()
  const rows = useMemo(() => trendRows(line, (date) => formatDate(`${date}T12:00:00Z`, { locale }).slice(0, 5)), [line, locale])
  const domain = trendDomain(rows)
  const hidden = hiddenDays(line)
  const percent = (value: number) => percentText(String(value), locale)
  const name = lineLabel(line.line) ?? t('lines.noLine')
  return (
    <section className="fw-ef-chart" aria-label={t('trend.chartOf', { line: name })}>
      <h3 className="fw-ef-h3">{name}</h3>
      <PerformanceGraph
        data={rows}
        xKey="day"
        height={200}
        left={{ key: 'efficiency', label: t('trend.efficiency'), color: chart.actual, axis: 'left', domain, format: percent }}
        right={{ key: 'target', label: t('trend.target'), color: chart.reference, axis: 'right', domain, format: percent }}
      />
      {hidden > 0 && <p className="fw-pp-hint">{t('trend.hiddenDays', { count: hidden })}</p>}
      {line.targetPercent === null && <p className="fw-pp-hint">{t('trend.noTarget')}</p>}
    </section>
  )
}

export function TrendPanel({ model, actions }: Props) {
  const t = useT('people-efficiency')
  const read = model.trend
  const attendanceOff = model.overview.status === 'ready' && !model.overview.value.attendance.open
  return (
    <Card padded>
      <SectionHead id="fw-ef-trend" title={t('section.trend')} hint={t('trend.hint')} />
      {read.status === 'error' ? (
        <SectionFailed title={t('trend.failed')} problem={read.problem} onRetry={actions?.onRetry} />
      ) : read.status === 'idle' ? (
        <p className="fw-pp-hint">{t('common.waitsForPrivacy')}</p>
      ) : read.status === 'loading' ? (
        <SectionLoading />
      ) : attendanceOff ? (
        <EmptyState title={t('trend.noAttendance')} description={t('notes.attendanceOff')} />
      ) : read.value.lines.length === 0 ? (
        <EmptyState title={t('trend.empty')} />
      ) : (
        <div className="fw-ef-charts">
          {read.value.lines.map((line) => (
            <LineChart key={line.line?.id ?? 'none'} line={line} />
          ))}
        </div>
      )}
    </Card>
  )
}

// ---- lines -------------------------------------------------------------------------------------------------------------------

/** One row per line: a group under the minimum shows "—" and says why; nothing sorts, so nothing ranks. */
export function LinesPanel({ model, actions }: Props) {
  const t = useT('people-efficiency')
  const locale = useLocale()
  const read = model.overview
  const rows = read.status === 'ready' ? read.value.lines : read.status === 'error' ? [] : null
  const columns = useMemo<ColDef<LineRow>[]>(() => {
    const cell = (colId: string, headerName: string, value: (row: LineRow) => string): ColDef<LineRow> => ({ colId, headerName, sortable: false, minWidth: 96, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? (params.data.tooFew ? '—' : value(params.data)) : '') })
    return [
      { colId: 'line', headerName: t('lines.line'), sortable: false, minWidth: 180, flex: 1.5, valueGetter: (params) => (params.data ? (lineLabel(params.data.line) ?? t('lines.noLine')) : '') },
      {
        colId: 'people',
        headerName: t('lines.people'),
        sortable: false,
        minWidth: 130,
        flex: 0.8,
        valueGetter: (params) => (params.data ? (params.data.tooFew ? t('tooFew.short') : String(params.data.people ?? '—')) : ''),
        cellRenderer: (params: { data?: LineRow; value?: string }) => (params.data?.tooFew ? <Tag tone="neutral">{params.value}</Tag> : params.value),
      },
      cell('efficiency', t('tile.efficiency'), (row) => percentText(row.figures.efficiency, locale)),
      cell('onStandard', t('tile.onStandard'), (row) => percentText(row.figures.onStandardEfficiency, locale)),
      cell('planned', t('lines.planned'), (row) => percentText(row.figures.plannedEfficiency, locale)),
      cell('earned', t('tile.earned'), (row) => minutesText(row.figures.earnedMinutes, locale)),
      cell('attended', t('tile.attended'), (row) => minutesText(row.figures.attendedMinutes, locale)),
      cell('offStandard', t('tile.offStandard'), (row) => minutesText(row.figures.offStandardMinutes, locale)),
    ]
  }, [t, locale])
  return (
    <div id="fw-ef-lines" className="fw-ef-anchor">
      <ListFrame<LineRow>
        label={t('lines.tableLabel')}
        title={t('section.lines')}
        rows={rows}
        rowId={(row) => row.line?.id ?? 'none'}
        columns={columns}
        count={rows ? t('lines.count', { count: rows.length }) : t('common.loading')}
        tools={<b className="fw-ef-list-title">{t('section.lines')}</b>}
        listKey="people.efficiency.lines"
        state={
          read.status === 'error' ? (
            <SectionFailed title={t('lines.failed')} problem={read.problem} onRetry={actions?.onRetry} />
          ) : read.status === 'idle' ? (
            <EmptyState title={t('common.waitsForPrivacy')} />
          ) : rows && rows.length === 0 ? (
            <EmptyState title={t('lines.empty')} />
          ) : null
        }
      />
      {model.prefix && read.status === 'ready' && read.value.hiddenGroups > 0 && model.can.settings && (
        <p className="fw-pp-hint">
          <Link href={`${model.prefix}/people/settings`}>{t('tooFew.settings')}</Link> <InfoTip tip={t('tooFew.why')} />
        </p>
      )}
    </div>
  )
}
