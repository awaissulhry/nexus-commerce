'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Inbox, RotateCcw, XCircle } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { type ColDef } from '@nexus/ui/grid'
import { Button, Pill, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { ActionConfirm, DetailModal, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Translate } from '../../../../../lib/i18n/messages'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { cellOf } from '../../../shared/view/cells'
import { BulkButton, FrameState, ListKeysHelp } from '../../../shared/view/parts'
import type { ErrorDetail, ErrorItem, ErrorList, ErrorView } from '../api'
import { bulkHeldKey, bulkReach, dismissHeldKey, dismissProblem, fixHref, operationWords, reasonWords, retryHeldKey, serviceKey, STATE_TONE, stateKey, VIEW_ORDER, viewCount, DISMISS_MAX } from '../model'
import '../errors.css'

export interface ErrorQueueModel {
  prefix: string
  view: ErrorView
  list: { items: readonly ErrorItem[] | null; counts: ErrorList['counts'] | null; problem: string | null; nextBefore: string | null; loadingMore: boolean }
  /** The person may retry or dismiss (integrations.errors.manage over the items' companies). */
  canManage: boolean
  selected: readonly string[]
  /** The open item (`?error=`), read alone with what failed in its source's words. */
  open: { id: string; item: ErrorItem | null; detail: ErrorDetail | null; problem: string | null } | null
  /** Dismiss one or many: one reason for all. */
  dismiss: { ids: readonly string[]; reason: string; busy: boolean; problem: string | null; tried: boolean } | null
  /** Retry many: the confirm. */
  retryMany: { ids: readonly string[]; busy: boolean } | null
  /** The item a single Retry is sending. */
  busyId: string | null
  notice: { key: string; tone: 'success' | 'warning' | 'danger'; params: Record<string, string | number> } | null
  /** Live changes waiting behind "N updates · Show". */
  updates: number
}

export interface ErrorQueueActions {
  onView?: (view: ErrorView) => void
  onSelect?: (ids: string[]) => void
  onOpen?: (itemId: string | null) => void
  onRetry?: (item: ErrorItem) => void
  onRetryMany?: (ids: readonly string[] | null) => void
  onRetryManyGo?: () => void
  onDismiss?: (ids: readonly string[] | null) => void
  onDismissReason?: (reason: string) => void
  onDismissGo?: () => void
  onMore?: () => void
  onRetryRead?: () => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
}

/** The section's words: its own (`admin-integration-health`, prefix `aih.`), the services' names (`admin-connections`), Admin's. */
export function ErrorQueueMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['admin', 'admin-connections', 'admin-integration-health']}>{children}</WithMessages>
}

function useWords() {
  const t = useT('admin-integration-health')
  const tc = useT('admin-connections')
  const ta = useT('admin')
  const locale = useLocale()
  return useMemo(() => {
    const time = (iso: string) => formatDateTime(iso, { locale })
    const what = (item: ErrorItem) => {
      const words = operationWords(item)
      return t(words.key, words.params)
    }
    const why = (item: Pick<ErrorItem, 'reasonCode'>) => {
      const words = reasonWords(item.reasonCode)
      return t(words.key, words.params)
    }
    const service = (item: Pick<ErrorItem, 'provider'>) => {
      const key = serviceKey(item)
      return item.provider ? tc(key) : t(key)
    }
    return { t, tc, ta, time, what, why, service }
  }, [t, tc, ta, locale])
}
type Words = ReturnType<typeof useWords>

