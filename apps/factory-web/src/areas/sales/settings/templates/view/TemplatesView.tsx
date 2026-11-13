'use client'

import { useMemo, useRef, type MouseEvent } from 'react'
import { Archive, ArchiveRestore, FileStack, Plus } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { Section } from '../../../../quality/_shared/parts'
import type { TemplateRow } from '../../../quotes/new-from/api'
import { DEPTH_NS, type Tone, type Words } from '../../../quotes/record/lines-depth/model'
import { useDepthWords } from '../../../quotes/record/lines-depth/words'
import { movableTemplates, templatesShown, type TemplateStatusFilter } from '../model'
import { TemplateDialog, type TemplateDialogActions, type TemplateDialogModel } from './TemplateDialog'
import '../../../quotes/record/lines-depth/depth.css'

export interface TemplatesModel {
  rows: { status: 'loading' } | { status: 'ready'; value: TemplateRow[] } | { status: 'error'; problem: string }
  status: TemplateStatusFilter
  selected: readonly string[]
  /** The person may make templates (quotes.templates.manage). */
  mayCreate: boolean
  busy: boolean
  notice: { words: Words; tone: Tone } | null
  dialog: TemplateDialogModel | null
}

export interface TemplatesActions {
  onStatus?: (status: TemplateStatusFilter) => void
  onSelect?: (ids: string[]) => void
  onOpen?: (id: string | 'new') => void
  onMove?: (to: 'archive' | 'restore') => void
  onRetry?: () => void
  onDismissNotice?: () => void
  dialog?: TemplateDialogActions
}

/**
 * SCR-235 › Quote templates (design sales.settings sec:ssettings.templates, SAL-144; B-W2b-294's API): saved starts of a
 * quote — lines in sections, the validity, terms, the acceptance mode, the Incoterm — of a company or of every company, in
 * the ONE list frame (Template, Company, Lines, Used, Status). New template (empty, or from a quote: "a quote in template
 * mode"); a row opens it; Archive N / Restore N (never deleted). New quote › Start from: Template uses them.
 */
export function TemplatesView({ model, actions }: { model: TemplatesModel; actions?: TemplatesActions }) {
  return (
    <WithMessages namespaces={['sales', DEPTH_NS]}>
      <Templates model={model} actions={actions} />
    </WithMessages>
  )
}

