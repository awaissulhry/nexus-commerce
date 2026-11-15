'use client'

import { useMemo, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { FilePlus2, Mail, Send, Trash2, Undo2 } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ActionConfirm } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { leftCounts } from '../../../kit/bulk-model'
import { useKeysHelp, useLatest, useSelection } from '../../../kit/list'
import { BulkButton, FrameState, PageHead } from '../../../shared/view/parts'
import { DOC_TEMPLATE_NAMESPACES } from '../../doc-templates/view/DocTemplatesView'
import { usePageViewKeyList, usePageViewKeys, ViewSwitch, type PageView } from '../../doc-templates/view/ViewSwitch'
import { useKindWords } from '../../template-editor/view/DocTemplateEditorView'
import { mailEditorHref } from '../../template-editor/view/MailTemplateEditorView'
import { draftsOf, mailBulkReach, mailOpenTarget, mailRowHeld, mailRowsOf, mailStarts, type MailBulk, type MailRow, type MailTemplatesModel } from '../model'
import '../../documents.css'
import '../../template-editor/templates.css'
import { useTplWords } from '../../template-editor/view/words'

/**
 * SCR-632 — Admin › Documents › E-mail templates (B-W2b-432; design admin.documents sec:mail-templates, PLT-232): the mails
 * whose words take a template, per event and language, on the shared list frame — what the company's mail goes out with now
 * (its own version, every company's, the code's words) and its subject, the open drafts, the last change; a row opens the
 * version that decides it (SCR-633); "Write this company's" / "Write every company's" start a first draft; the selected
 * rows' drafts are published or deleted, the company's own version put back to the default, each after the DS ActionConfirm.
 * Nothing is sent from here. Draws one view model; MailTemplatesSection.tsx reads and writes.
 */

export interface MailTemplatesActions {
  onView?: (view: PageView) => void
  onCompany?: (companyId: string) => void
  onSelect?: (ids: string[]) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (row: MailRow) => void
  onStart?: (row: MailRow, scope: 'company' | 'all') => void
  onBulk?: (action: MailBulk | null, rows?: readonly MailRow[]) => void
  onBulkGo?: () => void
  onDismissNotice?: () => void
}

export function MailTemplatesView({ model, actions }: { model: MailTemplatesModel; actions?: MailTemplatesActions }) {
  return (
    <WithMessages namespaces={DOC_TEMPLATE_NAMESPACES}>
      <MailTemplates model={model} actions={actions} />
    </WithMessages>
  )
}

