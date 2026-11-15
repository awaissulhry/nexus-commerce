'use client'

import { useMemo, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, FilePlus2, FileText, Send, Trash2, Undo2 } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ActionConfirm } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { leftCounts } from '../../../kit/bulk-model'
import { useKeysHelp, useLatest, useSelection } from '../../../kit/list'
import { adminHref } from '../../../shared/model'
import { BulkButton, FrameState, PageHead } from '../../../shared/view/parts'
import { editorHref, useKindWords } from '../../template-editor/view/DocTemplateEditorView'
import { printsNowHref } from '../api'
import { bulkReach, counts, openTarget, rowHeld, rowsOf, startHeld, type DocBulk, type DocRow, type DocTemplatesModel } from '../model'
import { usePageViewKeyList, usePageViewKeys, ViewSwitch, type PageView } from './ViewSwitch'
import '../../documents.css'
import '../../template-editor/templates.css'
import { useTplWords } from '../../template-editor/view/words'

/**
 * SCR-630 — Admin › Documents › Document templates (B-W2b-432; design admin.documents sec:doc-templates, PLT-231): the
 * company's layouts per document and language on the shared list frame (select-all, shift range, x; key hints only in the
 * footer icon) — the version in use or "Fixed layout", the open draft, the versions kept, the layout it prints with, the
 * last change; Preview opens what prints now (a PDF in a new tab); a row opens its editor (SCR-631); "Write a template"
 * starts the first draft; the selected rows' drafts are published or deleted, their versions in use retired, each after
 * the DS ActionConfirm. Draws one view model; DocTemplatesSection.tsx reads and writes.
 */

export interface DocTemplatesActions {
  onView?: (view: PageView) => void
  onCompany?: (companyId: string) => void
  onSelect?: (ids: string[]) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onStart?: (row: DocRow) => void
  /** Enter on a row: its editor (its draft, else the version in use). */
  onOpen?: (row: DocRow) => void
  onBulk?: (action: DocBulk | null, rows?: readonly DocRow[]) => void
  onBulkGo?: () => void
  onDismissNotice?: () => void
}

export const DOC_TEMPLATE_NAMESPACES = ['admin', 'records', 'admin-documents', 'admin-templates'] as const

export function DocTemplatesView({ model, actions }: { model: DocTemplatesModel; actions?: DocTemplatesActions }) {
  return (
    <WithMessages namespaces={DOC_TEMPLATE_NAMESPACES}>
      <DocTemplates model={model} actions={actions} />
    </WithMessages>
  )
}

