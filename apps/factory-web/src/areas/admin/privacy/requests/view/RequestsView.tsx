'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, Inbox } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useKeysHelp } from '../../../kit/list'
import { EraseDialog, type EraseActions } from '../../erase/view/EraseDialog'
import { REQUEST_VIEWS, type DataRequest, type RequestView } from '../api'
import { KIND_ORDER, requestHref, requestRows, STATUS_PILL, type RequestsViewModel } from '../model'
import { Clock } from './Clock'
import { NewRequestDialog, type NewRequestActions } from './NewRequestDialog'
import { RequestDialog, type RequestDialogActions } from './RequestDialog'
import '../requests.css'

export interface RequestsActions extends RequestDialogActions, NewRequestActions {
  onView?: (view: RequestView) => void
  onKind?: (kind: string | null) => void
  onOpen?: (requestId: string) => void
  onSelect?: (ids: string[]) => void
  onExport?: (ids: string[]) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
  erase?: EraseActions
  onStepUpSubmit?: (code: string) => void
  onStepUpClose?: () => void
}

/** The catalogues the section speaks: its own, Admin's (the step-up's problems), the lists'. */
export function DepthMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['admin-privacy-depth', 'admin', 'lists']}>{children}</WithMessages>
}

/**
 * SCR-660 — Admin › Privacy › Data requests (design admin.privacy sec:requests; PLT-202, PLT-203; GDPR arts. 12, 15-17, 20):
 * every access, erasure and correction request with its 30-day clock — person, kind, received, due (a live Countdown; late in
 * the danger tone), state — on the shared list frame (Export N = the clock and the outcome for an auditor, never a name). A row
 * opens the request (identity, extend, collect the package with its JobProgress, download it, anonymise, done, refuse,
 * withdrawn). Shown only with privacy.requests.view (a request names a person). Fetches nothing (DataRequests reads the API).
 */
export function RequestsView({ model, actions }: { model: RequestsViewModel; actions?: RequestsActions }) {
  return (
    <DepthMessages>
      <Requests model={model} actions={actions} />
    </DepthMessages>
  )
}

function useColumns(model: RequestsViewModel, actions?: RequestsActions): ColDef<DataRequest>[] {
  const t = useT('admin-privacy-depth')
  const locale = useLocale()
  return useMemo(() => {
    const place = { locale, timeZone: model.timeZone }
    const PersonCell = ({ data }: ICellRendererParams<DataRequest>) =>
      data ? (
        <span className="fw-dprq-cell">
          <Link
            className="fw-dprq-link"
            href={requestHref(model.prefix, data.id)}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || !actions?.onOpen) return
              event.preventDefault()
              actions.onOpen(data.id)
            }}
          >
            {data.person.erased ? t('dp.req.erasedPerson') : data.person.name}
          </Link>
          <span className="fw-dprq-sub">{t(`dp.personKind.${data.person.kind}`)}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<DataRequest>) => (data ? <span>{t(`dp.kind.${data.kind}`)}</span> : null)
    const ReceivedCell = ({ data }: ICellRendererParams<DataRequest>) => (data ? <span>{formatDate(data.receivedAt, place)}</span> : null)
    const DueCell = ({ data }: ICellRendererParams<DataRequest>) => (data ? <Clock request={data} now={model.now} timeZone={model.timeZone} /> : null)
    const StateCell = ({ data }: ICellRendererParams<DataRequest>) => (data ? <Pill tone={STATUS_PILL[data.status]}>{t(`dp.status.${data.status}`)}</Pill> : null)
    const CompanyCell = ({ data }: ICellRendererParams<DataRequest>) => (data ? <span className="fw-dprq-ellipsis">{data.company.name}</span> : null)
    return [
      { colId: 'person', headerName: t('dp.req.col.person'), minWidth: 200, flex: 1.4, cellRenderer: PersonCell },
      { colId: 'kind', headerName: t('dp.req.col.kind'), minWidth: 120, flex: 0.7, cellRenderer: KindCell },
      { colId: 'received', headerName: t('dp.req.col.received'), minWidth: 120, flex: 0.7, cellRenderer: ReceivedCell },
      { colId: 'due', headerName: t('dp.req.col.due'), minWidth: 190, flex: 1.1, cellRenderer: DueCell },
      { colId: 'state', headerName: t('dp.req.col.state'), minWidth: 130, flex: 0.7, cellRenderer: StateCell },
      { colId: 'company', headerName: t('dp.req.col.company'), minWidth: 150, flex: 0.9, cellRenderer: CompanyCell },
    ]
  }, [t, locale, model.timeZone, model.now, model.prefix, actions])
}

