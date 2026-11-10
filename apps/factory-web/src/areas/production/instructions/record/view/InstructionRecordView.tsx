'use client'

import { FileText, MonitorSmartphone, MoreHorizontal } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Acknowledgements, InstructionRecord, VersionAnswer } from '../../api'
import {
  approveHeld,
  bandPrimary,
  currentOfRecord,
  discardHeld,
  draftOfRecord,
  editHeld,
  newVersionHeld,
  nextNumber,
  NS,
  previewHref,
  problemsOf,
  recordQuery,
  RECORD_TABS,
  sheetHref,
  statusHeld,
  valueOf,
  type Facts,
  type InstructionsCan,
  type Notice,
  type Read,
  type RecordAddress,
  type RecordTab,
  type Upload,
  type VersionDraft,
} from '../../model'
import { InstructionsMessages, NoticeBanner, RecordFrame, RecordState, useSay, VersionPill } from '../../view/parts'
import { AcksTab, type AcksActions } from './AcksTab'
import { ApproveDialog, DiscardDialog, NewVersionDialog, PaperDialog, StatusDialog, type DialogActions, type RecordDialog } from './dialogs'
import { MediaTab, type MediaActions } from './MediaTab'
import { StepsTab, type StepsActions } from './StepsTab'
import { VersionsTab, type VersionsActions } from './VersionsTab'

export interface RecordModel {
  readonly prefix: string
  /** The person looking (the author never approves their own draft). */
  readonly me: string
  readonly can: InstructionsCan
  readonly address: RecordAddress
  readonly record: Read<InstructionRecord>
  /** The version Steps and Media show (the draft, the one in force, or the one asked). */
  readonly shown: Read<VersionAnswer> | null
  /** The editor's document (the shown draft, while this person may change it): ONE save. */
  readonly draft: VersionDraft | null
  readonly changes: number
  /** Show every problem (after a try to save), and the places the API refused. */
  readonly showProblems: boolean
  readonly refused: readonly string[]
  /** The language written and read on Steps and Media. */
  readonly language: string
  readonly openStep: string | null
  /** fileId → the address to show it (null: none to show: no files.read, not uploaded, not read yet). */
  readonly mediaSrc: Readonly<Record<string, string | null>>
  readonly uploads: readonly Upload[]
  readonly compare: { readonly beforeId: string | null; readonly afterId: string | null; readonly before: Read<VersionAnswer> | null; readonly after: Read<VersionAnswer> | null }
  readonly acks: Read<Acknowledgements> | null
  readonly dialog: RecordDialog | null
  readonly busy: 'save' | 'approve' | 'discard' | 'status' | 'newVersion' | 'paper' | null
  readonly notice: Notice | null
  readonly offline: boolean
  /** Changed on another screen: Reload (design: no live feed, a Banner with Reload). */
  readonly changedElsewhere: boolean
  readonly savedAt: string | null
}

export interface RecordActions extends StepsActions, MediaActions, VersionsActions, AcksActions, DialogActions {
  onDiscardChanges?: () => void
  onSave?: () => void
  onReload?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
  onApproveOpen?: () => void
  onNewVersionOpen?: () => void
  onDiscardOpen?: () => void
  onStatusOpen?: (to: 'ARCHIVED' | 'ACTIVE') => void
}

/**
 * SCR-285 — a work instruction's record (design production.instructions rec "Work instruction", a record page): the band
 * (the operation, for every style or one style revision, the version shown, its state, the one next step — Approve version
 * N or Start version N+1 — and ⋯ Floor preview, Instruction sheet PDF, Discard draft, Archive / Restore), then the tabs Steps
 * and Media (one document, ONE save: the EditModeBar, ⌘S), Versions (what changed, the routing revision, compare two) and
 * Acknowledgements (a training record: counts per site; names only for HR). Fetches nothing.
 */
export function InstructionRecordView({ model, actions }: { model: RecordModel; actions?: RecordActions }) {
  return (
    <InstructionsMessages>
      <Record model={model} actions={actions} />
    </InstructionsMessages>
  )
}

