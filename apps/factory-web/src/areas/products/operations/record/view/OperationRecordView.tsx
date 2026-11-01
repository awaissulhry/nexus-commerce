'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Lock, MoreHorizontal, RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { editText, minutesText } from '../../../styles/model'
import { isPageKey, type LibraryCan, type Notice, type WriteProblem } from '../../../library/model'
import { KeysDialog, LibraryMessages, NoticeBanner, ReadField, RecordFrame, RecordState, SaveBar, SaveWords } from '../../../library/parts'
import type { OperationInput, OperationView, WhereUsed } from '../../api'
import { codeFrozen, createHeld, differenceText, minutesInput, namesOf, OPERATION_TABS, STATUS_TONE, updateHeld, type OperationDraft, type OperationTab } from '../../model'
import { OperationFields } from '../../view/OperationsListView'

export type OperationLoad = { status: 'loading' } | { status: 'ready'; value: OperationView } | { status: 'error'; problem: string } | { status: 'notFound' } | { status: 'forbidden' }

export interface OperationRecordViewModel {
  prefix: string
  can: LibraryCan
  tab: OperationTab
  operation: OperationLoad
  save: { state: 'idle' | 'saving' | 'failed'; at: string | null }
  busy: boolean
  notice: Notice | null
  changed: { at: string } | null
  refused: WriteProblem | null
  dialog: 'archive' | 'help' | null
  /** Design cases: Where used rows already selected, the update dialog open. */
  selected?: string[]
  updateOpen?: boolean
}

export interface OperationRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onSave?: (patch: Partial<OperationInput> & { code?: string }) => Promise<boolean>
  onArchive?: (reason: string) => Promise<boolean>
  onReactivate?: () => void
  /** Each selected draft routing step takes the library's minutes. */
  onUpdateRoutings?: (stepIds: string[]) => Promise<boolean>
  onDialog?: (dialog: 'archive' | 'help' | null) => void
  onDismissNotice?: () => void
}

const KEYS = [
  { keys: ['⌘', 'S'], does: 'keys.save' },
  { keys: ['?'], does: 'keys.help' },
]

/**
 * SCR-049 — the operation record (design products.operations "Record: Operation"; 00 §2.2): the band (‹ Operations,
 * "<code> · <name>", department and machine as meta, its state, ⋯ Archive / Reactivate, Copy code, Keys) and the tabs
 * Definition (what is done and how, the name in each floor language, explicit save; the code frozen once a routing copied
 * it, said in words), Minutes (the SMV, and where routings differ from it) and Where used (every routing step made from
 * it; draft steps that differ update to the library value in one action; released routings are frozen). No money.
 */
export function OperationRecordView({ model, actions }: { model: OperationRecordViewModel; actions?: OperationRecordActions }) {
  return (
    <LibraryMessages>
      <Record model={model} actions={actions} />
    </LibraryMessages>
  )
}

function Record({ model, actions }: { model: OperationRecordViewModel; actions?: OperationRecordActions }) {
  const t = useT('library')
  const back = { href: `${model.prefix}/products/operations`, label: t('operation.back') }
  if (model.operation.status === 'ready') return <Ready operation={model.operation.value} model={model} actions={actions} />
  return <RecordState back={back} state={model.operation.status} problem={model.operation.status === 'error' ? model.operation.problem : null} onRetry={() => actions?.onRetry?.()} />
}

