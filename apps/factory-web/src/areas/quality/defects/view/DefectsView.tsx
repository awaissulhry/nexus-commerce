'use client'

import { useEffect, useMemo, useRef } from 'react'
import { MoreHorizontal, Plus, Sparkles } from 'lucide-react'
import { Banner, Menu, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { Freshness, NoAccess, PageHead, QualityMessages } from '../../_shared/parts'
import type { Cause, DefectCode, Disposition, Grade } from '../api'
import {
  BUILT_TABS,
  findCode,
  libraryRows,
  manageHeld,
  queryOf,
  retireLines,
  stepOpen,
  TABS,
  type BuiltTab,
  type DefectField,
  type DefectsModel,
  type DispositionField,
  type LibraryRow,
  type LibraryView,
  type NewDefectDraft,
  type NewDispositionDraft,
} from '../model'
import { DefectDrawer } from './DefectDrawer'
import { DeleteDialog, KeysDialog, NewDefectDialog, NewDispositionDialog, PhotoDialog, RetireDialog } from './dialogs'
import { DispositionsTable } from './DispositionsTable'
import { CausesTab, DeleteCauseDialog, GradesTab, NewCauseDialog, NewGradeDialog, VOCAB_NAMESPACE } from './VocabularyTabs'
import type { SeverityWordsActions } from '../severity/model'
import { SeverityWordsView } from '../severity/view/SeverityWordsView'
import { missingWordsNote, NEW_CAUSE, NEW_GRADE, type NewCauseDraft, type NewGradeDraft, type VocabularyField } from '../vocabulary'
import { LibraryTable } from './LibraryTable'
import { DEFECT_NAMESPACES, DefectsNotice, isTyping } from './parts'
import '../defects.css'

export interface DefectsActions {
  onAddress?: (change: { view?: LibraryView; q?: string; open?: string | null }) => void
  onSelect?: (ids: readonly string[]) => void
  onShowUpdates?: () => void
  onRetry?: () => void
  onDialog?: (dialog: DefectsModel['dialog']) => void
  onNewDefect?: (parentId?: string | null) => void
  onNewDisposition?: () => void
  onDefectDraft?: (draft: NewDefectDraft) => void
  onDispositionDraft?: (draft: NewDispositionDraft) => void
  onCreateDefect?: () => void
  onCreateDisposition?: () => void
  onDefectCell?: (code: DefectCode, field: DefectField, value: unknown) => void
  onDispositionCell?: (code: Disposition, field: DispositionField, value: unknown) => void
  onRetire?: (ids: readonly string[]) => void
  onConfirmRetire?: () => void
  onBulkActive?: (active: boolean) => void
  onBulkDispositions?: (active: boolean) => void
  onDelete?: (id: string) => void
  onConfirmDelete?: () => void
  onPicture?: (code: DefectCode, file: Blob, name: string) => void
  onPhoto?: (code: DefectCode, photo: CapturedPhoto) => void
  onStarter?: () => void
  onStandard?: () => void
  onExportLibrary?: (ids: readonly string[] | null) => void
  onExportDispositions?: (ids: readonly string[]) => void
  onDismissNotice?: () => void
  // B-W2b-118: the cause codes and the leather grades.
  onVocabCell?: (list: 'causes' | 'grades', row: Cause | Grade, field: VocabularyField, value: unknown) => void
  onVocabBulkActive?: (list: 'causes' | 'grades', active: boolean) => void
  onExportVocab?: (list: 'causes' | 'grades', ids: readonly string[] | null) => void
  onStarterVocab?: (list: 'causes' | 'grades') => void
  onNewCause?: () => void
  onNewGrade?: () => void
  onCauseDraft?: (draft: NewCauseDraft) => void
  onGradeDraft?: (draft: NewGradeDraft) => void
  onCreateCause?: () => void
  onCreateGrade?: () => void
  onDeleteCause?: (id: string) => void
  onConfirmDeleteCause?: () => void
  onRetryVocab?: () => void
  /** B-W2b-213: the severity words editor (Edit, a typed text, Discard, Save). */
  severity?: SeverityWordsActions
}

/**
 * SCR-079 Quality › Settings › Defects & dispositions (design quality.defects, a settings page with link tabs — one save
 * model each — Defects · Severity · Causes · Dispositions · Leather grades; B-W2b-118 builds Severity, Causes and Leather
 * grades in ./VocabularyTabs.tsx on B-W2b-90's routes). The head: one sentence, Updated · Live, ⋯ (Import library: held, Export library, Keys) and the
 * tab's primary (Add defect `c` / Add disposition). Defects: the starter-set offer when codes are missing, then the
 * library in the list frame and the docked drawer of the open code (`?open=`). Dispositions: the standard-set offer, then
 * the codes. Every write is held with its reason for whoever may not change the library. Fetches nothing.
 */
export function DefectsView({ model, actions }: { model: DefectsModel; actions?: DefectsActions }) {
  return (
    <QualityMessages namespaces={DEFECT_NAMESPACES}>
      <Defects model={model} actions={actions} />
    </QualityMessages>
  )
}

function Defects({ model, actions }: { model: DefectsModel; actions?: DefectsActions }) {
  const t = useT('defects')
  const tv = useT(VOCAB_NAMESPACE)
  const tl = useT('lists')
  const address = model.address
  const library = model.library.value
  const dispositions = model.dispositions.value
  const vocab = model.vocab
  const causes = vocab?.causes.value ?? null
  const grades = vocab?.grades.value ?? null
  const canManage =
    address.tab === 'defects' ? (library?.canManage ?? false) : address.tab === 'dispositions' ? (dispositions?.canManage ?? false) : address.tab === 'causes' ? (causes?.canManage ?? false) : address.tab === 'grades' ? (grades?.canManage ?? false) : true
  const held = manageHeld(canManage)
  const rows = useMemo(() => libraryRows(library, address.view, address.q), [library, address.view, address.q])
  const dialog = model.dialog
  const open = address.tab === 'defects' ? findCode(library, address.open) : null
  const latest = useRef({ model, actions, held })
  latest.current = { model, actions, held }

  // c: the tab's primary (Add defect / Add disposition), outside fields, menus and dialogs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || current.model.dialog || isTyping(event.target)) return
      if (current.held || !current.model.canView) return
      event.preventDefault()
      const tab = current.model.address.tab
      if (tab === 'defects') current.actions?.onNewDefect?.(null)
      else if (tab === 'dispositions') current.actions?.onNewDisposition?.()
      else if (tab === 'causes') current.actions?.onNewCause?.()
      else if (tab === 'grades') current.actions?.onNewGrade?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!model.canView) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const tabs: TabItem[] = TABS.map((tab) => {
    const built = (BUILT_TABS as readonly string[]).includes(tab)
    return {
      id: tab,
      label: t(`tab.${tab}`),
      ...(built ? { href: `${model.prefix}/quality/defects${queryOf({ tab: tab as BuiltTab })}` } : { disabled: true, badge: t('tab.later') }),
      count:
        tab === 'defects'
          ? library
            ? library.categories.reduce((sum, category) => sum + category.defects.length, 0)
            : null
          : tab === 'dispositions'
            ? dispositions
              ? dispositions.dispositions.length
              : null
            : tab === 'causes'
              ? causes
                ? causes.causes.length
                : null
              : tab === 'grades'
                ? grades
                  ? grades.grades.length
                  : null
                : undefined,
    }
  })

  const moreItems: MenuItemDef[] = [
    { id: 'import', label: t('head.import'), disabled: true, description: t('head.importHeld') },
    {
      id: 'export',
      label: t('head.export'),
      disabled: address.tab === 'defects' ? !library : address.tab === 'dispositions' ? !dispositions : address.tab === 'causes' ? !causes : address.tab === 'grades' ? !grades : true,
      onSelect: () =>
        address.tab === 'defects'
          ? actions?.onExportLibrary?.(null)
          : address.tab === 'dispositions'
            ? actions?.onExportDispositions?.((dispositions?.dispositions ?? []).map((row) => row.id))
            : address.tab === 'causes' || address.tab === 'grades'
              ? actions?.onExportVocab?.(address.tab, null)
              : undefined,
    },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onDialog?.({ kind: 'keys' }) },
  ]
  const ownKeys: ListKey[] =
    address.tab === 'defects'
      ? [
          { keys: ['c'], does: t('keys.add') },
          { keys: ['↵'], does: t('keys.open') },
          { keys: ['⌘', '↑'], does: t('keys.previous') },
          { keys: ['⌘', '↓'], does: t('keys.next') },
          { keys: ['⌘', '↵'], does: t('keys.save') },
        ]
      : address.tab === 'dispositions'
        ? [
            { keys: ['c'], does: t('keys.addDisposition') },
            { keys: ['⌘', '↵'], does: t('keys.save') },
          ]
        : address.tab === 'causes' || address.tab === 'grades'
          ? [
              { keys: ['c'], does: tv(address.tab === 'causes' ? 'keys.addCause' : 'keys.addGrade') },
              { keys: ['⌘', '↵'], does: t('keys.save') },
            ]
          : []
  const starterMissing = library?.starterMissing.length ?? 0
  const standardMissing = dispositions?.standardMissing.length ?? 0
  const libraryEmpty = !!library && library.categories.length === 0
  const childCounts = Object.fromEntries((library?.categories ?? []).map((category) => [category.code, category.defects.length]))
  const retireCodes = dialog?.kind === 'retire' ? dialog.ids.map((id) => findCode(library, id)?.code).filter((code): code is DefectCode => !!code) : []
  const deleting = dialog?.kind === 'delete' ? (findCode(library, dialog.id)?.code ?? null) : null
  const photoCode = dialog?.kind === 'photo' ? (findCode(library, dialog.id)?.code ?? null) : null
  const stepTo = (delta: 1 | -1) => {
    const next = stepOpen(rows, address.open, delta)
    if (next) actions?.onAddress?.({ open: next })
  }
  const openIndex = open ? rows.findIndex((row) => row.id === open.code.id) : -1

  return (
    <div className="fw-q fw-df">
      <PageHead
        intro={address.tab === 'defects' ? t('head.introDefects') : address.tab === 'dispositions' ? t('head.introDispositions') : tv(`head.${address.tab}`)}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('head.more') }} items={moreItems} />
            {address.tab === 'defects' ? (
              <Button size="sm" variant="primary" heldReason={held ? t(held) : !library ? t('held.reading') : null} onClick={() => actions?.onNewDefect?.(null)}>
                <Plus size={14} aria-hidden /> {t('head.addDefect')}
              </Button>
            ) : address.tab === 'dispositions' ? (
              <Button size="sm" variant="primary" heldReason={held ? t(held) : !dispositions ? t('held.reading') : null} onClick={() => actions?.onNewDisposition?.()}>
                <Plus size={14} aria-hidden /> {t('head.addDisposition')}
              </Button>
            ) : address.tab === 'causes' ? (
              <Button size="sm" variant="primary" heldReason={held ? t(held) : !causes ? t('held.reading') : null} onClick={() => actions?.onNewCause?.()}>
                <Plus size={14} aria-hidden /> {tv('causes.add')}
              </Button>
            ) : address.tab === 'grades' ? (
              <Button size="sm" variant="primary" heldReason={held ? t(held) : !grades ? t('held.reading') : null} onClick={() => actions?.onNewGrade?.()}>
                <Plus size={14} aria-hidden /> {tv('grades.add')}
              </Button>
            ) : null}
          </>
        }
      />
      <Tabs ariaLabel={t('tab.label')} tabs={tabs} active={address.tab} size="md" />
      <DefectsNotice notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {held && (address.tab === 'defects' ? library : address.tab === 'dispositions' ? dispositions : address.tab === 'causes' ? causes : address.tab === 'grades' ? grades : null) && (
        <Banner tone="info" title={t('readOnly.title')}>
          {t(held)}
        </Banner>
      )}

      {address.tab === 'defects' && (
        <>
          {starterMissing > 0 && !libraryEmpty && (
            <Banner
              tone="info"
              title={t('starter.title', { count: starterMissing })}
              action={
                <Button size="sm" heldReason={held ? t(held) : model.busy ? t('held.busy') : null} onClick={() => actions?.onStarter?.()}>
                  <Sparkles size={13} aria-hidden /> {t('starter.add')}
                </Button>
              }
            >
              {t('starter.body')}
            </Banner>
          )}
          <LibraryTable
            rows={rows}
            read={{ loaded: !!library, problem: model.library.problem, empty: libraryEmpty }}
            canManage={canManage}
            marks={model.marks}
            thumbs={model.thumbs}
            selected={model.selected}
            view={address.view}
            q={address.q}
            updates={model.updates}
            starterMissing={starterMissing}
            busy={model.busy}
            focusRow={model.focusRow}
            actions={{
              onOpen: (id) => actions?.onAddress?.({ open: id }),
              onCell: (row: LibraryRow, field, value) => (field === 'active' && value === false ? actions?.onRetire?.([row.id]) : actions?.onDefectCell?.(row.code, field, value)),
              onDelete: (row) => actions?.onDelete?.(row.id),
              onAddUnder: (row) => actions?.onNewDefect?.(row.id),
              onSelect: actions?.onSelect,
              onBulkActive: (active) => (active ? actions?.onBulkActive?.(true) : actions?.onRetire?.(model.selected)),
              onExport: (ids) => actions?.onExportLibrary?.(ids),
              onView: (view) => actions?.onAddress?.({ view }),
              onSearch: (q) => actions?.onAddress?.({ q }),
              onShowUpdates: actions?.onShowUpdates,
              onKeys: () => actions?.onDialog?.({ kind: 'keys' }),
              onStarter: actions?.onStarter,
              onNew: () => actions?.onNewDefect?.(null),
              onRetry: actions?.onRetry,
            }}
          />
          <DefectDrawer
            open={!!address.open && !dialog}
            code={open?.code ?? null}
            category={open?.category ?? null}
            missing={!!address.open && !!library && !open}
            canManage={canManage}
            canUpload={model.canUpload}
            marks={model.marks}
            picture={model.picture}
            pictureSrc={open?.code.pictureFileId ? (model.thumbs[open.code.pictureFileId] ?? null) : null}
            hasPrevious={openIndex > 0}
            hasNext={openIndex >= 0 && openIndex < rows.length - 1}
            actions={{
              onClose: () => actions?.onAddress?.({ open: null }),
              onStep: stepTo,
              onField: (code, field, value) => (field === 'active' && value === false ? actions?.onRetire?.([code.id]) : actions?.onDefectCell?.(code, field, value)),
              onPicture: (code, file) => actions?.onPicture?.(code, file, file.name),
              onPhoto: (code) => actions?.onDialog?.({ kind: 'photo', id: code.id }),
              onRetire: (code) => actions?.onRetire?.([code.id]),
            }}
          />
        </>
      )}

      {address.tab === 'dispositions' && (
        <>
          {standardMissing > 0 && (dispositions?.dispositions.length ?? 0) > 0 && (
            <Banner
              tone="info"
              title={t('standard.title', { count: standardMissing })}
              action={
                <Button size="sm" heldReason={held ? t(held) : model.busy ? t('held.busy') : null} onClick={() => actions?.onStandard?.()}>
                  <Sparkles size={13} aria-hidden /> {t('standard.add', { count: standardMissing })}
                </Button>
              }
            >
              {t('standard.body')}
            </Banner>
          )}
          <DispositionsTable
            rows={dispositions?.dispositions ?? []}
            read={{ loaded: !!dispositions, problem: model.dispositions.problem }}
            canManage={canManage}
            seesCost={model.seesCost}
            marks={model.marks}
            selected={model.selected}
            updates={model.updates}
            standardMissing={standardMissing}
            busy={model.busy}
            actions={{
              onCell: actions?.onDispositionCell,
              onSelect: actions?.onSelect,
              onBulkActive: actions?.onBulkDispositions,
              onExport: actions?.onExportDispositions,
              onShowUpdates: actions?.onShowUpdates,
              onKeys: () => actions?.onDialog?.({ kind: 'keys' }),
              onStandard: actions?.onStandard,
              onNew: actions?.onNewDisposition,
              onRetry: actions?.onRetry,
            }}
          />
          <p className="fw-df-sub">{t('disp.footnote')}</p>
        </>
      )}

      {address.tab === 'severity' && vocab && <SeverityWordsView model={{ read: vocab.severity, edit: vocab.severityEdit ?? null }} actions={actions?.severity} onRetry={actions?.onRetryVocab} />}
      {address.tab === 'causes' && vocab && (
        <CausesTab
          read={vocab.causes}
          marks={model.marks}
          selected={model.selected}
          busy={model.busy}
          updates={model.updates}
          notes={missingWordsNote(vocab.coverage, 'CAUSES')}
          actions={{
            onCell: (row, field, value) => actions?.onVocabCell?.('causes', row, field, value),
            onSelect: actions?.onSelect,
            onBulkActive: (active) => actions?.onVocabBulkActive?.('causes', active),
            onExport: (ids) => actions?.onExportVocab?.('causes', ids),
            onStarter: () => actions?.onStarterVocab?.('causes'),
            onNew: actions?.onNewCause,
            onDelete: actions?.onDeleteCause,
            onKeys: () => actions?.onDialog?.({ kind: 'keys' }),
            onRetry: actions?.onRetryVocab,
            onShowUpdates: actions?.onShowUpdates,
          }}
        />
      )}
      {address.tab === 'grades' && vocab && (
        <GradesTab
          read={vocab.grades}
          marks={model.marks}
          selected={model.selected}
          busy={model.busy}
          updates={model.updates}
          prefix={model.prefix}
          notes={missingWordsNote(vocab.coverage, 'GRADES')}
          actions={{
            onCell: (row, field, value) => actions?.onVocabCell?.('grades', row, field, value),
            onSelect: actions?.onSelect,
            onBulkActive: (active) => actions?.onVocabBulkActive?.('grades', active),
            onExport: (ids) => actions?.onExportVocab?.('grades', ids),
            onStarter: () => actions?.onStarterVocab?.('grades'),
            onNew: actions?.onNewGrade,
            onKeys: () => actions?.onDialog?.({ kind: 'keys' }),
            onRetry: actions?.onRetryVocab,
            onShowUpdates: actions?.onShowUpdates,
          }}
        />
      )}

      <NewCauseDialog
        open={dialog?.kind === 'new-cause'}
        draft={dialog?.kind === 'new-cause' ? dialog.draft : NEW_CAUSE}
        problems={dialog?.kind === 'new-cause' ? dialog.problems : {}}
        problem={dialog?.kind === 'new-cause' ? dialog.problem : null}
        shown={dialog?.kind === 'new-cause' ? dialog.shown : false}
        busy={model.busy}
        onDraft={(draft) => actions?.onCauseDraft?.(draft)}
        onCreate={() => actions?.onCreateCause?.()}
        onClose={() => actions?.onDialog?.(null)}
      />
      <NewGradeDialog
        open={dialog?.kind === 'new-grade'}
        draft={dialog?.kind === 'new-grade' ? dialog.draft : NEW_GRADE}
        problems={dialog?.kind === 'new-grade' ? dialog.problems : {}}
        problem={dialog?.kind === 'new-grade' ? dialog.problem : null}
        shown={dialog?.kind === 'new-grade' ? dialog.shown : false}
        busy={model.busy}
        onDraft={(draft) => actions?.onGradeDraft?.(draft)}
        onCreate={() => actions?.onCreateGrade?.()}
        onClose={() => actions?.onDialog?.(null)}
      />
      <DeleteCauseDialog open={dialog?.kind === 'delete-cause'} cause={dialog?.kind === 'delete-cause' ? (causes?.causes.find((row) => row.id === dialog.id) ?? null) : null} busy={model.busy} onConfirm={() => actions?.onConfirmDeleteCause?.()} onClose={() => actions?.onDialog?.(null)} />

      <NewDefectDialog
        open={dialog?.kind === 'new-defect'}
        draft={dialog?.kind === 'new-defect' ? dialog.draft : { kind: 'defect', parentId: null, code: '', labelIt: '', labelEn: '', severity: 'MAJOR', zone: null, stages: [], needsDetail: false }}
        problems={dialog?.kind === 'new-defect' ? dialog.problems : {}}
        problem={dialog?.kind === 'new-defect' ? dialog.problem : null}
        shown={dialog?.kind === 'new-defect' ? dialog.shown : false}
        library={library}
        busy={model.busy}
        onDraft={(draft) => actions?.onDefectDraft?.(draft)}
        onCreate={() => actions?.onCreateDefect?.()}
        onClose={() => actions?.onDialog?.(null)}
      />
      <NewDispositionDialog
        open={dialog?.kind === 'new-disposition'}
        draft={dialog?.kind === 'new-disposition' ? dialog.draft : { outcome: null, stockMoveReason: null, followUp: null, reinspection: false, code: '', labelIt: '', labelEn: '', approvalSeverity: null, approvalAmount: '' }}
        problems={dialog?.kind === 'new-disposition' ? dialog.problems : {}}
        problem={dialog?.kind === 'new-disposition' ? dialog.problem : null}
        shown={dialog?.kind === 'new-disposition' ? dialog.shown : false}
        outcomes={dispositions?.outcomes ?? null}
        seesCost={model.seesCost}
        busy={model.busy}
        onDraft={(draft) => actions?.onDispositionDraft?.(draft)}
        onCreate={() => actions?.onCreateDisposition?.()}
        onClose={() => actions?.onDialog?.(null)}
      />
      <RetireDialog open={dialog?.kind === 'retire'} lines={retireLines(retireCodes, childCounts)} count={retireCodes.length} busy={model.busy} onConfirm={() => actions?.onConfirmRetire?.()} onClose={() => actions?.onDialog?.(null)} />
      <DeleteDialog open={dialog?.kind === 'delete'} code={deleting} busy={model.busy} onConfirm={() => actions?.onConfirmDelete?.()} onClose={() => actions?.onDialog?.(null)} />
      <PhotoDialog
        open={dialog?.kind === 'photo'}
        code={photoCode}
        heldReason={held ? t(held) : model.canUpload ? null : t('held.noUpload')}
        onCapture={(photo) => photoCode && actions?.onPhoto?.(photoCode, photo)}
        onClose={() => actions?.onDialog?.(null)}
      />
      <KeysDialog open={dialog?.kind === 'keys'} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: tl(entry.does) === entry.does ? entry.does : tl(entry.does) }))} onClose={() => actions?.onDialog?.(null)} />
    </div>
  )
}