/** The queue's columns (exported: a test draws each cell alone). */
export function errorColumns(words: Pick<Words, 't' | 'time' | 'what' | 'why' | 'service'>): ColDef<ErrorItem>[] {
  const { t } = words
  return [
    { colId: 'at', headerName: t('aih.col.time'), valueGetter: ({ data }) => data?.lastFailedAt ?? '', width: 160, cellRenderer: cellOf<ErrorItem>((item) => words.time(item.lastFailedAt)) },
    { colId: 'service', headerName: t('aih.col.service'), valueGetter: ({ data }) => (data ? words.service(data) : ''), flex: 0.9, minWidth: 140 },
    {
      colId: 'what',
      headerName: t('aih.col.what'),
      valueGetter: ({ data }) => (data ? words.what(data) : ''),
      flex: 1.4,
      minWidth: 200,
      cellRenderer: cellOf<ErrorItem>((item) => (
        <span className="fw-aih-cell">
          <span className="fw-adm-name">{words.what(item)}</span>
          <span className="fw-adm-hint fw-adm-code">{item.operation}</span>
        </span>
      )),
    },
    {
      colId: 'reason',
      headerName: t('aih.col.reason'),
      valueGetter: ({ data }) => (data ? words.why(data) : ''),
      flex: 1.4,
      minWidth: 200,
      cellRenderer: cellOf<ErrorItem>((item) => (
        <span className="fw-aih-cell">
          <span>{words.why(item)}</span>
          {item.reasonText && <span className="fw-adm-hint fw-aih-quote">{item.reasonText}</span>}
        </span>
      )),
    },
    { colId: 'tries', headerName: t('aih.col.tries'), valueGetter: ({ data }) => data?.tries ?? 0, width: 90 },
    {
      colId: 'state',
      headerName: t('aih.col.state'),
      valueGetter: ({ data }) => (data ? t(stateKey(data)) : ''),
      width: 150,
      cellRenderer: cellOf<ErrorItem>((item) => <Pill tone={STATE_TONE[item.state]}>{t(stateKey(item))}</Pill>),
    },
  ]
}

/** The page head's band action: "Error queue (3)", to the section. */
export function ErrorQueueBand({ open }: { open: number | null }) {
  return (
    <ErrorQueueMessages>
      <Band open={open} />
    </ErrorQueueMessages>
  )
}

function Band({ open }: { open: number | null }) {
  const t = useT('admin-integration-health')
  return (
    <Button size="sm" variant={open ? 'danger-outline' : 'secondary'} asChild>
      <a href="#errors">{open === null ? t('aih.band.loading') : t('aih.band.open', { count: open })}</a>
    </Button>
  )
}

/**
 * Admin › Connections & API › Error queue (SCR-087 section `errors`, B-W2b-415; PLT-201; SCR-600): failed messages in and out
 * — time, the service, what failed, the reason (and the provider's own message, as data), tries, the state — in the Office
 * list frame: Waiting · Sent again · Dismissed · All; tick items to Retry N (a confirm) or Dismiss N (one reason); a row opens
 * the item (pop:error-item, J / K) with Retry, Edit and retry (where a failed call is fixed) and Dismiss. A held action says
 * why. Fetches nothing (use-error-queue.ts).
 */
export function ErrorQueueSection({ model, actions }: { model: ErrorQueueModel; actions?: ErrorQueueActions }) {
  return (
    <ErrorQueueMessages>
      <Section model={model} actions={actions} />
    </ErrorQueueMessages>
  )
}