function Requests({ model, actions }: { model: RequestsViewModel; actions?: RequestsActions }) {
  const t = useT('admin-privacy-depth')
  const admin = useT('admin')
  const lists = useT('lists')
  const rows = requestRows(model.list.value, model.address.kind)
  const columns = useColumns(model, actions)
  const selected = model.selected.filter((id) => rows?.some((row) => row.id === id))
  const ownKeys: ListKey[] = [{ keys: ['1', '2', '3', '4', '5'], does: t('dp.keys.views') }]
  const { onHelp, help } = useKeysHelp(ownKeys, true)
  const counts = model.list.value?.counts

  const state = model.list.problem ? (
    <EmptyState
      title={t('dp.req.failed')}
      description={t(model.list.problem)}
      action={
        <Button size="sm" onClick={actions?.onRetry}>
          {t('dp.common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState
      icon={<Inbox size={22} aria-hidden />}
      title={t(model.address.kind ? 'dp.req.empty.kind' : `dp.req.empty.${model.address.view}`)}
      description={t('dp.req.empty.hint')}
      action={
        model.address.view !== 'all' ? (
          <Button size="sm" onClick={() => actions?.onView?.('all')}>
            {t('dp.req.empty.showAll')}
          </Button>
        ) : undefined
      }
    />
  ) : undefined

  return (
    <section className="fw-dprq" aria-labelledby="fw-dprq-title">
      <div className="fw-dprq-head">
        <h2 id="fw-dprq-title" className="fw-dprq-h2">
          {t('dp.req.title')}
        </h2>
        <p className="fw-dprq-muted">{t('dp.req.intro')}</p>
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={actions?.onDismissNotice}>
              {t('dp.common.dismiss')}
            </Button>
          }
        />
      )}
      {counts && counts.overdue > 0 && <Banner tone="danger" title={t('dp.req.lateBanner', { count: counts.overdue })} />}
      <ListFrame<DataRequest>
        label={t('dp.req.title')}
        listKey={null}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows && counts ? t('dp.req.count', { count: rows.length, open: counts.open, late: counts.overdue }) : lists('loading')}
        tools={
          <span className="fw-dprq-tools">
            <Select size="sm" aria-label={t('dp.req.view.label')} value={model.address.view} onChange={(event) => actions?.onView?.(event.target.value as RequestView)}>
              {REQUEST_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`dp.req.view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('dp.req.kindFilter')} value={model.address.kind ?? ''} onChange={(event) => actions?.onKind?.(event.target.value || null)}>
              <option value="">{t('dp.req.kindAll')}</option>
              {KIND_ORDER.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`dp.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </span>
        }
        selection={{
          selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          actions: (
            <Button size="sm" aria-label={t('dp.req.export', { count: selected.length })} onClick={() => actions?.onExport?.([...selected])}>
              <Download size={14} aria-hidden /> <SelectionLabel>{t('dp.req.export', { count: selected.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={onHelp}
        keysOpen={model.keysOpen}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      {help}
      <RequestDialog model={model} actions={actions} />
      <NewRequestDialog model={model} actions={actions} />
      <EraseDialog model={model.erase} canErase={model.can.erase} actions={actions?.erase} />
      <StepUpModal
        open={model.stepUp.open}
        title={t('dp.stepUp.title')}
        sentence={model.stepUp.sentence.startsWith('dp.') ? t(model.stepUp.sentence) : admin(model.stepUp.sentence)}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? admin(model.stepUp.problem) : null}
        confirmLabel={t('dp.stepUp.confirm')}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpClose?.()}
      />
    </section>
  )
}
