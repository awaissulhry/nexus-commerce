'use client'

import { useMemo } from 'react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { NexusGrid, SHEET_GRID_OPTIONS, type ColDef, type ColGroupDef, type ICellRendererParams } from '@nexus/ui/grid'
import { sizeColumns } from '@nexus/ui/grid/size-columns/index'
import { Button, Input, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import type { RoundView } from '../../api'
import { fitCellEditable, fitHeld, fitRowsOf, signedText, type FitRow } from '../../model'
import { useWords } from '../../parts'
import type { SampleRecordActions, SampleRecordModel } from '../view-model'

const decimal = (value: string, locale: 'it' | 'en') => (locale === 'it' ? value.replace('.', ',') : value)

/** "56 ± 1" or "56 −0.5 / +1" in the page's language. */
export function specText(spec: { nominal: string; toleranceMinus: string; tolerancePlus: string } | null, locale: 'it' | 'en'): string {
  if (!spec) return '—'
  const minus = decimal(spec.toleranceMinus, locale)
  const plus = decimal(spec.tolerancePlus, locale)
  return spec.toleranceMinus === spec.tolerancePlus ? `${decimal(spec.nominal, locale)} ± ${plus}` : `${decimal(spec.nominal, locale)} −${minus} / +${plus}`
}

/**
 * Fit & comments (design rec tab sample.fit, PRD-070; autosave per cell): the pinned revision's live spec per point of
 * measure × the round's sizes — the spec and its tolerance, the measured value (SizeColumns: typed or pasted, a word is
 * refused), the difference in the tone of inside or outside; the values outside their tolerance listed above the grid.
 * Each cell saves alone (its nominal and tolerances are frozen when first written); read-only it says why. Fit comments
 * per point or body area, resolved or open (photos through the round's files; carrying them to the next round is Later).
 */
export function FitTab({ model, round, actions }: { model: SampleRecordModel; round: RoundView; actions?: SampleRecordActions }) {
  const { t, say, locale } = useWords()
  const ds = useDsWords()
  const offline = model.live === 'offline'
  const fit = model.fit.part.value
  const rows = useMemo(() => (fit ? fitRowsOf(fit) : []), [fit])
  const held = fit ? fitHeld(fit, model.can, offline) : null
  const intl = INTL_LOCALE[locale]

  const columns = useMemo<Array<ColDef<FitRow> | ColGroupDef<FitRow>>>(() => {
    if (!fit) return []
    const PointCell = ({ data }: ICellRendererParams<FitRow>) =>
      data ? (
        <span className="fw-smp-cell">
          <span className="fw-smp-code">{data.code}</span>
          <span className="fw-smp-hint">
            {data.name} · {data.uom}
            {!data.inSpec ? ` · ${t('fit.notInSpec')}` : ''}
          </span>
        </span>
      ) : null
    const groups: ColGroupDef<FitRow>[] = fit.sizes.map((size) => {
      const DiffCell = ({ data }: ICellRendererParams<FitRow>) => {
        const measured = data?.cells[size]?.measurement
        if (!measured || measured.difference === null) return <span className="fw-smp-hint">—</span>
        return <Tag tone={measured.pass === false ? 'danger' : 'success'}>{`${signedText(measured.difference, locale)} · ${t(measured.pass === false ? 'fit.outside' : 'fit.inside')}`}</Tag>
      }
      const measured = sizeColumns<FitRow>({
        sizes: [size],
        base: null,
        value: (row, at) => row.cells[at]?.measurement?.measured ?? null,
        editable: (row, at) => fitCellEditable(fit, row, at, model.can, offline),
        // Not measured yet is no error (a fit session fills the grid as it goes): "—", not "— missing".
        required: false,
        onChange: (row, at, value) => row.pointOfMeasureId && actions?.onFitCell?.(row.pointOfMeasureId, at, value),
        onRefused: (_row, at, text) => actions?.onFitRefused?.(at, text),
        scale: 2,
        locale: intl,
        colIdPrefix: 'measured:',
        cellLabel: (row, at) => t('fit.cellLabel', { pom: row.name, size: at }),
        labels: ds.sizeColumns,
      }).map((column) => ({ ...column, headerName: t('fit.measured'), headerTooltip: t('fit.measuredTip', { size }) }))
      return {
        groupId: `size:${size}`,
        headerName: t('fit.size', { size }),
        children: [
          { colId: `spec:${size}`, headerName: t('fit.spec'), minWidth: 120, flex: 1, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => (params.data ? specText(params.data.cells[size]?.spec ?? params.data.cells[size]?.measurement ?? null, locale) : '') },
          ...measured,
          { colId: `diff:${size}`, headerName: t('fit.difference'), minWidth: 140, flex: 1, sortable: false, suppressHeaderMenuButton: true, cellRenderer: DiffCell },
        ],
      }
    })
    return [{ colId: 'point', headerName: t('fit.point'), pinned: 'left', minWidth: 200, flex: 1.4, sortable: false, valueGetter: (params) => params.data?.code ?? '', cellRenderer: PointCell }, ...groups]
  }, [fit, model.can, offline, actions, t, locale, intl, ds.sizeColumns])

  if (model.fit.part.problem && !fit)
    return (
      <Banner
        tone="danger"
        title={t('fit.failed')}
        action={
          <Button size="sm" variant="quiet" onClick={() => actions?.onFitRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t(model.fit.part.problem)}
      </Banner>
    )
  if (!fit)
    return (
      <div className="fw-smp-stack" aria-busy="true">
        <Skeleton height={24} width="30%" />
        <Skeleton height={200} />
      </div>
    )

  const saving = Object.values(model.fit.cells).filter((state) => state === 'saving').length
  const comment = model.fit.comment
  const commentHeld = !model.can.measure ? t('held.noMeasure') : !fit.editable ? say(held) : offline ? t('held.offline') : !comment.text.trim() ? t('fit.comment.held') : comment.busy ? t('common.working') : null
  const pointName = (id: string | null) => rows.find((row) => row.pointOfMeasureId === id)?.code ?? null

  return (
    <div className="fw-smp-stack">
      <Card padded>
        <div className="fw-smp-cardhead">
          <h2 className="fw-smp-h2">{t('fit.title')}</h2>
          <span className="fw-smp-hint" role="status">
            {saving > 0 ? (
              <>
                <Spinner size={12} /> {t('fit.saving', { count: saving })}
              </>
            ) : model.fit.savedAt ? (
              t('fit.saved', { time: formatTime(model.fit.savedAt, { locale }) })
            ) : (
              t('fit.measuredCount', { count: fit.measuredCount })
            )}
          </span>
        </div>
        <p className="fw-smp-hint">{fit.spec ? t('fit.specOf', { revision: round.revision.revision, status: t(`spec.${fit.spec.status}`), base: fit.spec.baseSize }) : t('refusal.NO_SPEC')}</p>
        {held && <Banner tone="info" title={t('fit.readOnly', { reason: say(held) ?? '' })} />}
        {model.fit.failed && <Banner tone="danger" title={say(model.fit.failed)} />}
        {fit.outside.length > 0 && (
          <Banner tone="warning" title={t('fit.outsideTitle', { count: fit.outside.length })}>
            <ul className="fw-smp-lines">
              {fit.outside.map((line) => (
                <li key={`${line.pomCode}/${line.size}`}>{t('fit.outsideLine', { pom: line.pomCode, size: line.size, measured: decimal(line.measured, locale), nominal: decimal(line.nominal, locale), difference: signedText(line.difference, locale) })}</li>
              ))}
            </ul>
          </Banner>
        )}
        {rows.length === 0 || fit.sizes.length === 0 ? (
          <EmptyState title={t('fit.empty')} description={fit.spec ? t('fit.emptyBody') : t('refusal.NO_SPEC')} />
        ) : (
          <div className="fw-smp-grid" role="region" aria-label={t('fit.title')}>
            <NexusGrid<FitRow> {...SHEET_GRID_OPTIONS} rowData={rows} columnDefs={columns} getRowId={(params) => params.data.id} cellSelection domLayout="autoHeight" />
          </div>
        )}
        <p className="fw-smp-hint">{t('fit.hint')}</p>
      </Card>
      <Card padded>
        <h2 className="fw-smp-h2">{t('fit.comments', { count: fit.openComments })}</h2>
        {fit.comments.length === 0 ? (
          <p className="fw-smp-hint">{t('fit.noComments')}</p>
        ) : (
          <SummaryTable
            label={t('fit.commentsLabel')}
            density="roomy"
            stackOnPhone
            columns={[t('fit.col.comment'), t('fit.col.where'), t('fit.col.photos'), t('fit.col.by'), t('fit.col.state'), t('fit.col.actions')]}
            rows={fit.comments.map((one) => ({
              id: one.id,
              cells: [
                one.text,
                one.pomCode ?? pointName(one.pointOfMeasureId) ?? one.bodyArea ?? t('fit.wholeSample'),
                one.photos.length > 0 ? t('fit.photos', { count: one.photos.length }) : '—',
                one.createdBy ? t('fit.byOn', { name: one.createdBy.name, when: formatDateTime(one.createdAt, { locale }) }) : formatDateTime(one.createdAt, { locale }),
                one.resolved ? <Tag key="s" tone="success">{t('fit.resolved')}</Tag> : <Tag key="s" tone="warning">{t('fit.open')}</Tag>,
                <span key="a" className="fw-smp-actions">
                  <Button size="sm" variant="quiet" heldReason={!model.can.measure ? t('held.noMeasure') : offline ? t('held.offline') : model.fit.working === one.id ? t('common.working') : null} onClick={() => actions?.onCommentResolve?.(one.id, !one.resolved)}>
                    {one.resolved ? t('fit.reopen') : t('fit.resolve')}
                  </Button>
                  <Button size="sm" variant="quiet" heldReason={!model.can.measure ? t('held.noMeasure') : !fit.editable ? say(held) : offline ? t('held.offline') : model.fit.working === one.id ? t('common.working') : null} onClick={() => actions?.onCommentRemove?.(one.id)}>
                    {t('fit.remove')}
                  </Button>
                </span>,
              ],
            }))}
          />
        )}
        <div className="fw-smp-form-grid">
          <Field label={t('fit.comment.point')}>
            <Select size="sm" value={comment.pointOfMeasureId} onChange={(event) => actions?.onComment?.({ pointOfMeasureId: event.target.value })}>
              <option value="">{t('fit.comment.noPoint')}</option>
              {rows
                .filter((row) => row.inSpec && row.pointOfMeasureId)
                .map((row) => (
                  <option key={row.id} value={row.pointOfMeasureId!}>
                    {row.code} · {row.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('fit.comment.area')} hint={t('fit.comment.areaHint')}>
            <Input size="sm" value={comment.bodyArea} maxLength={100} onChange={(event) => actions?.onComment?.({ bodyArea: event.target.value })} />
          </Field>
        </div>
        <Field label={t('fit.comment.text')}>
          <Textarea value={comment.text} rows={2} honourRows maxLength={2000} onChange={(event) => actions?.onComment?.({ text: event.target.value })} />
        </Field>
        <div className="fw-smp-actions">
          <Button size="sm" variant="secondary" heldReason={commentHeld} onClick={() => actions?.onCommentAdd?.()}>
            {t('fit.comment.add')}
          </Button>
        </div>
        {comment.notice && <Banner tone={comment.notice.tone} title={say(comment.notice)} />}
      </Card>
    </div>
  )
}