function Section({ model, actions }: { model: ErrorQueueModel; actions?: ErrorQueueActions }) {
  const words = useWords()
  const { t, ta } = words
  const [help, setHelp] = useState(false)
  const columns = useMemo(() => errorColumns(words), [words])
  const items = model.list.items
  const ticked = (items ?? []).filter((item) => model.selected.includes(item.id))
  const retryReach = bulkReach(ticked, 'retry')
  const dismissReach = bulkReach(ticked, 'dismiss')
  const state = model.list.problem ? (
    <FrameState problem={model.list.problem} onRetry={actions?.onRetryRead} />
  ) : items && items.length === 0 ? (
    <FrameState empty={{ icon: <Inbox size={24} aria-hidden />, title: t(`aih.empty.${model.view}.title`), body: t(`aih.empty.${model.view}.body`) }} />
  ) : undefined
  const viewLabel = (view: ErrorView) => {
    const count = viewCount(view, model.list.counts)
    return count === null ? t(`aih.view.${view}`) : t('aih.view.withCount', { view: t(`aih.view.${view}`), count })
  }
  return (
    <section id="errors" aria-labelledby="aih-errors" className="fw-adm-list-section fw-aih">
      <Card header={<span id="aih-errors">{t('aih.errors.title')}</span>} description={t('aih.errors.hint')} headingLevel={2} padded>
        <div className="fw-aih-stack">
          {model.notice && <Banner tone={model.notice.tone} title={model.notice.key.startsWith('aih.') ? t(model.notice.key, model.notice.params) : ta(model.notice.key)} onDismiss={actions?.onDismissNotice} />}
          <ListFrame<ErrorItem>
            label={t('aih.errors.title')}
            listKey="admin.connections.errors"
            title={t('aih.errors.title')}
            rows={model.list.problem ? [] : items}
            rowId={(item) => item.id}
            columns={columns}
            count={items ? t('aih.count', { count: items.length }) : '—'}
            tools={
              <SegmentedControl
                ariaLabel={t('aih.view.label')}
                size="sm"
                value={model.view}
                onChange={(value) => actions?.onView?.(value as ErrorView)}
                options={VIEW_ORDER.map((view) => ({ value: view, label: viewLabel(view) }))}
              />
            }
            selection={{
              selected: model.selected,
              onChange: (ids) => actions?.onSelect?.(ids),
              actions: (
                <>
                  <BulkButton
                    icon={<RotateCcw size={13} aria-hidden />}
                    label={t('aih.bulk.retry', { count: retryReach.applies.length })}
                    held={heldWords(t, bulkHeldKey(ticked, 'retry', model.canManage))}
                    onClick={() => actions?.onRetryMany?.(model.selected)}
                  />
                  <BulkButton
                    icon={<XCircle size={13} aria-hidden />}
                    label={t('aih.bulk.dismiss', { count: dismissReach.applies.length })}
                    held={heldWords(t, bulkHeldKey(ticked, 'dismiss', model.canManage))}
                    tone="danger-outline"
                    onClick={() => actions?.onDismiss?.(model.selected)}
                  />
                </>
              ),
            }}
            isRowSelectable={(item) => (item.retry.held && item.dismiss.held ? t(dismissHeldKey(item) ?? 'aih.held.dismiss.DISMISSED') : null)}
            updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
            more={items && items.length > 0 && model.list.nextBefore ? { label: t('aih.older'), onMore: () => actions?.onMore?.(), held: model.list.loadingMore ? t('aih.held.loading') : null } : null}
            onHelp={() => setHelp(true)}
            onOpen={(item) => actions?.onOpen?.(item.id)}
            state={state}
          />
          <p className="fw-adm-hint">{t('aih.errors.rule')}</p>
        </div>
      </Card>
      <ErrorItemModal model={model} actions={actions} />
      <DismissDialog model={model} actions={actions} />
      <RetryManyConfirm model={model} actions={actions} />
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection />
    </section>
  )
}

const heldWords = (t: Translate, key: string | null): string | null => (key ? t(key) : null)

/** pop:error-item — one failed message: the reason in words, what its source says (no secret), tries, Retry / Edit and retry / Dismiss. */
function ErrorItemModal({ model, actions }: { model: ErrorQueueModel; actions?: ErrorQueueActions }) {
  const words = useWords()
  const { t, ta } = words
  const open = model.open
  const item = open?.item ?? null
  const ids = (model.list.items ?? []).map((row) => row.id)
  return (
    <DetailModal
      open={!!open && !model.dismiss}
      onClose={() => actions?.onOpen?.(null)}
      title={item ? words.what(item) : t('aih.item.title')}
      subtitle={item ? `${words.service(item)} · ${words.time(item.lastFailedAt)}` : undefined}
      meta={
        item ? (
          <>
            <Pill tone={STATE_TONE[item.state]}>{t(stateKey(item))}</Pill>
            <Tag>{t('aih.item.tries', { count: item.tries })}</Tag>
          </>
        ) : undefined
      }
      nav={open && ids.includes(open.id) ? { ids, current: open.id, onGo: (id) => actions?.onOpen?.(id), noun: t('aih.item.noun') } : undefined}
    >
      {!open ? null : open.problem ? (
        <Banner tone="danger" title={ta(open.problem)} />
      ) : !item ? (
        <p className="fw-adm-loading" role="status">
          <Spinner size={14} /> {t('aih.loading')}
        </p>
      ) : (
        <ErrorItemBody item={item} detail={open.detail} prefix={model.prefix} busy={model.busyId === item.id} actions={actions} />
      )}
    </DetailModal>
  )
}

