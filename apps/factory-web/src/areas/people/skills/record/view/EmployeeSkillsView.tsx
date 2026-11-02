'use client'

import { useMemo } from 'react'
import { MoreHorizontal, Plus, ShieldCheck } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { NoPeopleAccess, useWords } from '../../../_shared/parts'
import type { Authorisation, EmployeeLevel, EmployeeSkills, SkillLevel } from '../../api'
import { className, isTrainee, SKILL_LEVELS, SKILLS_NAMESPACES, TIME_ZONE, type SkillsCan } from '../../model'
import type { SkillDialogActions } from '../../use-skill-dialogs'
import { LevelMark, MachineMark } from '../../view/cells'
import { SkillDialogs, useSkillWords, type SkillDialogsModel } from '../../view/SkillDialogs'
import type { SkillNotice } from '../../view/SkillsView'
import '../../skills.css'

export interface EmployeeSkillsModel {
  can: SkillsCan
  loaded: { status: 'loading' } | { status: 'ready'; value: EmployeeSkills } | { status: 'error'; problem: string }
  notice: SkillNotice | null
  /** The skills' names in the page's language, by id (a level names its skill in one language). */
  names: Readonly<Record<string, string>>
  dialogs: SkillDialogsModel
}

export interface EmployeeSkillsActions {
  onRetry?: () => void
  onDismissNotice?: () => void
  onAddLevel?: () => void
  onAuthorise?: () => void
  onSetLevel?: (row: EmployeeLevel, level: SkillLevel) => void
  onTrainee?: (row: EmployeeLevel) => void
  onSignOff?: (row: EmployeeLevel) => void
  onRemove?: (row: EmployeeLevel) => void
  onValidUntil?: (row: Authorisation) => void
  onRevoke?: (row: Authorisation) => void
  dialog?: SkillDialogActions
}

type Row = { id: string; kind: 'level'; level: EmployeeLevel } | { id: string; kind: 'machine'; authorisation: Authorisation }

/** SCR-085-skills — the employee record's Skills & training tab: one view model, nothing fetched. */
export function EmployeeSkillsView({ model, actions }: { model: EmployeeSkillsModel; actions?: EmployeeSkillsActions }) {
  return (
    <WithMessages namespaces={SKILLS_NAMESPACES}>
      <Tab model={model} {...(actions ? { actions } : {})} />
    </WithMessages>
  )
}

