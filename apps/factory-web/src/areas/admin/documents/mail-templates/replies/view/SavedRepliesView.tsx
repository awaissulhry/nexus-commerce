'use client'

import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { MessageSquareText, Pencil, Plus, Trash2 } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Pill, Select } from '@nexus/ui/primitives'
import { ActionConfirm, Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { useKeysHelp, useLatest, useSelection } from '../../../../kit/list'
import { BulkButton, FrameState, ListSearch, PageHead } from '../../../../shared/view/parts'
import { DOC_TEMPLATE_NAMESPACES } from '../../../doc-templates/view/DocTemplatesView'
import { usePageViewKeyList, usePageViewKeys, ViewSwitch, type PageView } from '../../../doc-templates/view/ViewSwitch'
import { useKindWords } from '../../../template-editor/view/DocTemplateEditorView'
import { TemplateText } from '../../../template-editor/view/TemplateEditor'
import { useTplWords } from '../../../template-editor/view/words'
import { PartSwitch } from '../../view/PartSwitch'
import type { SavedReply } from '../api'
import {
  deleteReach,
  draftProblems,
  NO_FILTER,
  placeholdersFor,
  RECORD_CHOICES,
  recordKey,
  REPLY_LANGUAGES,
  replyPreview,
  replyRowHeld,
  replyRowsOf,
  saveHeld,
  whoseKey,
  type MailPart,
  type RecordChoice,
  type ReplyDraft,
  type ReplyLanguage,
  type RepliesFilter,
  type SavedRepliesModel,
} from '../model'
import '../../../documents.css'
import '../../../template-editor/templates.css'

/**
 * SCR-632-replies — Admin › Documents › E-mail templates › Saved replies (B-TH-279; threads plan TH-6, O-ADM-MAILTPL.replies-F01): the
 * saved replies the reader keeps and the shared ones of the office, per language (Italian · English, C17) and kind of record — a
 * request of Sales › Incoming among them (B-TH-046) — on the shared list frame: the name and whose, the language, the record, the
 * first words, the last change; New saved reply and Edit open the editor (name, language, record, "Share with the office" for
 * those who keep the shared ones, the words with the record's placeholders, a preview on a made-up record); the selected ones the
 * reader may change are deleted after the DS ActionConfirm. A saved reply sends nothing: the person picks it in a message, reads
 * it, changes it and sends. Draws one view model; SavedRepliesSection.tsx reads and writes.
 */

export interface SavedRepliesActions {
  onView?: (view: PageView) => void
  onPart?: (part: MailPart) => void
  onCompany?: (companyId: string) => void
  onFilter?: (filter: RepliesFilter) => void
  onSelect?: (ids: string[]) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onNew?: () => void
  onEdit?: (reply: SavedReply) => void
  onDraft?: (patch: Partial<ReplyDraft>) => void
  onSave?: () => void
  onCloseEditor?: () => void
  onDelete?: (rows: readonly SavedReply[] | null) => void
  onDeleteGo?: () => void
  onDismissNotice?: () => void
}

export function SavedRepliesView({ model, actions }: { model: SavedRepliesModel; actions?: SavedRepliesActions }) {
  return (
    <WithMessages namespaces={DOC_TEMPLATE_NAMESPACES}>
      <SavedReplies model={model} actions={actions} />
    </WithMessages>
  )
}

/** The first line of the words, short (the whole words on hover). */
const firstLine = (body: string): string => body.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? ''

function SavedReplies({ model, actions }: { model: SavedRepliesModel; actions?: SavedRepliesActions }) {
  const t = useTplWords()
  const locale = useLocale()
  const words = useKindWords()
  const answer = model.read.status === 'ready' ? model.read.answer : null
  const [localFilter, setLocalFilter] = useState<RepliesFilter>(model.filter ?? NO_FILTER)
  const filter = actions?.onFilter ? (model.filter ?? NO_FILTER) : localFilter
  const setFilter = (next: RepliesFilter) => (actions?.onFilter ? actions.onFilter(next) : setLocalFilter(next))
  const rows = useMemo(() => replyRowsOf(answer, filter), [answer, filter])
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, rows.map((row) => row.id))
  const latest = useLatest({ model, actions })
  usePageViewKeys(actions?.onView, !!model.confirm || !!model.editor)
  const keys = usePageViewKeyList()
  const { onHelp, help } = useKeysHelp(keys, true)
  const mayShare = answer?.mayShare ?? false

  const columns = useMemo<ColDef<SavedReply>[]>(() => {
    const stop = (event: MouseEvent) => event.stopPropagation()
    return [
      {
        colId: 'name',
        headerName: t('tpl.replies.col.name'),
        flex: 1.4,
        minWidth: 200,
        valueGetter: ({ data }) => data?.name ?? '',
        cellRenderer: ({ data }: ICellRendererParams<SavedReply>) =>
          data ? (
            <span className="fw-tpl-cell">
              <span className="fw-adm-name">{data.name}</span>
              <span>
                <Pill tone={data.shared ? 'info' : 'neutral'}>{t(whoseKey(data))}</Pill>
              </span>
            </span>
          ) : null,
      },
      { colId: 'language', headerName: t('tpl.list.col.language'), flex: 0.6, minWidth: 110, valueGetter: ({ data }) => (data ? words.language(data.language) : '') },
      { colId: 'record', headerName: t('tpl.replies.col.record'), flex: 1, minWidth: 170, valueGetter: ({ data }) => (data ? t(recordKey(data.recordType)) : '') },
      { colId: 'words', headerName: t('tpl.replies.col.words'), flex: 2.2, minWidth: 260, tooltipValueGetter: ({ data }) => data?.body ?? '', valueGetter: ({ data }) => (data ? firstLine(data.body) : '') },
      {
        colId: 'changed',
        headerName: t('tpl.list.col.changed'),
        flex: 1,
        minWidth: 160,
        valueGetter: ({ data }) => (data ? data.updatedAt : ''),
        cellRenderer: ({ data }: ICellRendererParams<SavedReply>) =>
          data ? (
            <span className="fw-tpl-cell">
              <span>{formatDateTime(data.updatedAt, { locale })}</span>
              {data.owner && !data.shared && <span className="fw-adm-hint">{data.owner.name}</span>}
            </span>
          ) : null,
      },
      {
        colId: 'actions',
        headerName: t('tpl.list.col.actions'),
        flex: 0.8,
        minWidth: 130,
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<SavedReply>) => {
          if (!data) return null
          const { model: now, actions: act } = latest.current
          const why = replyRowHeld(data)
          return (
            <span className="fw-tpl-row-actions" onClick={stop}>
              <Button size="sm" heldReason={!now.mayWrite ? t('tpl.replies.held.noRight') : why ? t(why) : now.busy ? t('tpl.held.busy') : null} onClick={() => act?.onEdit?.(data)}>
                <Pencil size={13} aria-hidden /> {t('tpl.replies.edit')}
              </Button>
            </span>
          )
        },
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, words])

  const chosen = rows.filter((row) => selected.includes(row.id))
  const reach = deleteReach(chosen)
  const deleteHeld = !model.mayWrite ? t('tpl.replies.held.noRight') : reach.applies.length === 0 ? t('tpl.replies.held.noneYours') : model.busy ? t('tpl.held.busy') : null
  const filtered = filter.language !== null || filter.record !== null || filter.q.trim() !== ''

  const state: ReactNode =
    model.read.status === 'failed' ? (
      <FrameState problem={model.read.problem} onRetry={actions?.onRetry} />
    ) : model.read.status === 'ready' && rows.length === 0 ? (
      filtered ? (
        <FrameState noMatch={{ onClear: () => setFilter(NO_FILTER) }} />
      ) : (
        <FrameState
          empty={{
            icon: <MessageSquareText size={24} aria-hidden />,
            title: t('tpl.replies.empty.title'),
            body: t('tpl.replies.empty.body'),
            action: model.mayWrite ? (
              <Button size="sm" variant="primary" onClick={() => actions?.onNew?.()}>
                <Plus size={13} aria-hidden /> {t('tpl.replies.new')}
              </Button>
            ) : undefined,
          }}
        />
      )
    ) : undefined

  const newButton = (
    <Button size="sm" variant="primary" heldReason={!model.mayWrite ? t('tpl.replies.held.noRight') : model.busy ? t('tpl.held.busy') : null} onClick={() => actions?.onNew?.()}>
      <Plus size={13} aria-hidden /> {t('tpl.replies.new')}
    </Button>
  )

  return (
    <div className="fw-adm fw-adm-docs fw-tpl-list">
      <PageHead intro={t('tpl.replies.intro')} asOf={model.asOf ?? null} actions={newButton} />
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('tpl.dismiss')}
            </Button>
          }
        />
      )}
      <ListFrame<SavedReply>
        label={t('tpl.replies.label')}
        rows={model.read.status === 'loading' ? null : state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={answer ? t('tpl.replies.count', { count: rows.length, shared: rows.filter((row) => row.shared).length }) : '—'}
        search={<ListSearch label={t('tpl.replies.search')} value={filter.q} onChange={(q) => setFilter({ ...filter, q })} />}
        tools={
          <>
            <ViewSwitch view="mail" companies={model.companies} companyId={model.companyId} onView={actions?.onView} onCompany={actions?.onCompany} />
            <PartSwitch part="replies" onPart={actions?.onPart} />
            <Select size="sm" aria-label={t('tpl.replies.filter.language')} value={filter.language ?? ''} onChange={(event) => setFilter({ ...filter, language: (event.target.value || null) as ReplyLanguage | null })}>
              <option value="">{t('tpl.replies.filter.anyLanguage')}</option>
              {REPLY_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {words.language(language)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('tpl.replies.filter.record')} value={filter.record ?? ''} onChange={(event) => setFilter({ ...filter, record: (event.target.value || null) as RecordChoice | null })}>
              <option value="">{t('tpl.replies.filter.anyRecord')}</option>
              {RECORD_CHOICES.map((record) => (
                <option key={record} value={record}>
                  {t(`tpl.replies.record.${record}`)}
                </option>
              ))}
            </Select>
          </>
        }
        selection={{
          selected,
          onChange,
          actions: <BulkButton icon={<Trash2 size={13} aria-hidden />} tone="danger-outline" label={t('tpl.replies.delete', { count: reach.applies.length })} held={deleteHeld} onClick={() => actions?.onDelete?.(reach.applies)} />,
        }}
        isRowSelectable={(row) => {
          const why = replyRowHeld(row)
          return why ? t(why) : null
        }}
        updates={model.updates ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        onOpen={(row) => (row.mayChange && model.mayWrite ? actions?.onEdit?.(row) : undefined)}
        keys={keys}
        onHelp={onHelp}
        state={state}
      />
      <p className="fw-adm-hint">{t('tpl.replies.languages')}</p>
      <p className="fw-adm-hint">{t('tpl.replies.sendsNothing')}</p>
      {model.editor && <ReplyEditor model={model} mayShare={mayShare} actions={actions} />}
      {model.confirm && (
        <ActionConfirm
          impact={{
            level: 'confirm',
            reach: 'local',
            title: t('tpl.replies.deleteTitle', { count: model.confirm.rows.length }),
            confirmLabel: model.busy ? t('tpl.busy') : t('tpl.replies.delete', { count: model.confirm.rows.length }),
            consequences: [...model.confirm.rows.map((row) => `${row.name} (${words.language(row.language)}) · ${t(whoseKey(row))}`), t('tpl.replies.deleteKept'), ...(reach.left > 0 ? [t('tpl.replies.deleteLeft', { count: reach.left })] : [])],
            reversal: { verb: t('tpl.confirm.deleteBack'), fidelity: 'none' as const },
            acknowledge: model.confirm.rows.some((row) => row.shared) ? t('tpl.replies.deleteSharedAck') : undefined,
          }}
          onConfirm={() => actions?.onDeleteGo?.()}
          onCancel={() => (model.busy ? undefined : actions?.onDelete?.(null))}
        />
      )}
      {help}
    </div>
  )
}

/** New saved reply / Edit: the name, the language, the record, "Share with the office", the words with placeholders, the preview. */
function ReplyEditor({ model, mayShare, actions }: { model: SavedRepliesModel; mayShare: boolean; actions?: SavedRepliesActions }) {
  const t = useTplWords()
  const words = useKindWords()
  const editor = model.editor!
  const draft = editor.draft
  const reply = draft.id && model.read.status === 'ready' ? (model.read.answer.replies.find((one) => one.id === draft.id) ?? null) : null
  const problems = draftProblems(draft)
  const held = saveHeld({ reply, draft, mayWrite: model.mayWrite, mayShare, busy: !!model.busy, companyId: model.companyId })
  const preview = replyPreview(draft)
  return (
    <Modal
      open
      onClose={() => (model.busy ? undefined : actions?.onCloseEditor?.())}
      title={draft.id ? t('tpl.replies.editTitle', { name: reply?.name ?? draft.name }) : t('tpl.replies.newTitle')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseEditor?.()} disabled={!!model.busy}>
            {t('tpl.replies.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSave?.()} aria-keyshortcuts="Meta+S Control+S">
            {model.busy ? t('tpl.busy') : t('tpl.replies.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-tpl-editor"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            if (!held) actions?.onSave?.()
          }
        }}
      >
        {editor.problem && <Banner tone="danger" title={t(editor.problem.key, editor.problem.params)} />}
        <Field label={t('tpl.replies.field.name')} hint={t('tpl.replies.field.nameHint')} error={problems.name.length > 0 && draft.name !== '' ? t(problems.name[0]!.key, problems.name[0]!.params) : undefined} required>
          <Input size="sm" value={draft.name} maxLength={200} onChange={(event) => actions?.onDraft?.({ name: event.target.value })} autoFocus />
        </Field>
        <div className="fw-tpl-meta">
          <Field label={t('tpl.replies.field.language')} hint={t('tpl.replies.field.languageHint')}>
            <Select size="sm" value={draft.language} onChange={(event) => actions?.onDraft?.({ language: event.target.value as ReplyLanguage })}>
              {REPLY_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {words.language(language)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('tpl.replies.field.record')} hint={t('tpl.replies.field.recordHint')}>
            <Select size="sm" value={draft.record} onChange={(event) => actions?.onDraft?.({ record: event.target.value as RecordChoice })}>
              {RECORD_CHOICES.map((record) => (
                <option key={record} value={record}>
                  {t(`tpl.replies.record.${record}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {draft.id ? (
          <p className="fw-adm-hint">{t(draft.shared ? 'tpl.replies.field.isShared' : 'tpl.replies.field.isOwn')}</p>
        ) : (
          <div className="fw-tpl-section">
            <Checkbox checked={draft.shared} disabled={!mayShare} onChange={(event) => actions?.onDraft?.({ shared: event.target.checked })} label={t('tpl.replies.field.shared')} />
            <span className="fw-adm-hint">{mayShare ? t('tpl.replies.field.sharedHint') : t('tpl.replies.held.share')}</span>
          </div>
        )}
        <TemplateText label={t('tpl.replies.field.body')} hint={t('tpl.replies.field.bodyHint')} value={draft.body} limit={10000} rows={8} placeholders={placeholdersFor(draft.record)} problems={draft.body === '' ? [] : problems.body} readOnly={false} onChange={(body) => actions?.onDraft?.({ body })} />
        <section className="fw-tpl-preview" aria-label={t('tpl.replies.preview.label')}>
          <div className="fw-tpl-preview-head">
            <b>{t('tpl.replies.preview.title')}</b>
            <span className="fw-adm-hint">{t('tpl.replies.preview.hint')}</span>
          </div>
          <div className="fw-tpl-mail">{preview ? <pre className="fw-tpl-mail-body">{preview}</pre> : <span className="fw-adm-hint">{t('tpl.replies.preview.empty')}</span>}</div>
        </section>
      </div>
    </Modal>
  )
}