/** The body of an open item (exported for the tests: the DetailModal draws its body only in the browser). */
export function ErrorItemBody({ item, detail, prefix, busy, actions }: { item: ErrorItem; detail: ErrorDetail | null; prefix: string; busy: boolean; actions?: ErrorQueueActions }) {
  const words = useWords()
  const { t } = words
  const retryHeld = busy ? t('aih.held.retrying') : retryHeldKey(item) ? t(retryHeldKey(item)!) : null
  const dismissHeld = dismissHeldKey(item) ? t(dismissHeldKey(item)!) : null
  const who = (person: ErrorDetail['retriedBy']) => (person === null ? '' : person.system ? t('aih.item.bySystem') : (person.name ?? t('aih.item.someone')))
  const source = detail?.source ?? null
  const items = [
    { label: t('aih.item.what'), value: words.what(item), hint: t('aih.item.code', { code: item.operation }) },
    { label: t('aih.item.reason'), value: words.why(item) },
    ...(item.reasonText ? [{ label: t('aih.item.theirWords'), value: <q className="fw-aih-quote">{item.reasonText}</q>, hint: t('aih.item.theirWordsHint') }] : []),
    { label: t('aih.item.service'), value: words.service(item) },
    { label: t('aih.item.firstFailed'), value: words.time(item.firstFailedAt) },
    { label: t('aih.item.lastFailed'), value: words.time(item.lastFailedAt) },
    ...(item.retriedAt ? [{ label: t('aih.item.retried'), value: words.time(item.retriedAt), hint: detail ? who(detail.retriedBy) : undefined }] : []),
    ...(item.dismissedAt ? [{ label: t('aih.item.dismissed'), value: words.time(item.dismissedAt), hint: detail ? who(detail.dismissedBy) : undefined }] : []),
    ...(item.dismissReason ? [{ label: t('aih.item.dismissReason'), value: item.dismissReason }] : []),
  ]
  return (
    <div className="fw-adm-modal-body fw-aih-stack">
      <KeyValue columns={2} labelCase="sentence" items={items} />
      <section aria-labelledby="fw-aih-source" className="fw-aih-block">
        <h3 id="fw-aih-source" className="fw-aih-sub">
          {t('aih.item.sourceTitle')}
        </h3>
        {source === null ? (
          <p className="fw-adm-loading" role="status">
            <Spinner size={14} /> {t('aih.loading')}
          </p>
        ) : (
          <SourceFacts source={source} />
        )}
      </section>
      <div className="fw-aih-actions">
        <Button size="sm" variant="primary" heldReason={retryHeld} onClick={() => actions?.onRetry?.(item)}>
          <RotateCcw size={13} aria-hidden /> {t('aih.action.retry')}
        </Button>
        {item.fixPlace ? (
          <Button size="sm" asChild>
            <Link href={fixHref(prefix, item.fixPlace)}>{t(`aih.action.fix.${item.fixPlace}`)}</Link>
          </Button>
        ) : (
          <Button size="sm" heldReason={t('aih.held.fix')}>
            {t('aih.action.editRetry')}
          </Button>
        )}
        <Button size="sm" variant="danger-outline" heldReason={dismissHeld} onClick={() => actions?.onDismiss?.([item.id])}>
          <XCircle size={13} aria-hidden /> {t('aih.action.dismiss')}
        </Button>
      </div>
    </div>
  )
}

function SourceFacts({ source }: { source: ErrorDetail['source'] }) {
  const words = useWords()
  const { t } = words
  if (source.kind === 'gone') return <p className="fw-adm-hint">{t('aih.item.gone')}</p>
  if (source.kind === 'event')
    return (
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('aih.src.eventType'), value: <code className="fw-adm-code">{source.type}</code> },
          { label: t('aih.src.occurred'), value: words.time(source.occurredAt) },
          { label: t('aih.src.status'), value: t(`aih.src.outbox.${source.status}`) },
          { label: t('aih.src.attempts'), value: String(source.attempts) },
        ]}
      />
    )
  if (source.kind === 'webhook')
    return (
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('aih.src.connection'), value: source.accountLabel ?? '—' },
          { label: t('aih.src.eventType'), value: source.eventType ? <code className="fw-adm-code">{source.eventType}</code> : '—' },
          { label: t('aih.src.received'), value: words.time(source.receivedAt) },
          { label: t('aih.src.status'), value: t(`aih.src.webhook.${source.status}`) },
          { label: t('aih.src.attempts'), value: String(source.attempts) },
          { label: t('aih.src.signature'), value: source.verified ? t('aih.src.verified') : t('aih.src.notVerified') },
          { label: t('aih.src.size'), value: t('aih.src.bytes', { count: source.bodyBytes }), hint: t('aih.src.noBody') },
        ]}
      />
    )
  return (
    <div className="fw-aih-stack">
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('aih.src.connection'), value: source.accountLabel ?? '—' },
          { label: t('aih.src.sent'), value: words.time(source.startedAt) },
          { label: t('aih.src.status'), value: t(`aih.src.call.${source.status}`) },
          { label: t('aih.src.attempts'), value: String(source.attempts) },
          { label: t('aih.src.answer'), value: source.httpStatus === null ? t('aih.src.noAnswer') : `HTTP ${source.httpStatus}` },
          { label: t('aih.src.duration'), value: t('aih.src.ms', { ms: source.durationMs }) },
        ]}
      />
      {(source.request.length > 0 || source.response.length > 0) && (
        <div>
          <p className="fw-adm-hint">{t('aih.src.summaryHint')}</p>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[...source.request.map((line) => ({ label: t('aih.src.asked', { key: line.key }), value: <code className="fw-adm-code">{line.value}</code> })), ...source.response.map((line) => ({ label: t('aih.src.answered', { key: line.key }), value: <code className="fw-adm-code">{line.value}</code> }))]}
          />
        </div>
      )}
    </div>
  )
}