function Tab({ model, actions }: { model: EmployeeSkillsModel; actions?: EmployeeSkillsActions }) {
  const t = useSkillWords()
  const people = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const value = model.loaded.status === 'ready' ? model.loaded.value : null
  const day = (text: string | null) => (text ? formatDate(`${text}T12:00:00Z`, place) : '—')
  const rows = useMemo<Row[]>(() => (value ? [...value.levels.map((level): Row => ({ id: level.id, kind: 'level', level })), ...value.authorisations.map((authorisation): Row => ({ id: authorisation.id, kind: 'machine', authorisation }))] : []), [value])
  const nameOf = (level: EmployeeLevel) => model.names[level.skill.id] ?? level.skill.name
  const heldLevels = value?.canManage ? null : t('held.noManage')
  const heldMachines = value?.canAuthorise ? null : t('held.noAuthorise')
  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { colId: 'what', headerName: t('tab.what'), minWidth: 220, flex: 1, valueGetter: (params) => (!params.data ? '' : params.data.kind === 'level' ? nameOf(params.data.level) : className(params.data.authorisation.machineClass, locale)) },
      { colId: 'kind', headerName: t('tab.kind'), width: 170, valueGetter: (params) => (!params.data ? '' : params.data.kind === 'level' ? t(`kind.${params.data.level.skill.kind}`) : t('tab.machine')) },
      {
        colId: 'state',
        headerName: t('tab.state'),
        width: 190,
        valueGetter: (params) => (!params.data ? '' : params.data.kind === 'level' ? t(`level.${params.data.level.level}`) : t(`machine.${params.data.authorisation.state}`)),
        cellRenderer: (params: ICellRendererParams<Row>) => {
          const row = params.data
          if (!row) return null
          if (row.kind === 'machine') return <MachineMark state={row.authorisation.state} />
          if (heldLevels) return <LevelMark level={row.level.level} trainee={row.level.trainee} />
          return (
            <Select size="sm" aria-label={t('tab.setLevel', { what: nameOf(row.level) })} value={row.level.level} onChange={(event) => actions?.onSetLevel?.(row.level, event.target.value as SkillLevel)}>
              {SKILL_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`level.${level}`)}
                </option>
              ))}
            </Select>
          )
        },
      },
      {
        colId: 'trainee',
        headerName: t('tab.trainee'),
        width: 170,
        valueGetter: (params) => {
          const row = params.data
          if (row?.kind !== 'level') return ''
          if (row.level.signedOffOn) return t('tab.signedOffOn', { date: day(row.level.signedOffOn) })
          return row.level.traineeUntil ? t(row.level.trainee === 'OVERDUE' ? 'tab.traineeOverdue' : 'tab.traineeUntil', { date: day(row.level.traineeUntil) }) : ''
        },
      },
      { colId: 'since', headerName: t('tab.since'), width: 120, valueGetter: (params) => (!params.data ? '' : params.data.kind === 'level' ? day(params.data.level.since) : day(params.data.authorisation.authorisedOn)) },
      { colId: 'until', headerName: t('tab.until'), width: 130, valueGetter: (params) => (params.data?.kind === 'machine' ? day(params.data.authorisation.validUntil) : '') },
      { colId: 'by', headerName: t('tab.by'), width: 160, valueGetter: (params) => (!params.data ? '' : params.data.kind === 'level' ? (params.data.level.assessedBy ?? '') : (params.data.authorisation.authorisedBy ?? '')) },
      {
        colId: 'actions',
        headerName: '',
        width: 56,
        pinned: 'right',
        sortable: false,
        cellRenderer: (params: ICellRendererParams<Row>) => {
          const row = params.data
          if (!row) return null
          const items =
            row.kind === 'level'
              ? [
                  ...(isTrainee(row.level.trainee) ? [{ id: 'signoff', label: t('cell.signOff'), disabled: Boolean(heldLevels), description: heldLevels ?? undefined, onSelect: () => actions?.onSignOff?.(row.level) }] : []),
                  ...(!row.level.signedOffOn ? [{ id: 'trainee', label: t(row.level.traineeUntil ? 'cell.moveTrainee' : 'cell.makeTrainee'), disabled: Boolean(heldLevels), description: heldLevels ?? undefined, onSelect: () => actions?.onTrainee?.(row.level) }] : []),
                  { id: 'remove', label: t('cell.remove'), disabled: Boolean(heldLevels), description: heldLevels ?? undefined, onSelect: () => actions?.onRemove?.(row.level) },
                ]
              : [
                  { id: 'until', label: t('cell.changeUntil'), disabled: Boolean(heldMachines), description: heldMachines ?? undefined, onSelect: () => actions?.onValidUntil?.(row.authorisation) },
                  { id: 'revoke', label: t('cell.revoke'), disabled: Boolean(heldMachines), description: heldMachines ?? undefined, onSelect: () => actions?.onRevoke?.(row.authorisation) },
                ]
          return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('tab.rowMenu') }} items={items} />
        },
      },
    ],
    // `day` follows the locale; the held words and the actions come from the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, locale, heldLevels, heldMachines, actions, model.names],
  )

  if (!model.can.view) return <NoPeopleAccess permission="people.skills.view" />
  if (model.loaded.status === 'loading') {
    return (
      <Card padded aria-busy="true">
        <p className="fw-pp-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
        <div className="fw-pp-stack tight">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  }
  if (model.loaded.status === 'error') {
    return (
      <Card padded>
        <EmptyState
          title={t('tab.failed')}
          description={people(model.loaded.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {people('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const left = value?.employee.status === 'LEFT'
  const heldAdd = left ? t('held.left') : heldLevels
  const heldAuth = left ? t('held.left') : heldMachines
  const ended = [...(value?.history.levels ?? []), ...(value?.history.authorisations ?? [])]
  return (
    <div className="fw-pp">
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.ns === 'skills' ? t(model.notice.key, model.notice.params) : people(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {people('common.close')}
            </Button>
          }
        />
      )}
      <div className="fw-pp-head">
        <p className="fw-pp-hint">{t('tab.judgement')}</p>
        <span className="fw-pp-actions">
          <Button size="sm" heldReason={heldAuth} onClick={() => actions?.onAuthorise?.()}>
            <ShieldCheck size={14} aria-hidden /> {t('band.authorise')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldAdd} onClick={() => actions?.onAddLevel?.()}>
            <Plus size={14} aria-hidden /> {t('tab.add')}
          </Button>
        </span>
      </div>
      <ListFrame<Row>
        label={t('tab.tableLabel')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="text"
        count={t('tab.count', { count: rows.length })}
        listKey={null}
        state={
          rows.length === 0 ? (
            <EmptyState
              title={t('tab.empty')}
              action={
                <Button size="sm" heldReason={heldAdd} onClick={() => actions?.onAddLevel?.()}>
                  {t('tab.add')}
                </Button>
              }
            />
          ) : null
        }
      />
      {ended.length > 0 && (
        <Card padded>
          <div className="fw-sk-form">
            <h3 className="fw-sk-pop-sub">{t('tab.ended')}</h3>
            <SummaryTable
              label={t('tab.ended')}
              columns={[t('tab.what'), t('tab.endedOn'), t('tab.by'), t('common.reason')]}
              stackOnPhone
              align={['left', 'left', 'left', 'left']}
              rows={[
                ...(value?.history.levels ?? []).map((row) => ({ id: row.id, cells: [nameOf(row), row.removedAt ? formatDate(row.removedAt, place) : '—', row.removedBy ?? '—', row.removeReason ?? '—'] })),
                ...(value?.history.authorisations ?? []).map((row) => ({ id: row.id, cells: [className(row.machineClass, locale), row.revokedAt ? formatDate(row.revokedAt, place) : '—', row.revokedBy ?? '—', row.revokeReason ?? '—'] })),
              ]}
            />
          </div>
        </Card>
      )}
      <SkillDialogs model={model.dialogs} {...(actions?.dialog ? { actions: actions.dialog } : {})} />
    </div>
  )
}