function Templates({ model, actions }: { model: TemplatesModel; actions?: TemplatesActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const latest = useRef(actions)
  latest.current = actions
  const rows = model.rows.status === 'ready' ? templatesShown(model.rows.value, model.status) : null

  const columns = useMemo<ColDef<TemplateRow>[]>(() => {
    const open = (event: MouseEvent, id: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      latest.current?.onOpen?.(id)
    }
    const NameCell = ({ data }: ICellRendererParams<TemplateRow>) =>
      data ? (
        <button type="button" className="fw-qd-rowlink" onClick={(event) => open(event, data.id)}>
          <strong>{data.name}</strong>
          {data.description ? ` · ${data.description}` : ''}
        </button>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<TemplateRow>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`tpl.status.${data.status}`)}</Pill> : null)
    return [
      { colId: 'name', headerName: t('tpl.col.name'), minWidth: 240, flex: 2, cellRenderer: NameCell, valueGetter: (params) => params.data?.name ?? '' },
      { colId: 'company', headerName: t('tpl.col.company'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.company ? `${params.data.company.code} · ${params.data.company.name}` : t('tpl.everyCompany')) : '') },
      { colId: 'sections', headerName: t('tpl.col.sections'), minWidth: 180, flex: 1.2, valueGetter: (params) => (params.data?.sections.length ? params.data.sections.join(' · ') : '—') },
      { colId: 'lines', headerName: t('tpl.col.lines'), width: 100, type: 'rightAligned', valueGetter: (params) => params.data?.lineCount ?? null },
      { colId: 'used', headerName: t('tpl.col.used'), width: 100, type: 'rightAligned', valueGetter: (params) => params.data?.used ?? null },
      { colId: 'acceptance', headerName: t('tpl.col.acceptance'), minWidth: 160, valueGetter: (params) => (params.data ? t(`terms.acceptance.${params.data.acceptanceMode === 'PAY' ? 'SIGN_AND_PAY' : params.data.acceptanceMode}`) : '') },
      { colId: 'status', headerName: t('tpl.col.status'), minWidth: 120, cellRenderer: StatusCell, valueGetter: (params) => params.data?.status ?? '' },
      { colId: 'updated', headerName: t('tpl.col.updated'), minWidth: 120, valueGetter: (params) => (params.data ? formatDate(params.data.updatedAt, { locale }) : '') },
    ]
  }, [t, locale])

  const all = model.rows.status === 'ready' ? model.rows.value : []
  const heldMove = (to: 'archive' | 'restore') => (!model.mayCreate ? t('tpl.held.right') : model.busy ? t('common.working') : movableTemplates(all, model.selected, to).length === 0 ? t(to === 'archive' ? 'tpl.held.noneActive' : 'tpl.held.noneArchived') : null)
  const count = (to: 'archive' | 'restore') => movableTemplates(all, model.selected, to).length
  const keys: ListKey[] = [{ keys: ['c'], does: t('tpl.keys.new') }]
  return (
    <Section
      id="quote-templates"
      title={t('tpl.title')}
      sub={t('tpl.sub')}
      actions={
        <Button size="sm" variant="primary" heldReason={model.mayCreate ? null : t('tpl.held.right')} onClick={() => actions?.onOpen?.('new')}>
          <Plus size={14} aria-hidden /> {t('tpl.new')}
        </Button>
      }
    >
      <div className="fw-q-stack">
        {model.notice && (
          <Banner
            tone={model.notice.tone}
            title={say(model.notice.words)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('common.dismiss')}
              </Button>
            }
          />
        )}
        <ListFrame<TemplateRow>
          label={t('tpl.title')}
          title={t('tpl.title')}
          listKey={null}
          rows={model.rows.status === 'error' ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          count={rows ? t('tpl.count', { count: rows.length }) : t('common.loading')}
          tools={
            <SegmentedControl
              size="sm"
              ariaLabel={t('tpl.statusLabel')}
              value={model.status}
              onChange={(value) => actions?.onStatus?.(value as TemplateStatusFilter)}
              options={(['ACTIVE', 'ARCHIVED', 'ALL'] as const).map((value) => ({ value, label: t(`tpl.filter.${value}`) }))}
            />
          }
          selection={{
            selected: model.selected,
            onChange: (ids) => actions?.onSelect?.(ids),
            actions: (
              <>
                <Button size="sm" heldReason={heldMove('archive')} onClick={() => actions?.onMove?.('archive')} aria-label={t('tpl.bulk.archive', { count: count('archive') })}>
                  <Archive size={13} aria-hidden /> <SelectionLabel>{t('tpl.bulk.archive', { count: count('archive') })}</SelectionLabel>
                </Button>
                <Button size="sm" heldReason={heldMove('restore')} onClick={() => actions?.onMove?.('restore')} aria-label={t('tpl.bulk.restore', { count: count('restore') })}>
                  <ArchiveRestore size={13} aria-hidden /> <SelectionLabel>{t('tpl.bulk.restore', { count: count('restore') })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          keys={keys}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={
            model.rows.status === 'error' ? (
              <EmptyState
                title={t('tpl.failed')}
                description={say({ ns: 'sales', key: model.rows.problem })}
                action={
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                }
              />
            ) : rows && rows.length === 0 ? (
              <EmptyState icon={<FileStack size={22} aria-hidden />} title={t(model.status === 'ARCHIVED' ? 'tpl.emptyArchived' : 'tpl.empty')} description={t('tpl.emptyBody')} />
            ) : undefined
          }
        />
        {model.dialog && <TemplateDialog model={model.dialog} actions={actions?.dialog} />}
      </div>
    </Section>
  )
}
