'use client'

import { useMemo, useRef } from 'react'
import { MoreHorizontal, RotateCcw, Undo2, WifiOff } from 'lucide-react'
import { Banner, Card, Disclosure, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { GradeRuleRow, GradesView } from '../api'
import {
  defaultHeld,
  gradeLabel,
  gradesCount,
  gradesHeld,
  historyOf,
  markKey,
  panelsText,
  shareText,
  shownText,
  sourceKey,
  useAgainHeld,
  type GradeCell,
  type GradeMark,
  type GradesActions,
  type GradesModel,
} from '../grades-model'
import '../grades.css'

/**
 * SCR-048 Properties & grades › Grades and usable area (B-W2b-131; design products.materials material.props.grades, PRD-031):
 * a leather's grades with the share of a hide of each grade that is usable for this article and the panels the grade may
 * be cut for, on the shared list frame (a list inside a record: no saved views). Each cell saves by itself with its mark
 * (CellSaveMark; waiting while offline; "!" with our words when refused, the stored value shown again); a grade without
 * the article's own rule shows the grade's default, and typing into it creates the article's rule. ⋯ and the selection:
 * Back to the grade's default (the rule is retired, kept as history); an earlier rule can be used again. Read only (the
 * banner says why) for a role without product.materials.manage over the material's company, a material of every company
 * without a grant over every company, or an archived material: cells as text. It draws the model and fetches nothing.
 */
export function GradesSection({ model, actions, libraryManage }: { model: GradesModel; actions?: GradesActions; libraryManage: boolean }) {
  const t = useT('library')
  const part = model.part
  if (part.status === 'idle') return null
  if (part.status === 'error')
    return (
      <Banner
        tone="danger"
        title={t('material.grades.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t(part.problem)}
      </Banner>
    )
  if (part.status === 'loading')
    return (
      <Card header={t('material.grades.title')} headingLevel={3} aria-busy="true">
        <p className="fw-lib-hint" role="status">
          <Spinner size={14} /> {t('material.grades.loading')}
        </p>
        <div className="fw-lib-skeleton">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  if (!part.value.material.tracksHides) return <Card header={t('material.grades.title')} headingLevel={3} description={t('material.grades.notTracked')} />
  return <Grades view={part.value} model={model} actions={actions} libraryManage={libraryManage} />
}

function Grades({ view, model, actions, libraryManage }: { view: GradesView; model: GradesModel; actions?: GradesActions; libraryManage: boolean }) {
  const t = useT('library')
  const locale = useLocale()
  const held = gradesHeld(view, model.archived, libraryManage)
  const editable = held === null
  const latest = useRef({ actions, marks: model.marks })
  latest.current = { actions, marks: model.marks }
  const marksKey = JSON.stringify(model.marks)
  const rows = view.grades

  const columns = useMemo<ColDef<GradeRuleRow>[]>(() => {
    const mark = (row: GradeRuleRow, cell: GradeCell) => latest.current.marks[markKey(row.grade.id, cell)]
    const commit = (row: GradeRuleRow, cell: GradeCell, text: string) => latest.current.actions?.onCell?.(row, cell, text)

    const GradeCellView = ({ data }: ICellRendererParams<GradeRuleRow>) =>
      data ? (
        <span className="fw-mg-cell">
          <b className="fw-mg-code">{data.grade.code}</b>
          <span className="fw-mg-text">{gradeLabel(data.grade, locale)}</span>
          {!data.grade.active && <Tag tone="warning">{t('material.grades.retiredGrade')}</Tag>}
        </span>
      ) : null
    const ShareCell = ({ data }: ICellRendererParams<GradeRuleRow>) => {
      if (!data) return null
      const text = shownText(data, 'share', latest.current.marks, locale)
      return (
        <span className="fw-mg-cell">
          {editable ? (
            <TextCell value={text} label={t('material.grades.cell.share', { grade: data.grade.code })} numeric suffix="%" mark={mark(data, 'share')} onCommit={(next) => commit(data, 'share', next)} />
          ) : (
            <span className="fw-mg-num">{`${shareText(data.share, locale)} %`}</span>
          )}
          <span className="fw-mg-sub">{t(sourceKey(data))}</span>
          <Mark mark={mark(data, 'share')} />
        </span>
      )
    }
    const PanelsCell = ({ data }: ICellRendererParams<GradeRuleRow>) => {
      if (!data) return null
      const text = shownText(data, 'panels', latest.current.marks, locale)
      return (
        <span className="fw-mg-cell fw-mg-wide">
          {editable ? (
            <TextCell value={text} label={t('material.grades.cell.panels', { grade: data.grade.code })} placeholder={t('material.grades.panels.every')} mark={mark(data, 'panels')} onCommit={(next) => commit(data, 'panels', next)} />
          ) : (
            <span className={data.panels.length ? 'fw-mg-text' : 'fw-mg-sub'} title={data.panels.length ? panelsText(data.panels) : undefined}>
              {data.panels.length ? panelsText(data.panels) : t('material.grades.panels.every')}
            </span>
          )}
          <Mark mark={mark(data, 'panels')} />
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<GradeRuleRow>) => {
      if (!data) return null
      const toDefault = defaultHeld(rows, [data.grade.id], held, model.busy)
      const earlier = historyOf(data)
      const items: MenuItemDef[] = [
        {
          id: 'default',
          label: t('material.grades.row.default'),
          disabled: toDefault !== null,
          description: toDefault ? t(toDefault) : t('material.grades.row.defaultHint', { share: shareText(data.grade.defaultShare, locale) }),
          onSelect: () => latest.current.actions?.onDefault?.([data.grade.id]),
        },
        ...earlier.slice(0, 3).map((rule): MenuItemDef => {
          const why = useAgainHeld(data, held)
          return {
            id: `again-${rule.id}`,
            label: t('material.grades.row.useAgain', { share: shareText(rule.usableShare, locale), date: formatDate(rule.updatedAt, { locale }) }),
            disabled: why !== null,
            description: why ? t(why) : undefined,
            onSelect: () => latest.current.actions?.onUseAgain?.(data, rule.id),
          }
        }),
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('material.grades.row.menu', { grade: data.grade.code }) }} items={items} />
    }
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    return [
      { colId: 'grade', headerName: t('material.grades.col.grade'), minWidth: 170, flex: 1, cellRenderer: GradeCellView, valueGetter: (params) => (params.data ? `${params.data.grade.code} · ${gradeLabel(params.data.grade, locale)}` : ''), ...plain },
      { colId: 'share', headerName: t('material.grades.col.share'), minWidth: 230, flex: 1.1, cellRenderer: ShareCell, valueGetter: (params) => (params.data ? `${shareText(params.data.share, locale)} % · ${t(sourceKey(params.data))}` : ''), ...plain },
      { colId: 'panels', headerName: t('material.grades.col.panels'), minWidth: 260, flex: 2, cellRenderer: PanelsCell, valueGetter: (params) => (params.data ? (params.data.panels.length ? panelsText(params.data.panels) : t('material.grades.panels.every')) : ''), ...plain },
      { colId: 'hides', headerName: t('material.grades.col.hides'), minWidth: 130, flex: 0.6, type: 'rightAligned', valueGetter: (params) => params.data?.hidesInStock ?? 0, ...plain },
      { colId: 'more', headerName: t('material.grades.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
    // The cells read the marks through `latest`; a change of them redraws the cells.
  }, [t, locale, editable, held, rows, marksKey, model.busy])

  const count = gradesCount(view)
  const selected = model.selected
  const bulkHeld = defaultHeld(rows, selected, held, model.busy)
  const waiting = Object.values(model.marks).filter((mark) => mark.state === 'waiting').length
  const history = rows.filter((row) => row.retiredRules.length > 0)
  const historyCount = history.reduce((sum, row) => sum + row.retiredRules.length, 0)

  return (
    <section className="fw-lib-stack" aria-label={t('material.grades.title')}>
      <Card header={t('material.grades.title')} headingLevel={3} description={t('material.grades.intro', { code: view.material.code })}>
        <p className="fw-lib-hint">{t('material.grades.rule')}</p>
      </Card>
      {held && <Banner tone="info" title={t(held)} />}
      {(model.offline || waiting > 0) && (
        <Banner
          tone="warning"
          title={
            <span className="fw-lib-inline">
              <WifiOff size={14} aria-hidden /> {t('material.grades.offline', { count: waiting })}
            </span>
          }
        />
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      <ListFrame<GradeRuleRow>
        label={t('material.grades.table')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.grade.id}
        columns={columns}
        count={t('material.grades.count', { count: count.grades, rules: count.rules })}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          actions: (
            <Button size="sm" aria-label={t('material.grades.bulk.default', { count: selected.length })} heldReason={bulkHeld ? t(bulkHeld) : null} onClick={() => actions?.onDefault?.([...selected])}>
              <Undo2 size={13} aria-hidden /> <SelectionLabel>{t('material.grades.bulk.default', { count: selected.length })}</SelectionLabel>
            </Button>
          ),
        }}
        state={rows.length === 0 ? <EmptyState title={t('material.grades.empty.title')} description={t('material.grades.empty.body')} /> : undefined}
      />
      {historyCount > 0 && (
        <Disclosure summary={t('material.grades.history.summary', { count: historyCount })} open={model.historyOpen || undefined}>
          <ul className="fw-mg-history">
            {history.flatMap((row) =>
              historyOf(row).map((rule) => {
                const why = useAgainHeld(row, held)
                return (
                  <li key={rule.id} className="fw-mg-history-row">
                    <span className="fw-mg-text">
                      {t('material.grades.history.row', {
                        grade: row.grade.code,
                        share: shareText(rule.usableShare, locale),
                        panels: rule.panels.length ? panelsText(rule.panels) : t('material.grades.panels.every'),
                        date: formatDate(rule.updatedAt, { locale }),
                      })}
                    </span>
                    <Button size="sm" variant="quiet" heldReason={why ? t(why) : null} onClick={() => actions?.onUseAgain?.(row, rule.id)}>
                      <RotateCcw size={13} aria-hidden /> {t('material.grades.history.useAgain')}
                    </Button>
                  </li>
                )
              }),
            )}
          </ul>
        </Disclosure>
      )}
    </section>
  )
}

/** A text cell: typed freely, saved when it is left or on Enter (Esc puts the stored value back). */
function TextCell({ value, label, numeric, suffix, placeholder, mark, onCommit }: { value: string; label: string; numeric?: boolean; suffix?: string; placeholder?: string; mark?: GradeMark; onCommit: (next: string) => void }) {
  return (
    <span className="fw-mg-input">
      <Input
        size="xs"
        // A refusal puts the stored value back in the field (the mark says why).
        key={`${value}|${mark?.state ?? ''}`}
        defaultValue={value}
        aria-label={label}
        placeholder={placeholder}
        inputMode={numeric ? 'decimal' : undefined}
        onBlur={(event) => {
          if (event.target.value !== value) onCommit(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== 'Escape') return
          event.preventDefault()
          const input = event.currentTarget
          if (event.key === 'Escape') input.value = value
          setTimeout(() => input.blur(), 0)
        }}
      />
      {suffix && <span className="fw-mg-sub" aria-hidden>{suffix}</span>}
    </span>
  )
}

/** A cell's save mark: saving / waiting (the DS CellSaveMark), refused ("!" with our words); nothing once saved. */
function Mark({ mark }: { mark: GradeMark | undefined }) {
  const t = useT('library')
  if (!mark) return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'problem.write.invalid')
    return (
      <span className="fw-mg-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}
