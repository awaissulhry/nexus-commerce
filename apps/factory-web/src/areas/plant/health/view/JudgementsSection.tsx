'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Eye, EyeOff, Lock } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select } from '@nexus/ui/primitives'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { SHOW_MOST, type JudgementRow, type ShownJudgement } from '../api'
import { addressTerms, HEALTH_PATH, JUDGEMENT_FILTERS, withAddress } from '../model'
import type { HealthPageActions, HealthPageModel } from '../view-model'
import { JudgementStateTag, OutcomeTag, PAGE_KEYS, personText, ProtectedLaw, SectionFailed, SectionHead, useWhen, useWords, WhoLooked } from './parts'

/**
 * design sec:judgements — "Only the outcome, never clinical data (QHS-254; art. 41 c.6)": ANONYMISED by default (day, expiry,
 * state, from a visit, a copy on file: nothing recorded). Person · outcome · task limits only after Show (the chosen rows, or this
 * page's rows), said first with the PrivacyNote — one OPEN view recorded per row — and kept in the page's state until Hide or a
 * new read. A row opens the judgement (its own recorded read): void, the doctor's copy, Who looked. The appeal deadline is Later.
 */
export function JudgementsSection({ model, actions, onHelp }: { model: HealthPageModel; actions?: HealthPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const { address } = model
  const list = model.judgements?.status === 'ready' ? model.judgements.value : null
  const rows = list?.rows ?? null
  const selected = model.judgementSelected ?? []
  const shown = model.shown.state === 'shown' ? model.shown : null
  const valueOf = (row: JudgementRow): ShownJudgement | null => shown?.byId[row.id] ?? null
  const frame = model.frame.status === 'ready' ? model.frame.value : null
  const views = frame?.can.views ?? model.can.views
  const href = (row: JudgementRow) => `${model.prefix}${HEALTH_PATH}${addressTerms(withAddress(address, { judgement: row.id, visit: null, judge: null, plan: null, planVisits: false }))}`

  const columns = useMemo<ColDef<JudgementRow>[]>(() => {
    const Hidden = () => (
      <span className="fw-hv-hidden">
        <Lock size={12} aria-hidden /> {t('judgements.hidden')}
      </span>
    )
    const built: ColDef<JudgementRow>[] = [
      {
        colId: 'person',
        headerName: t('col.person'),
        minWidth: 165,
        flex: 1.3,
        valueGetter: (params) => {
          const value = params.data ? valueOf(params.data) : null
          return value ? personText(value.employee) : ''
        },
        cellRenderer: ({ data }: ICellRendererParams<JudgementRow>) => {
          if (!data) return null
          const value = valueOf(data)
          return <Link href={href(data)}>{value ? personText(value.employee) : t('judgements.open', { day: when.day(data.judgedOn) })}</Link>
        },
      },
      {
        colId: 'outcome',
        headerName: t('col.outcome'),
        minWidth: 175,
        flex: 1.1,
        valueGetter: (params) => {
          const value = params.data ? valueOf(params.data) : null
          return value ? t(`outcome.${value.outcome}`) : ''
        },
        cellRenderer: ({ data }: ICellRendererParams<JudgementRow>) => {
          const value = data ? valueOf(data) : null
          return data ? value ? <OutcomeTag outcome={value.outcome} /> : <Hidden /> : null
        },
      },
      {
        colId: 'limits',
        headerName: t('col.limits'),
        minWidth: 190,
        flex: 1.6,
        valueGetter: (params) => {
          const value = params.data ? valueOf(params.data) : null
          if (!value) return ''
          return value.taskLimits ?? (value.unfitUntil ? t('judgements.unfitUntil', { day: when.day(value.unfitUntil) }) : '—')
        },
        cellRenderer: ({ data, value }: ICellRendererParams<JudgementRow>) => (data ? valueOf(data) ? <span className="fw-hv-clip" title={String(value ?? '')}>{String(value ?? '')}</span> : <Hidden /> : null),
      },
      { colId: 'judgedOn', headerName: t('col.judgedOn'), minWidth: 105, flex: 0.8, valueGetter: (params) => params.data?.judgedOn ?? '', valueFormatter: (params) => (params.data ? when.day(params.data.judgedOn) : '') },
      {
        colId: 'expiry',
        headerName: t('col.expiry'),
        minWidth: 150,
        flex: 1,
        valueGetter: (params) => params.data?.expiresOn ?? '',
        cellRenderer: ({ data }: ICellRendererParams<JudgementRow>) => {
          if (!data) return null
          if (!data.expiresOn) return <span className="fw-hv-muted">{t('judgements.noExpiry')}</span>
          if (data.state === 'SUPERSEDED' || data.state === 'VOIDED') return <span className="fw-hv-muted">{when.day(data.expiresOn)}</span>
          return <DueCell value={{ due: data.expiresOn }} today={model.today} formatDate={(iso) => when.day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('judgements.validUntil', { date: text }) }} />
        },
      },
      { colId: 'state', headerName: t('col.state'), minWidth: 115, flex: 0.8, valueGetter: (params) => (params.data ? t(`judgementState.${params.data.state}`) : ''), cellRenderer: ({ data }: ICellRendererParams<JudgementRow>) => (data ? <JudgementStateTag state={data.state} /> : null) },
      { colId: 'fromVisit', headerName: t('col.fromVisit'), minWidth: 95, flex: 0.6, valueGetter: (params) => (params.data ? t(params.data.fromVisit ? 'common.yes' : 'common.no') : '') },
      { colId: 'copy', headerName: t('col.copy'), minWidth: 90, flex: 0.6, valueGetter: (params) => (params.data ? t(params.data.hasCopy ? 'judgements.copyOnFile' : 'judgements.noCopy') : '') },
    ]
    if (views) {
      built.push({
        colId: 'who',
        headerName: t('col.who'),
        minWidth: 90,
        maxWidth: 110,
        sortable: false,
        valueGetter: () => '',
        cellRenderer: ({ data }: ICellRendererParams<JudgementRow>) =>
          data ? <WhoLooked of={{ recordType: 'FITNESS_JUDGEMENT', recordId: data.id }} state={model.whoLooked} onOpen={actions?.onWhoLooked} label={t('who.judgement', { day: when.day(data.judgedOn) })} compact /> : null,
      })
    }
    return built
    // The words follow the language; the values follow their recorded read.
  }, [t, ds, when, shown, views, model.today, model.whoLooked, model.prefix, address])

  const pageIds = (rows ?? []).slice(0, SHOW_MOST).map((row) => row.id)
  const showHeld = rows && rows.length === 0 ? t('held.show.none') : model.shown.state === 'reading' ? t('common.reading') : null
  const tools = (
    <span className="fw-hv-tools">
      <Select size="sm" aria-label={t('judgements.stateLabel')} value={address.jstate ?? 'current'} onChange={(event) => actions?.onAddress?.({ jstate: event.target.value === 'current' ? null : (event.target.value as typeof address.jstate) })}>
        {JUDGEMENT_FILTERS.map((filter) => (
          <option key={filter} value={filter}>
            {t(`judgementFilter.${filter}`)}
          </option>
        ))}
      </Select>
      {shown ? (
        <Button size="sm" onClick={() => actions?.onHideShown?.()}>
          <EyeOff size={13} aria-hidden /> {t('judgements.hide')}
        </Button>
      ) : (
        <Button size="sm" heldReason={showHeld} onClick={() => actions?.onAskShow?.(pageIds)}>
          <Eye size={13} aria-hidden /> {t('judgements.showPage', { count: pageIds.length })}
        </Button>
      )}
    </span>
  )
  const picked = selected.slice(0, SHOW_MOST)

  const state =
    model.judgements?.status === 'error' ? (
      <SectionFailed title={t('judgements.failed')} problem={model.judgements.problem} onRetry={actions?.onRetryJudgements} />
    ) : rows && rows.length === 0 ? (
      address.jstate && address.jstate !== 'current' ? <EmptyState title={t('judgements.noneMatchTitle')} description={t('judgements.noneMatch')} /> : <EmptyState title={t('judgements.emptyTitle')} description={t('judgements.empty')} />
    ) : undefined

  return (
    <section className="fw-hv-section" aria-labelledby="fw-hv-judgements">
      <SectionHead id="fw-hv-judgements" title={t('judgements.title')} note={t('judgements.note')} />
      {shown && <PrivacyNote level="protected" variant="panel" recorded text={t('judgements.shownNote', { count: Object.keys(shown.byId).length, time: when.at(shown.at) })} whoMore={t('privacy.whoMore')} law={<ProtectedLaw />} labels={ds.privacyNote} />}
      {model.shown.state === 'error' && <Banner tone="warning" title={t('judgements.showFailed')}>{t(model.shown.problem)}</Banner>}
      <ListFrame<JudgementRow>
        label={t('judgements.label')}
        title={t('judgements.title')}
        listKey={null}
        rows={model.judgements === null || model.judgements.status === 'loading' ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('judgements.count', { count: rows.length }) : '—'}
        tools={tools}
        selection={{
          selected,
          onChange: (ids) => actions?.onJudgementSelected?.(ids),
          actions: (
            <Button size="sm" variant="primary" aria-label={t('bulk.show', { count: picked.length })} heldReason={picked.length === 0 ? t('held.show.none') : null} onClick={() => actions?.onAskShow?.(picked)}>
              <Eye size={13} aria-hidden /> <SelectionLabel>{t('bulk.show', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.judgementUpdates > 0 ? { count: model.judgementUpdates, onShow: () => actions?.onJudgementUpdates?.() } : null}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ judgement: row.id })}
        more={list?.more ? { label: t('judgements.more'), onMore: () => actions?.onJudgementsMore?.(), held: model.judgementsMore ? t('common.reading') : null } : null}
        state={state}
        cards={{ fields: { person: { role: 'title' } } }}
        today={model.today}
      />
      {model.judgements?.status === 'loading' && <span className="fw-hv-slow">{t('common.stillLoading')}</span>}
    </section>
  )
}

/** Show: said before anything is read (the PrivacyNote), then one recorded read — one OPEN view per row shown. */
export function ShowConfirm({ model, ids, actions }: { model: HealthPageModel; ids: readonly string[]; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const count = Math.min(ids.length, SHOW_MOST)
  void model
  return (
    <Modal
      open
      onClose={() => actions?.onHideShown?.()}
      title={t('show.title')}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onHideShown?.()}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onShow?.()}>
            <Eye size={14} aria-hidden /> {t('show.confirm', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-hv-stack">
        <PrivacyNote level="protected" variant="panel" recorded text={t('show.note')} whoMore={t('privacy.whoMore')} law={<ProtectedLaw />} labels={ds.privacyNote} />
        <p className="fw-hv-muted">{t('show.body', { count })}</p>
      </div>
    </Modal>
  )
}