/** Dismiss one or many with one reason (3-500 characters), kept with who and when. */
function DismissDialog({ model, actions }: { model: ErrorQueueModel; actions?: ErrorQueueActions }) {
  const { t, ta } = useWords()
  const dismiss = model.dismiss
  if (!dismiss) return null
  const rows = (model.list.items ?? []).filter((item) => dismiss.ids.includes(item.id))
  const fromOpen = rows.length === 0 && model.open?.item && dismiss.ids.includes(model.open.item.id) ? [model.open.item] : []
  const reach = bulkReach(rows.length > 0 ? rows : fromOpen, 'dismiss')
  const problem = dismiss.tried ? dismissProblem(dismiss.reason) : null
  return (
    <Modal
      open
      onClose={() => (dismiss.busy ? undefined : actions?.onDismiss?.(null))}
      title={t('aih.dismiss.title', { count: reach.applies.length })}
      size="sm"
      footer={
        <>
          <Button size="sm" onClick={() => actions?.onDismiss?.(null)} heldReason={dismiss.busy ? t('aih.held.saving') : null}>
            {t('aih.dismiss.cancel')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => actions?.onDismissGo?.()} heldReason={dismiss.busy ? t('aih.held.saving') : reach.applies.length === 0 ? t('aih.bulk.none.dismiss') : null}>
            {t('aih.dismiss.go', { count: reach.applies.length })}
          </Button>
        </>
      }
    >
      <div className="fw-aih-stack">
        <p>{t('aih.dismiss.body')}</p>
        {reach.left.map((entry) => (
          <p key={entry.key} className="fw-adm-hint">
            {t(entry.key, { count: entry.count })}
          </p>
        ))}
        <Field label={t('aih.dismiss.reason')} hint={t('aih.dismiss.reasonHint', { max: DISMISS_MAX })} error={problem ? t(problem) : undefined}>
          <Textarea value={dismiss.reason} maxLength={DISMISS_MAX} rows={3} onChange={(event) => actions?.onDismissReason?.(event.target.value)} aria-invalid={problem ? true : undefined} />
        </Field>
        {dismiss.problem && <Banner tone="danger" title={ta(dismiss.problem)} />}
      </div>
    </Modal>
  )
}

/** Retry N: what it sends again, and what it leaves out. */
function RetryManyConfirm({ model, actions }: { model: ErrorQueueModel; actions?: ErrorQueueActions }) {
  const words = useWords()
  const { t } = words
  const many = model.retryMany
  if (!many) return null
  const rows = (model.list.items ?? []).filter((item) => many.ids.includes(item.id))
  const reach = bulkReach(rows, 'retry')
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        title: t('aih.retryMany.title', { count: reach.applies.length }),
        confirmLabel: many.busy ? t('aih.held.saving') : t('aih.retryMany.go', { count: reach.applies.length }),
        consequences: [...reach.applies.map((item) => `${words.what(item)} · ${words.service(item)}`), t('aih.retryMany.once'), ...reach.left.map((entry) => t(entry.key, { count: entry.count }))],
        ...(reach.applies.length === 0 ? { unavailable: t('aih.bulk.none.retry') } : {}),
      }}
      onConfirm={() => actions?.onRetryManyGo?.()}
      onCancel={() => (many.busy ? undefined : actions?.onRetryMany?.(null))}
    />
  )
}