function Record({ model, actions }: { model: RecordModel; actions?: RecordActions }) {
  const t = useT(NS)
  const say = useSay()
  const locale = useLocale()
  const back = { href: `${model.prefix}/production/instructions`, label: t('record.back') }
  if (!model.can.view) return <RecordState back={back} state="forbidden" />
  if (model.record.status === 'loading') return <RecordState back={back} state="loading" />
  if (model.record.status === 'error') {
    const state = model.record.problem === 'problem.notFound' ? 'notFound' : model.record.problem === 'problem.forbidden' ? 'forbidden' : 'error'
    return <RecordState back={back} state={state} problem={model.record.problem} onRetry={() => actions?.onRetry?.()} />
  }
  const record = model.record.value
  const instruction = record.instruction
  const shown = valueOf(model.shown)
  const shownVersion = shown?.version ?? null
  const draft = draftOfRecord(record)
  const current = currentOfRecord(record)
  const facts: Facts = { can: model.can, me: model.me, offline: model.offline }
  const edit = editHeld(record, shownVersion, facts)
  const editable = edit === null && model.draft !== null
  const draftContent = shownVersion && draft && shownVersion.id === draft.id ? model.draft : null
  const approveWhy = approveHeld(record, draft, draftContent, { ...facts, unsaved: model.changes })
  const primary = bandPrimary(record, facts)
  const next = nextNumber(record)
  const newWhy = newVersionHeld(record, facts)
  const discardWhy = discardHeld(record, facts)
  const statusWhy = statusHeld(facts)
  const shownId = shownVersion?.id ?? record.currentVersionId ?? record.draftVersionId
  const tabHref = (tab: string) => `${model.prefix}/production/instructions/${encodeURIComponent(instruction.id)}${recordQuery({ ...model.address, tab: tab as RecordTab, approve: false, compare: tab === 'versions' ? model.address.compare : null })}`
  const problems = model.draft ? problemsOf(model.draft) : []
  const saveWhy = problems.length > 0 && model.showProblems ? t('held.problems', { count: problems.length }) : model.offline ? t('held.offline') : null

  const more: MenuItemDef[] = [
    { id: 'preview', label: t('record.preview'), href: previewHref(model.prefix, instruction.id, shownId ?? null, model.language), target: '_blank', disabled: !shownId, description: shownId ? t('record.previewHint') : t('held.noVersion') },
    { id: 'pdf', label: t('record.sheet'), href: sheetHref(model.prefix, instruction.id, shownId ?? null), target: '_blank', disabled: !shownId, description: shownId ? t('record.sheetHint') : t('held.noVersion') },
    { id: 'sep1', separator: true },
    { id: 'newVersion', label: t('record.newVersion', { number: next }), disabled: !!newWhy, description: newWhy ? say(newWhy) : undefined, onSelect: () => actions?.onNewVersionOpen?.() },
    { id: 'discard', label: draft ? t('record.discard', { number: draft.number }) : t('record.discardNone'), disabled: !!discardWhy, description: discardWhy ? say(discardWhy) : undefined, onSelect: () => actions?.onDiscardOpen?.() },
    { id: 'sep2', separator: true },
    instruction.status === 'ACTIVE'
      ? { id: 'archive', label: t('record.archive'), disabled: !!statusWhy, description: statusWhy ? say(statusWhy) : t('record.archiveHint'), onSelect: () => actions?.onStatusOpen?.('ARCHIVED') }
      : { id: 'restore', label: t('record.restore'), disabled: !!statusWhy, description: statusWhy ? say(statusWhy) : undefined, onSelect: () => actions?.onStatusOpen?.('ACTIVE') },
  ]

  const primaryButton =
    primary === 'approve' && draft ? (
      <Button variant="primary" size="sm" heldReason={approveWhy ? say(approveWhy) : null} onClick={() => actions?.onApproveOpen?.()}>
        {t('record.approve', { number: draft.number })}
      </Button>
    ) : primary === 'newVersion' ? (
      <Button variant="primary" size="sm" disabled={model.busy === 'newVersion'} heldReason={newWhy ? say(newWhy) : null} onClick={() => actions?.onNewVersionOpen?.()}>
        {t('record.newVersion', { number: next })}
      </Button>
    ) : null

  const status = (
    <span className="fw-wi-band-status">
      {instruction.status === 'ARCHIVED' ? <Pill tone="neutral" size="sm">{t('list.status.ARCHIVED')}</Pill> : current ? <Pill tone="success" size="sm">{t('record.inForce', { number: current.number })}</Pill> : <Pill tone="warning" size="sm">{t('list.status.NONE')}</Pill>}
      {draft && <VersionPill status="DRAFT" number={draft.number} />}
      <span className="fw-wi-hint" role="status">
        {model.busy === 'save' ? t('record.saving') : model.changes > 0 ? t('record.unsaved', { count: model.changes }) : model.savedAt ? t('record.savedAt', { time: formatTime(model.savedAt, { locale }) }) : ''}
      </span>
    </span>
  )
  const meta = (
    <span className="fw-wi-meta">
      <span>{instruction.number}</span>
      <span>{instruction.style ? t('record.forRevision', { code: instruction.style.code, name: instruction.style.name, revision: instruction.style.revision }) : t('record.everyStyle')}</span>
      {shownVersion && <span>{t('record.showing', { number: shownVersion.number, status: t(`status.${shownVersion.status}`) })}</span>}
    </span>
  )
  const showingOther = shownVersion && model.address.version && shownVersion.id !== (record.draftVersionId ?? record.currentVersionId)

  return (
    <div className="fw-wi-record">
      <RecordFrame
        back={back}
        title={`${instruction.operation.code} · ${instruction.operation.name}`}
        meta={meta}
        status={status}
        actions={
          <>
            {primaryButton}
            <Button size="sm" variant="quiet" asChild>
              <a href={previewHref(model.prefix, instruction.id, shownId ?? null, model.language)} target="_blank" rel="noopener" aria-disabled={!shownId}>
                <MonitorSmartphone size={14} aria-hidden /> {t('record.previewShort')}
              </a>
            </Button>
            <Button size="sm" variant="quiet" asChild>
              <a href={sheetHref(model.prefix, instruction.id, shownId ?? null)} target="_blank" rel="noopener" aria-disabled={!shownId}>
                <FileText size={14} aria-hidden /> {t('record.sheetShort')}
              </a>
            </Button>
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={more} />
          </>
        }
        tabs={RECORD_TABS.map((tab) => ({
          id: tab,
          label: t(`tab.${tab}`),
          count: tab === 'steps' ? (model.draft?.steps.length ?? shown?.steps.length ?? null) : tab === 'media' ? (model.draft ? model.draft.steps.reduce((sum, step) => sum + step.media.length, 0) : (shownVersion?.media ?? null)) : tab === 'versions' ? record.versions.length : null,
        }))}
        active={model.address.tab}
        tabHref={tabHref}
      >
        <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {model.changedElsewhere && (
          <Banner
            tone="warning"
            title={t('live.changed')}
            action={
              <Button size="sm" onClick={() => actions?.onReload?.()}>
                {t('live.reload')}
              </Button>
            }
          />
        )}
        {model.offline && <Banner tone="warning" title={t('held.offlineBanner')} />}
        {instruction.status === 'ARCHIVED' && <Banner tone="info" title={t('record.archivedBanner', { number: instruction.number })} />}
        {showingOther && (
          <Banner
            tone="info"
            title={t('record.showingOther', { number: shownVersion.number, status: t(`status.${shownVersion.status}`) })}
            action={
              <Button size="sm" asChild>
                <a href={`${model.prefix}/production/instructions/${encodeURIComponent(instruction.id)}${recordQuery({ ...model.address, version: null })}`}>{t('record.showLatest')}</a>
              </Button>
            }
          />
        )}
        {(model.address.tab === 'steps' || model.address.tab === 'media') && edit && shownVersion && !showingOther && (
          <Banner
            tone="info"
            title={say(edit)}
            action={
              shownVersion.status !== 'DRAFT' && !newWhy ? (
                <Button size="sm" onClick={() => actions?.onNewVersionOpen?.()}>
                  {t('record.newVersion', { number: next })}
                </Button>
              ) : undefined
            }
          />
        )}
        {model.address.tab === 'steps' && <StepsTab model={model} record={record} editable={editable} actions={actions} />}
        {model.address.tab === 'media' && <MediaTab model={model} editable={editable} actions={actions} />}
        {model.address.tab === 'versions' && <VersionsTab model={model} record={record} actions={actions} />}
        {model.address.tab === 'acks' && <AcksTab model={model} record={record} actions={actions} />}
        {editable && model.changes > 0 && (model.address.tab === 'steps' || model.address.tab === 'media') && (
          <EditModeBar count={model.changes} onDiscard={() => actions?.onDiscardChanges?.()} onApply={() => actions?.onSave?.()} applyLabel={t('record.save')} busy={model.busy === 'save'} applyHeldReason={saveWhy ?? (model.busy === 'save' ? t('held.busy') : null)} saveShortcut />
        )}
      </RecordFrame>
      {model.address.approve && draft && <ApproveDialog model={model} record={record} draft={draft} held={approveWhy} actions={actions} />}
      {model.dialog?.kind === 'newVersion' && <NewVersionDialog model={model} record={record} actions={actions} />}
      {model.dialog?.kind === 'discard' && draft && <DiscardDialog model={model} draft={draft} actions={actions} />}
      {model.dialog?.kind === 'status' && <StatusDialog model={model} record={record} actions={actions} />}
      {model.dialog?.kind === 'paper' && <PaperDialog model={model} actions={actions} />}
    </div>
  )
}