function Ready({ operation, model, actions }: { operation: OperationView; model: OperationRecordViewModel; actions?: OperationRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const href = `${model.prefix}/products/operations/${operation.id}`
  const archived = operation.status === 'ARCHIVED'

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog) return
      if (event.key === '?') {
        event.preventDefault()
        actions?.onDialog?.('help')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const more: MenuItemDef[] = [
    archived
      ? { id: 'reactivate', label: t('operation.action.reactivate'), disabled: !model.can.operationsManage, description: model.can.operationsManage ? undefined : t('held.noManage'), onSelect: () => actions?.onReactivate?.() }
      : { id: 'archive', label: t('operation.action.archive'), tone: 'danger', disabled: !model.can.operationsManage, description: model.can.operationsManage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.('archive') },
    {
      id: 'copy',
      label: t('list.copyCode'),
      onSelect: () => {
        void navigator.clipboard?.writeText(operation.code).catch(() => undefined)
      },
    },
    { id: 'keys', label: t('keys.menu'), onSelect: () => actions?.onDialog?.('help') },
  ]

  return (
    <RecordFrame
      back={{ href: `${model.prefix}/products/operations`, label: t('operation.back') }}
      title={
        <span className="fw-lib-title">
          {operation.code} <span className="fw-lib-title-name">· {operation.nameI18n?.[locale] ?? operation.name}</span>
        </span>
      }
      meta={[t(`department.${operation.workCentreKind}`), operation.machineType].filter(Boolean).join(' · ')}
      actions={<Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />}
      facts={
        <>
          <span className="fw-lib-tags">
            <Pill tone={STATUS_TONE[operation.status]}>{t(`status.${operation.status}`)}</Pill>
            <Tag tone="info">{t('operations.list.minutes', { minutes: minutesText(operation.standardMinutes, locale) })}</Tag>
            <Tag tone="neutral">{t('operations.list.usedIn', { count: operation.usedIn })}</Tag>
            {operation.differing > 0 && <Tag tone="warning">{t('operations.list.differing', { count: operation.differing })}</Tag>}
          </span>
          <SaveWords state={model.save.state} at={model.save.at} />
        </>
      }
      tabs={OPERATION_TABS.map((tab) => ({ id: tab, label: t(`operation.tab.${tab}`), count: tab === 'whereused' ? operation.whereUsed.length : null }))}
      active={model.tab}
      tabHref={(tab) => `${href}?tab=${tab}`}
    >
      {model.changed && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatTime(model.changed.at, { locale }) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {archived && <Banner tone="info" title={<span className="fw-lib-inline"><Lock size={14} aria-hidden /> {t('operation.archivedBanner')}</span>} />}
      {model.refused && model.refused.messages.length > 0 && model.notice?.tone === 'danger' && (
        <Banner tone="warning" title={t('material.refusedTitle')}>
          <ul className="fw-lib-list">
            {model.refused.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Banner>
      )}
      {model.tab === 'minutes' ? (
        <MinutesTab key={`${operation.id}-${operation.version}`} operation={operation} model={model} actions={actions} />
      ) : model.tab === 'whereused' ? (
        <WhereUsedTab operation={operation} model={model} actions={actions} />
      ) : (
        <DefinitionTab key={`${operation.id}-${operation.version}`} operation={operation} model={model} actions={actions} />
      )}
      {model.dialog === 'archive' && <ArchiveDialog operation={operation} busy={model.busy} actions={actions} />}
      {model.dialog === 'help' && <KeysDialog keys={KEYS.map((entry) => ({ keys: entry.keys, does: t(entry.does) }))} onClose={() => actions?.onDialog?.(null)} />}
    </RecordFrame>
  )
}

function draftOf(operation: OperationView, locale: 'it' | 'en'): OperationDraft {
  return {
    companyId: operation.companyId,
    code: operation.code,
    name: operation.name,
    nameIt: operation.nameI18n?.it ?? '',
    nameEn: operation.nameI18n?.en ?? '',
    workCentreKind: operation.workCentreKind,
    machineType: operation.machineType ?? '',
    skill: operation.skill ?? '',
    minutes: editText(operation.standardMinutes, locale),
    instructions: operation.instructions ?? '',
  }
}

/** The fields that changed, as the PATCH sends them (minutes on the Minutes tab). */
function patchOf(base: OperationDraft, draft: OperationDraft): Partial<OperationInput> & { code?: string } {
  const patch: Partial<OperationInput> & { code?: string } = {}
  if (draft.code.trim().toUpperCase() !== base.code) patch.code = draft.code.trim().toUpperCase()
  if (draft.name.trim() !== base.name) patch.name = draft.name.trim()
  if (draft.nameIt.trim() !== base.nameIt || draft.nameEn.trim() !== base.nameEn) patch.nameI18n = namesOf(draft.nameIt, draft.nameEn)
  if (draft.workCentreKind !== base.workCentreKind) patch.workCentreKind = draft.workCentreKind
  if (draft.machineType.trim() !== base.machineType) patch.machineType = draft.machineType.trim() || null
  if (draft.skill.trim() !== base.skill) patch.skill = draft.skill.trim() || null
  if (draft.instructions.trim() !== base.instructions) patch.instructions = draft.instructions.trim() || null
  return patch
}

function DefinitionTab({ operation, model, actions }: { operation: OperationView; model: OperationRecordViewModel; actions?: OperationRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const base = draftOf(operation, locale)
  const [draft, setDraft] = useState(base)
  const patch = patchOf(base, draft)
  const count = Object.keys(patch).length
  const editable = model.can.operationsManage && operation.status === 'ACTIVE'
  const refused = (field: string) => (model.refused?.paths.some((path) => path === field || path.startsWith(`${field}/`)) ? t('newMaterial.refused') : undefined)
  const frozen = codeFrozen(operation) ? t('operation.codeFrozen', { count: operation.usedIn }) : null
  const held = createHeld({ ...draft, minutes: base.minutes }, false)
  const floorNames = !draft.nameIt.trim() || !draft.nameEn.trim()
  return (
    <Card header={t('operation.tab.definition')} description={editable ? t('operation.definitionHint') : t('material.readOnly')}>
      {editable ? (
        <div className="fw-lib-stack">
          <OperationFields draft={draft} set={(next) => setDraft((current) => ({ ...current, ...next }))} refused={refused} withCode codeHeld={frozen} />
          {floorNames && <p className="fw-lib-hint fw-lib-warn">{t('operation.floorNamesMissing')}</p>}
          {count > 0 && <SaveBar count={count} onDiscard={() => setDraft(base)} onSave={() => void actions?.onSave?.(patch)} held={held ? t(held) : null} busy={model.busy} saveLabel={t('material.save')} />}
        </div>
      ) : (
        <div className="fw-lib-form-grid">
          <ReadField label={t('operation.code')} value={operation.code} hint={frozen} />
          <ReadField label={t('operation.name')} value={operation.name} />
          <ReadField label={t('material.nameIt')} value={operation.nameI18n?.it} />
          <ReadField label={t('material.nameEn')} value={operation.nameI18n?.en} />
          <ReadField label={t('operation.department')} value={t(`department.${operation.workCentreKind}`)} />
          <ReadField label={t('operation.machine')} value={operation.machineType} />
          <ReadField label={t('operation.skill')} value={operation.skill} />
          <div className="fw-lib-span">
            <ReadField label={t('operation.instructions')} value={operation.instructions} />
          </div>
        </div>
      )}
    </Card>
  )
}

function MinutesTab({ operation, model, actions }: { operation: OperationView; model: OperationRecordViewModel; actions?: OperationRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const [text, setText] = useState(editText(operation.standardMinutes, locale))
  const typed = minutesInput(text)
  const changed = typed.ok && typed.minutes !== operation.standardMinutes
  const editable = model.can.operationsManage && operation.status === 'ACTIVE'
  const drafts = operation.whereUsed.filter((use) => use.revision.status === 'DRAFT').length
  return (
    <div className="fw-lib-pair">
      <Card header={t('operation.minutes.title')} description={t('operation.minutes.intro')}>
        {editable ? (
          <div className="fw-lib-stack">
            <div className="fw-lib-form-grid">
              <Field label={t('operation.smv')} required hint={t('operation.smvHint')} error={!typed.ok && text.trim() !== '' ? t('newOperation.held.minutesInvalid') : undefined}>
                <Input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} />
              </Field>
            </div>
            {changed && (
              <SaveBar
                count={1}
                onDiscard={() => setText(editText(operation.standardMinutes, locale))}
                onSave={() => typed.ok && void actions?.onSave?.({ standardMinutes: typed.minutes })}
                held={typed.ok ? null : t('newOperation.held.minutesInvalid')}
                busy={model.busy}
                saveLabel={t('operation.minutes.save')}
              />
            )}
            <p className="fw-lib-hint">{t('operation.minutes.newOnly', { count: drafts })}</p>
          </div>
        ) : (
          <ReadField label={t('operation.smv')} value={t('operations.list.minutes', { minutes: minutesText(operation.standardMinutes, locale) })} />
        )}
      </Card>
      <Card header={t('operation.minutes.routings')}>
        <KeyValue
          columns={1}
          labelCase="sentence"
          items={[
            { label: t('operation.minutes.used'), value: t('operations.list.usedIn', { count: operation.usedIn }) },
            { label: t('operation.minutes.differing'), value: operation.differing > 0 ? t('operations.list.differing', { count: operation.differing }) : t('operations.list.allSame') },
          ]}
        />
        {operation.differing > 0 && (
          <Link className="fw-lib-link" href={`${model.prefix}/products/operations/${operation.id}?tab=whereused`}>
            {t('operation.minutes.see')}
          </Link>
        )}
      </Card>
    </div>
  )
}

function WhereUsedTab({ operation, model, actions }: { operation: OperationView; model: OperationRecordViewModel; actions?: OperationRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [confirm, setConfirm] = useState(model.updateOpen ?? false)
  const rows = operation.whereUsed
  const picked = rows.filter((row) => selected.includes(row.stepId))
  const held = !model.can.routingManage ? t('operation.used.held.noRouting') : model.busy ? t('held.busy') : null

  const columns = useMemo<ColDef<WhereUsed>[]>(() => {
    const StyleCell = ({ data }: ICellRendererParams<WhereUsed>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={`${model.prefix}/products/styles/${data.style.id}?tab=routing&rev=${data.revision.id}`}>
            {data.style.code}
          </Link>
          <span className="fw-lib-sub">{data.style.name}</span>
        </span>
      ) : null
    const RevisionCell = ({ data }: ICellRendererParams<WhereUsed>) =>
      data ? (
        <span className="fw-lib-inline">
          {t('operation.used.revision', { revision: data.revision.revision })}
          <Pill tone={data.revision.status === 'DRAFT' ? 'info' : data.revision.status === 'RELEASED' ? 'success' : 'neutral'}>{t(`revisionStatus.${data.revision.status}`)}</Pill>
        </span>
      ) : null
    const DiffCell = ({ data }: ICellRendererParams<WhereUsed>) => (data ? <span className={Number(data.difference) === 0 ? 'fw-lib-hint' : 'fw-lib-warn'}>{Number(data.difference) === 0 ? t('operation.used.same') : t('operation.used.diff', { diff: differenceText(data.difference, locale) })}</span> : null)
    return [
      { colId: 'style', headerName: t('operation.used.col.style'), field: 'style', cellDataType: false, minWidth: 180, flex: 1.5, cellRenderer: StyleCell },
      { colId: 'revision', headerName: t('operation.used.col.revision'), field: 'revision', cellDataType: false, minWidth: 170, flex: 1, cellRenderer: RevisionCell },
      { colId: 'seq', headerName: t('operation.used.col.step'), field: 'seq', minWidth: 80, maxWidth: 110, type: 'rightAligned' },
      { colId: 'minutes', headerName: t('operation.used.col.minutes'), field: 'standardMinutes', minWidth: 120, flex: 0.8, type: 'rightAligned', valueFormatter: (params) => t('operations.list.minutes', { minutes: minutesText(params.value as string, locale) }) },
      { colId: 'diff', headerName: t('operation.used.col.difference'), field: 'difference', minWidth: 150, flex: 1, cellRenderer: DiffCell },
    ]
  }, [t, locale, model.prefix])

  return (
    <div className="fw-lib-stack">
      <p className="fw-lib-hint">{t('operation.used.intro', { minutes: minutesText(operation.standardMinutes, locale) })}</p>
      <ListFrame<WhereUsed>
        label={t('operation.tab.whereused')}
        rows={rows}
        rowId={(row) => row.stepId}
        columns={columns}
        count={t('operation.used.count', { count: rows.length })}
        isRowSelectable={(row) => {
          const reason = updateHeld(row, operation)
          return reason ? t(reason) : null
        }}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('operation.used.update', { count: picked.length })} heldReason={held} onClick={() => setConfirm(true)}>
              <RefreshCw size={13} aria-hidden /> <SelectionLabel>{t('operation.used.update', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        state={rows.length === 0 ? <EmptyState title={t('operation.used.empty.title')} description={t('operation.used.empty.body')} /> : undefined}
      />
      {confirm && picked.length > 0 && (
        <Modal
          open
          onClose={() => setConfirm(false)}
          title={t('operation.used.confirmTitle', { count: picked.length })}
          size="md"
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>{t('common.back')}</Button>
              <Button
                variant="primary"
                heldReason={held}
                onClick={() =>
                  void actions?.onUpdateRoutings?.(picked.map((row) => row.stepId)).then((done) => {
                    if (done) {
                      setSelected([])
                      setConfirm(false)
                    }
                  })
                }
              >
                {t('operation.used.update', { count: picked.length })}
              </Button>
            </>
          }
        >
          <div className="fw-lib-dialog">
            <p className="fw-lib-hint">{t('operation.used.confirmIntro')}</p>
            <ul className="fw-lib-list">
              {picked.map((row) => (
                <li key={row.stepId}>
                  <b>{row.style.code}</b> · {t('operation.used.revision', { revision: row.revision.revision })} · {t('operation.used.step', { seq: row.seq })}: {minutesText(row.standardMinutes, locale)} → {minutesText(operation.standardMinutes, locale)} {t('operation.used.min')}
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      )}
    </div>
  )
}

function ArchiveDialog({ operation, busy, actions }: { operation: OperationView; busy: boolean; actions?: OperationRecordActions }) {
  const t = useT('library')
  const [reason, setReason] = useState('')
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      title={t('operation.archive.title', { code: operation.code })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={() => void actions?.onArchive?.(reason.trim()).then((done) => done && close())}>
            {t('operation.action.archive')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          <li>{t('operations.archive.reach')}</li>
          <li>{t('operations.archive.kept')}</li>
          <li>{t('operations.archive.back')}</li>
        </ul>
        <Field label={t('dialog.reason')} hint={t('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