function MailTemplates({ model, actions }: { model: MailTemplatesModel; actions?: MailTemplatesActions }) {
  const t = useTplWords()
  const locale = useLocale()
  const words = useKindWords()
  const answer = model.read.status === 'ready' ? model.read.answer : null
  const rows = useMemo(() => mailRowsOf(answer), [answer])
  const may = answer?.list.mayManage ?? { company: false, all: false }
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, rows.map((row) => row.id))
  const latest = useLatest({ model, actions })
  usePageViewKeys(actions?.onView, !!model.confirm)
  const keys = usePageViewKeyList()
  const { onHelp, help } = useKeysHelp(keys, true)
  const nameOfId = (id: string) => {
    const at = id.lastIndexOf(':')
    return `${t(`tpl.event.${id.slice(0, at)}`)} (${words.language(id.slice(at + 1))})`
  }

  const columns = useMemo<ColDef<MailRow>[]>(() => {
    const stop = (event: MouseEvent) => event.stopPropagation()
    return [
      {
        colId: 'event',
        headerName: t('tpl.mailList.col.event'),
        flex: 1.4,
        minWidth: 190,
        cellRenderer: ({ data }: ICellRendererParams<MailRow>) => {
          if (!data) return null
          const target = mailOpenTarget(data)
          const name = t(`tpl.event.${data.event}`)
          return (
            <span className="fw-tpl-cell">
              {target ? (
                <Link className="fw-adm-name" href={mailEditorHref(latest.current.model.prefix, target)} onClick={stop}>
                  {name}
                </Link>
              ) : (
                <span className="fw-adm-name">{name}</span>
              )}
              <span className="fw-adm-hint">{t(`tpl.eventWhen.${data.event}`)}</span>
            </span>
          )
        },
      },
      { colId: 'language', headerName: t('tpl.list.col.language'), flex: 0.7, minWidth: 110, valueGetter: ({ data }) => (data ? words.language(data.language) : '') },
      {
        colId: 'inUse',
        headerName: t('tpl.mailList.col.inUse'),
        flex: 1.2,
        minWidth: 180,
        cellRenderer: ({ data }: ICellRendererParams<MailRow>) => {
          if (!data) return null
          const version = data.slot.inUse === 'COMPANY' ? data.slot.company.active : data.slot.inUse === 'ALL' ? data.slot.all.active : null
          return (
            <span className="fw-tpl-cell">
              <span>
                <Pill tone={data.slot.inUse === 'CODE' ? 'neutral' : 'success'}>{t(`tpl.inUse.${data.slot.inUse}`)}</Pill>
              </span>
              {version && <span className="fw-adm-hint">{t('tpl.editor.version', { revision: version.revision })}</span>}
            </span>
          )
        },
      },
      { colId: 'subject', headerName: t('tpl.mailList.col.subject'), flex: 2, minWidth: 240, tooltipValueGetter: ({ data }) => data?.subject ?? '', valueGetter: ({ data }) => (data ? (data.subject ?? '—') : '') },
      {
        colId: 'drafts',
        headerName: t('tpl.mailList.col.drafts'),
        flex: 1.3,
        minWidth: 190,
        cellRenderer: ({ data }: ICellRendererParams<MailRow>) => {
          if (!data) return null
          const prefix = latest.current.model.prefix
          const drafts = [data.slot.company.draft ? { id: data.slot.company.draft.id, words: t('tpl.mailList.companyDraft', { revision: data.slot.company.draft.revision }) } : null, data.slot.all.draft ? { id: data.slot.all.draft.id, words: t('tpl.mailList.allDraft', { revision: data.slot.all.draft.revision }) } : null].filter((entry): entry is { id: string; words: string } => entry !== null)
          if (drafts.length === 0) return <span className="fw-adm-hint">—</span>
          return (
            <span className="fw-tpl-cell">
              {drafts.map((draft) => (
                <Link key={draft.id} className="fw-adm-docs-link" href={mailEditorHref(prefix, draft.id)} onClick={stop}>
                  {draft.words}
                </Link>
              ))}
            </span>
          )
        },
      },
      { colId: 'changed', headerName: t('tpl.list.col.changed'), flex: 1, minWidth: 150, valueGetter: ({ data }) => (data ? (data.slot.lastChangedAt ? formatDateTime(data.slot.lastChangedAt, { locale }) : t('tpl.list.never')) : '') },
      {
        colId: 'actions',
        headerName: t('tpl.list.col.actions'),
        flex: 1.3,
        minWidth: 220,
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<MailRow>) => {
          if (!data) return null
          const { model: now, actions: act } = latest.current
          const rights = now.read.status === 'ready' ? now.read.answer.list.mayManage : { company: false, all: false }
          const starts = mailStarts(data, rights)
          if (starts.length === 0) return null
          return (
            <span className="fw-tpl-row-actions" onClick={stop}>
              {starts.map((scope) => (
                <Button key={scope} size="sm" heldReason={now.busy ? t('tpl.held.busy') : null} onClick={() => act?.onStart?.(data, scope)}>
                  <FilePlus2 size={13} aria-hidden /> {t(scope === 'company' ? 'tpl.mailList.startCompany' : 'tpl.mailList.startAll')}
                </Button>
              ))}
            </span>
          )
        },
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, words])

  const chosen = rows.filter((row) => selected.includes(row.id))
  const publish = mailBulkReach(chosen, 'publish', may)
  const retire = mailBulkReach(chosen, 'retire', may)
  const remove = mailBulkReach(chosen, 'delete', may)
  const noRight = !may.company && !may.all
  const held = (reach: { applies: readonly MailRow[] }) => (noRight ? t('tpl.held.noRight') : reach.applies.length === 0 ? t('tpl.bulk.none') : model.busy ? t('tpl.held.busy') : null)
  const inUse = rows.filter((row) => row.slot.inUse !== 'CODE').length

  const state: ReactNode =
    model.read.status === 'failed' ? (
      <FrameState problem={model.read.problem} onRetry={actions?.onRetry} />
    ) : !model.companyId ? (
      <FrameState empty={{ icon: <Mail size={24} aria-hidden />, title: t('tpl.list.noCompanyTitle'), body: t('tpl.list.noCompany') }} />
    ) : undefined

  return (
    <div className="fw-adm fw-adm-docs fw-tpl-list">
      <PageHead intro={t('tpl.mailList.intro')} asOf={model.asOf ?? null} />
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('tpl.dismiss')}
            </Button>
          }
        >
          {model.notice.refused && model.notice.refused.length > 0 && (
            <ul className="fw-adm-list">
              {model.notice.refused.map((entry) => (
                <li key={entry.id}>
                  {nameOfId(entry.id)}: {t(entry.said.key, entry.said.params)}
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      <ListFrame<MailRow>
        label={t('tpl.mailList.label')}
        rows={model.read.status === 'loading' ? null : state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={answer ? t('tpl.mailList.count', { count: rows.length, inUse }) : '—'}
        tools={<ViewSwitch view="mail" companies={model.companies} companyId={model.companyId} onView={actions?.onView} onCompany={actions?.onCompany} />}
        selection={{
          selected,
          onChange,
          actions: (
            <>
              <BulkButton icon={<Send size={13} aria-hidden />} tone="primary" label={t('tpl.bulk.publish', { count: publish.applies.length })} held={held(publish)} onClick={() => actions?.onBulk?.('publish', publish.applies)} />
              <BulkButton icon={<Undo2 size={13} aria-hidden />} label={t('tpl.mailList.bulkRetire', { count: retire.applies.length })} held={held(retire)} onClick={() => actions?.onBulk?.('retire', retire.applies)} />
              <BulkButton icon={<Trash2 size={13} aria-hidden />} tone="danger-outline" label={t('tpl.bulk.delete', { count: remove.applies.length })} held={held(remove)} onClick={() => actions?.onBulk?.('delete', remove.applies)} />
            </>
          ),
        }}
        isRowSelectable={(row) => {
          const why = mailRowHeld(row, may)
          return why ? t(why) : null
        }}
        updates={model.updates ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        onOpen={(row) => actions?.onOpen?.(row)}
        keys={keys}
        onHelp={onHelp}
        state={state}
      />
      <p className="fw-adm-hint">{t('tpl.mailList.fallback')}</p>
      <MailBulkConfirm model={model} actions={actions} selected={chosen} nameOf={(row) => nameOfId(row.id)} />
      {help}
    </div>
  )
}

function MailBulkConfirm({ model, actions, selected, nameOf }: { model: MailTemplatesModel; actions?: MailTemplatesActions; selected: readonly MailRow[]; nameOf: (row: MailRow) => string }) {
  const t = useTplWords()
  const confirm = model.confirm
  if (!confirm) return null
  const may = model.read.status === 'ready' ? model.read.answer.list.mayManage : { company: false, all: false }
  const count = confirm.rows.length
  const busy = !!model.busy
  const versions = (row: MailRow) => draftsOf(row, may).map((draft) => (draft.companyId === null ? t('tpl.mailList.allDraft', { revision: draft.revision }) : t('tpl.mailList.companyDraft', { revision: draft.revision }))).join(' · ')
  const left = leftCounts(mailBulkReach(selected.length > 0 ? selected : confirm.rows, confirm.action, may)).map((entry) => t(entry.why, { count: entry.count }))
  const impact =
    confirm.action === 'publish'
      ? { title: t('tpl.bulk.publishTitle', { count }), confirmLabel: busy ? t('tpl.busy') : t('tpl.bulk.publish', { count }), consequences: [...confirm.rows.map((row) => `${nameOf(row)}: ${versions(row)}`), t('tpl.confirm.publishFrozen'), ...left], reversal: { verb: t('tpl.confirm.publishBack'), fidelity: 'exact' as const } }
      : confirm.action === 'retire'
        ? { title: t('tpl.mailList.retireTitle', { count }), confirmLabel: busy ? t('tpl.busy') : t('tpl.mailList.bulkRetire', { count }), consequences: [...confirm.rows.map((row) => t('tpl.mailList.retireOne', { name: nameOf(row), revision: row.companyActive?.revision ?? 0 })), t('tpl.confirm.retireKept'), ...left], reversal: { verb: t('tpl.confirm.retireBack'), fidelity: 'lossy' as const } }
        : { title: t('tpl.bulk.deleteTitle', { count }), confirmLabel: busy ? t('tpl.busy') : t('tpl.bulk.delete', { count }), consequences: [...confirm.rows.map((row) => `${nameOf(row)}: ${versions(row)}`), ...left], reversal: { verb: t('tpl.confirm.deleteBack'), fidelity: 'none' as const } }
  return (
    <ActionConfirm
      impact={{ level: 'confirm', reach: 'local', ...impact, ...(confirm.action === 'delete' ? { acknowledge: t('tpl.confirm.deleteAck') } : {}) }}
      onConfirm={() => actions?.onBulkGo?.()}
      onCancel={() => (busy ? undefined : actions?.onBulk?.(null))}
    />
  )
}