function DocTemplates({ model, actions }: { model: DocTemplatesModel; actions?: DocTemplatesActions }) {
  const t = useTplWords()
  const locale = useLocale()
  const words = useKindWords()
  const answer = model.read.status === 'ready' ? model.read.answer : null
  const rows = useMemo(() => rowsOf(answer), [answer])
  const mayManage = answer?.mayManage ?? false
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, rows.map((row) => row.id))
  const latest = useLatest({ model, actions })
  usePageViewKeys(actions?.onView, !!model.confirm)
  const keys = usePageViewKeyList()
  const { onHelp, help } = useKeysHelp(keys, true)
  const company = model.companies.find((entry) => entry.id === model.companyId)?.name ?? '—'
  const nameOfId = (id: string) => {
    const [kind = '', language = ''] = id.split(':')
    return `${words.kind(kind)} (${words.language(language)})`
  }

  const columns = useMemo<ColDef<DocRow>[]>(() => {
    const stop = (event: MouseEvent) => event.stopPropagation()
    return [
      {
        colId: 'document',
        headerName: t('tpl.list.col.document'),
        flex: 1.3,
        minWidth: 170,
        cellRenderer: ({ data }: ICellRendererParams<DocRow>) => {
          if (!data) return null
          const target = openTarget(data)
          const name = words.kind(data.kind)
          return target ? (
            <Link className="fw-adm-name" href={editorHref(latest.current.model.prefix, target)} onClick={stop}>
              {name}
            </Link>
          ) : (
            <span className="fw-adm-name">{name}</span>
          )
        },
      },
      { colId: 'language', headerName: t('tpl.list.col.language'), flex: 0.8, minWidth: 105, valueGetter: ({ data }) => (data ? words.language(data.language) : '') },
      {
        colId: 'inUse',
        headerName: t('tpl.list.col.inUse'),
        flex: 1.2,
        minWidth: 170,
        cellRenderer: ({ data }: ICellRendererParams<DocRow>) =>
          !data ? null : data.slot.active ? (
            <span className="fw-tpl-cell">
              <span>
                <Pill tone="success">{t('tpl.editor.version', { revision: data.slot.active.revision })}</Pill>
              </span>
              <span className="fw-adm-hint">{t('tpl.list.since', { date: formatDate(data.slot.active.at, { locale }) })}</span>
            </span>
          ) : (
            <span className="fw-adm-hint">{t('tpl.list.fixed')}</span>
          ),
      },
      {
        colId: 'draft',
        headerName: t('tpl.list.col.draft'),
        flex: 1.1,
        minWidth: 150,
        cellRenderer: ({ data }: ICellRendererParams<DocRow>) =>
          !data ? null : data.slot.draft ? (
            <Link className="fw-adm-docs-link" href={editorHref(latest.current.model.prefix, data.slot.draft.id)} onClick={stop}>
              {t('tpl.list.draftOf', { revision: data.slot.draft.revision })}
            </Link>
          ) : (
            <span className="fw-adm-hint">—</span>
          ),
      },
      { colId: 'versions', headerName: t('tpl.list.col.versions'), flex: 0.6, minWidth: 95, valueGetter: ({ data }) => (data ? String(data.slot.versions) : '') },
      { colId: 'layout', headerName: t('tpl.list.col.layout'), flex: 0.9, minWidth: 140, cellRenderer: ({ data }: ICellRendererParams<DocRow>) => (data ? <code className="fw-adm-code">{data.slot.layout}</code> : null) },
      { colId: 'changed', headerName: t('tpl.list.col.changed'), flex: 1, minWidth: 145, valueGetter: ({ data }) => (data ? (data.slot.lastChangedAt ? formatDateTime(data.slot.lastChangedAt, { locale }) : t('tpl.list.never')) : '') },
      {
        colId: 'actions',
        headerName: t('tpl.list.col.actions'),
        flex: 1.3,
        minWidth: 230,
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<DocRow>) => {
          if (!data) return null
          const { model: now, actions: act } = latest.current
          const manage = now.read.status === 'ready' && now.read.answer.mayManage
          const held = startHeld(manage, !!now.busy)
          return (
            <span className="fw-tpl-row-actions" onClick={stop}>
              {now.companyId && (
                <a className="fw-adm-docs-link" href={printsNowHref(now.companyId, data.kind, data.language)} target="_blank" rel="noopener noreferrer">
                  {t('tpl.list.preview')} <ExternalLink size={12} aria-hidden />
                  <span className="fw-adm-sr">{t('tpl.newTab')}</span>
                </a>
              )}
              {!data.slot.active && !data.slot.draft && (
                <Button size="sm" heldReason={held ? t(held) : null} onClick={() => act?.onStart?.(data)}>
                  <FilePlus2 size={13} aria-hidden /> {t('tpl.list.start')}
                </Button>
              )}
            </span>
          )
        },
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, words])

  const chosen = rows.filter((row) => selected.includes(row.id))
  const publish = bulkReach(chosen, 'publish')
  const retire = bulkReach(chosen, 'retire')
  const remove = bulkReach(chosen, 'delete')
  const held = (reach: { applies: readonly DocRow[] }) => (!mayManage ? t('tpl.held.noRight') : reach.applies.length === 0 ? t('tpl.bulk.none') : model.busy ? t('tpl.held.busy') : null)
  const tally = counts(rows)

  const state: ReactNode =
    model.read.status === 'failed' ? (
      <FrameState problem={model.read.problem} onRetry={actions?.onRetry} />
    ) : !model.companyId ? (
      <FrameState empty={{ icon: <FileText size={24} aria-hidden />, title: t('tpl.list.noCompanyTitle'), body: t('tpl.list.noCompany') }} />
    ) : undefined

  return (
    <div className="fw-adm fw-adm-docs fw-tpl-list">
      <PageHead intro={t('tpl.list.intro')} asOf={model.asOf ?? null} />
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
      {!!model.legalMissing && model.companyId && (
        <Banner
          tone="warning"
          title={t('tpl.list.notReady', { name: company, count: model.legalMissing })}
          action={
            <Link className="fw-adm-docs-link" href={adminHref(model.prefix, `/companies/${model.companyId}?tab=legal`)}>
              {t('tpl.preview.fixLegal')}
            </Link>
          }
        />
      )}
      <ListFrame<DocRow>
        label={t('tpl.list.label')}
        rows={model.read.status === 'loading' ? null : state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={answer ? t('tpl.list.count', { inUse: tally.inUse, drafts: tally.drafts, fixed: tally.fixed }) : '—'}
        tools={<ViewSwitch view="documents" companies={model.companies} companyId={model.companyId} onView={actions?.onView} onCompany={actions?.onCompany} />}
        selection={{
          selected,
          onChange,
          actions: (
            <>
              <BulkButton icon={<Send size={13} aria-hidden />} tone="primary" label={t('tpl.bulk.publish', { count: publish.applies.length })} held={held(publish)} onClick={() => actions?.onBulk?.('publish', publish.applies)} />
              <BulkButton icon={<Undo2 size={13} aria-hidden />} label={t('tpl.bulk.retire', { count: retire.applies.length })} held={held(retire)} onClick={() => actions?.onBulk?.('retire', retire.applies)} />
              <BulkButton icon={<Trash2 size={13} aria-hidden />} tone="danger-outline" label={t('tpl.bulk.delete', { count: remove.applies.length })} held={held(remove)} onClick={() => actions?.onBulk?.('delete', remove.applies)} />
            </>
          ),
        }}
        isRowSelectable={(row) => {
          const why = rowHeld(row, mayManage)
          return why ? t(why) : null
        }}
        updates={model.updates ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        onOpen={(row) => actions?.onOpen?.(row)}
        keys={keys}
        onHelp={onHelp}
        state={state}
      />
      <p className="fw-adm-hint">{t('tpl.list.fallback')}</p>
      <BulkConfirm model={model} actions={actions} selected={chosen} />
      {help}
    </div>
  )
}

function BulkConfirm({ model, actions, selected }: { model: DocTemplatesModel; actions?: DocTemplatesActions; selected: readonly DocRow[] }) {
  const t = useTplWords()
  const words = useKindWords()
  const confirm = model.confirm
  if (!confirm) return null
  const name = (row: DocRow) => `${words.kind(row.kind)} (${words.language(row.language)})`
  const reach = bulkReach(selected.length > 0 ? selected : confirm.rows, confirm.action)
  const left = leftCounts(reach).map((entry) => t(entry.why, { count: entry.count }))
  const count = confirm.rows.length
  const busy = !!model.busy
  const impact =
    confirm.action === 'publish'
      ? { title: t('tpl.bulk.publishTitle', { count }), confirmLabel: busy ? t('tpl.busy') : t('tpl.bulk.publish', { count }), consequences: [...confirm.rows.map((row) => t('tpl.bulk.publishOne', { name: name(row), revision: row.slot.draft?.revision ?? 0 })), t('tpl.confirm.publishFrozen'), ...left], reversal: { verb: t('tpl.confirm.publishBack'), fidelity: 'exact' as const } }
      : confirm.action === 'retire'
        ? { title: t('tpl.bulk.retireTitle', { count }), confirmLabel: busy ? t('tpl.busy') : t('tpl.bulk.retire', { count }), consequences: [...confirm.rows.map((row) => t('tpl.bulk.retireOne', { name: name(row), revision: row.slot.active?.revision ?? 0 })), t('tpl.confirm.retireKept'), ...left], reversal: { verb: t('tpl.confirm.retireBack'), fidelity: 'lossy' as const } }
        : { title: t('tpl.bulk.deleteTitle', { count }), confirmLabel: busy ? t('tpl.busy') : t('tpl.bulk.delete', { count }), consequences: [...confirm.rows.map((row) => t('tpl.bulk.deleteOne', { name: name(row), revision: row.slot.draft?.revision ?? 0 })), ...left], reversal: { verb: t('tpl.confirm.deleteBack'), fidelity: 'none' as const } }
  return (
    <ActionConfirm
      impact={{ level: 'confirm', reach: 'local', ...impact, ...(confirm.action === 'delete' ? { acknowledge: t('tpl.confirm.deleteAck') } : {}) }}
      onConfirm={() => actions?.onBulkGo?.()}
      onCancel={() => (busy ? undefined : actions?.onBulk?.(null))}
    />
  )
}
