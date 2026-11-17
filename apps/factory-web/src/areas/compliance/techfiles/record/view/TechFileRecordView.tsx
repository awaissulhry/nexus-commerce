'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCheck, FileX, PackagePlus, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { recordAddress as recordPage } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { evidenceAddress } from '../../../../quality/_shared/model'
import { Freshness } from '../../../../quality/_shared/parts'
import { archiveHeld, completeHeldWords, FILE_TONE, listAddress, reasonProblem, recordAddress, reopenHeld, valueOf, RECORD_TABS, type RecordTab } from '../../model'
import { PackDialog } from '../../view/PackDialog'
import { KeysModal, NoticeBanner, RECORD_KEYS, StatePill, TechfilesMessages, TechfilesStepUp, useDay, useWhen, useWords } from '../../view/parts'
import type { FileDialog, RecordActions, RecordModel } from '../view-model'
import { AnnexTab, EvidenceDialogView } from './AnnexTab'
import { PacksTab, ShareDialog, WithdrawDialog } from './PacksTab'
import { ProductionTab, TestDialogView } from './ProductionTab'
import { RiskTab, SignDialog } from './RiskTab'
import { TestsTab } from './TestsTab'
// ---- B-TH-267: the technical file on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

/** The record type the frame remembers the thread's width by (the thread's own type). */
const RECORD_TYPE = 'TechnicalFile'

/**
 * SCR-120-file — a technical file (design compliance.techfiles › Technical file; PPE Reg. (EU) 2016/425 Annex III), on RecordFrame
 * (B-TH-267; the rule of picture 38, the tabs of 08-tabs O-CMP-TF): the band in the shell's band row (‹ Technical files, the file's
 * number and its style, ONE pill — its status —, the PPE category, the certificate it supports, who keeps it and the Annex III count
 * in its details; Complete — held with the open points in words — or Build evidence pack as the primary; ⋯ Edit, Reopen, Archive,
 * the evidence trail of the newest batch, the style, Copy, the page's keys; the frame's Thread button ⌘J and Keyboard line), the
 * docked thread beside every tab (TechnicalFile is a thread record now, B-TH-075 / N14: Activity's tools in its "⋯", R-ACT), the
 * tabs 6 → 5: Annex III checklist · Risk assessment · Test reports · Production control · Evidence pack, each reading and failing on
 * its own; every banner in the ONE notice of the body column. Fetches nothing: TechFileRecord.tsx reads and writes; the thread comes
 * in as `thread` (the office's OfficeRecordThread docked, or a design case's) and `printThread` (what the print view shows of it).
 */
export function TechFileRecordView({ model, actions, thread, printThread }: { model: RecordModel; actions?: RecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <TechfilesMessages>
      <RecordPage model={model} actions={actions} thread={thread} printThread={printThread} />
    </TechfilesMessages>
  )
}

function RecordPage({ model, actions, thread, printThread }: { model: RecordModel; actions?: RecordActions | undefined; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useWords()
  const day = useDay()
  const when = useWhen()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const { record, prefix, can } = model
  const file = record.file
  const tab: RecordTab = model.tab
  const dialogOpen = !!model.fileDialog || !!model.evidence || !!model.testDialog || !!model.share || !!model.withdraw || !!model.pack || !!model.riskUi.sign || keysOpen || model.stepUp.open
  const completeWords = completeHeldWords(record, can, model.online)
  const packHeld = !can.manage ? t('held.manage') : !model.online ? t('held.offline') : null
  const trail = file.latestBatch?.batchNumber ? evidenceAddress(prefix, { batch: file.latestBatch.batchNumber }) : null

  // p: Build evidence pack; ? the keys (not in a field, a menu or a dialog). ⌘J is the frame's (the thread).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], .ag-root')) return
      if (event.key === 'p' && !packHeld) {
        event.preventDefault()
        actions?.onPack?.()
      } else if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const openPoints = record.points.filter((point) => point.state !== 'REVIEWED' && point.state !== 'NOT_APPLICABLE').length
  const production = valueOf(model.production)
  const packs = valueOf(model.packs)
  const reports = valueOf(model.reports)
  // B-TH-267: the five tabs (Activity gone: the thread is docked beside each), each counting what it lists.
  const counts: Readonly<Record<RecordTab, number | null>> = {
    annex: file.status === 'OPEN' ? openPoints : null,
    risk: null,
    tests: reports ? reports.reports.length : file.testReports.count,
    production: production ? production.summary.missing + production.summary.failed : file.production.missing + file.production.failed,
    pack: packs ? packs.packs.length : null,
  }
  const tabs: TabItem[] = RECORD_TABS.map((id) => ({ id, label: t(`tab.${id}`), count: counts[id], href: recordAddress(prefix, file.id, id) }))

  const more: MenuItemDef[] = [
    { id: 'pack', label: t('band.pack'), disabled: !!packHeld, description: packHeld ?? undefined, onSelect: () => actions?.onPack?.() },
    { id: 'edit', label: t('band.edit'), disabled: !can.manage || !model.online, description: !can.manage ? t('held.manage') : !model.online ? t('held.offline') : undefined, onSelect: () => actions?.onFileDialog?.({ kind: 'edit', certificateId: file.certificate?.id ?? '', keeperId: file.keeper?.id ?? '', note: file.note ?? '', retainUntil: file.retainUntil ?? '' }) },
    (() => {
      const held = reopenHeld(file.status, can, model.online)
      return { id: 'reopen', label: t('band.reopen'), disabled: !!held, description: held ? t(held) : undefined, onSelect: () => actions?.onFileDialog?.({ kind: 'reopen', reason: '' }) } as MenuItemDef
    })(),
    (() => {
      const held = archiveHeld(file.status, can, model.online)
      return { id: 'archive', label: t('band.archive'), disabled: !!held, description: held ? t(held) : undefined, onSelect: () => actions?.onFileDialog?.({ kind: 'archive', reason: '', retainUntil: '' }) } as MenuItemDef
    })(),
    { id: 'sep', separator: true } as MenuItemDef,
    trail ? { id: 'trail', label: t('row.trail', { batch: file.latestBatch?.batchNumber ?? '' }), href: trail, target: '_blank' } : { id: 'trail', label: t('row.trailNone'), disabled: true, description: t('held.noBatch') },
    { id: 'style', label: t('band.style', { code: file.style.code }), href: `${prefix}${recordPage({ type: 'Style', id: file.style.id }, OFFICE_PAGES)}` },
    { id: 'copy', label: t('row.copy'), onSelect: () => void navigator.clipboard?.writeText(file.number).catch(() => undefined) },
    { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
  ]

  const primary =
    file.status === 'OPEN' ? (
      <Button size="sm" variant="primary" heldReason={completeWords ? t(completeWords.key, completeWords.params) : null} onClick={() => actions?.onComplete?.()}>
        <CheckCheck size={14} aria-hidden /> {t('band.complete')}
      </Button>
    ) : (
      <Button size="sm" variant="primary" aria-keyshortcuts="p" heldReason={packHeld} onClick={() => actions?.onPack?.()}>
        <PackagePlus size={14} aria-hidden /> {t('band.pack')}
      </Button>
    )

  return (
    <RecordFrame
      recordType={RECORD_TYPE}
      personId={model.personId ?? null}
      threadLabel={t('record.dockLabel', { number: file.number })}
      thread={thread ?? null}
      printThread={printThread}
      wide={tab === 'risk' || tab === 'production'}
      band={{
        back: <Link href={listAddress(prefix)}>{t('record.back')}</Link>,
        title: (
          <>
            <span className="fw-tf-code">{file.number}</span> · {file.style.code} {file.style.name}
          </>
        ),
        status: <StatePill group="status" state={file.status} tone={FILE_TONE[file.status]} />,
        meta: (
          <span className="fw-tf-row">
            <span>{t(`ppe.${file.style.ppeCategory}`)}</span>
            {file.certificate ? (
              <Link className="fw-tf-link" href={`${prefix}${recordPage({ type: 'Certificate', id: file.certificate.id }, OFFICE_PAGES)}`}>
                {t('record.certificate', { number: file.certificate.number, standard: file.certificate.standard })}
              </Link>
            ) : (
              <span className="fw-tf-muted">{t('record.noCertificate')}</span>
            )}
            <span className="fw-tf-muted">{file.keeper ? t('record.keeper', { name: file.keeper.name }) : t('record.noKeeper')}</span>
            <span className="fw-tf-muted">{t('cell.annex', { done: file.annex.done, outOf: file.annex.outOf })}</span>
            <Freshness asOf={model.asOf} live={model.live} />
          </span>
        ),
        primary,
        more,
        moreLabel: t('band.more'),
      }}
    >
      <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={tab} size="sm" overflow="scroll" />

      {/* B-TH-267: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
      <RecordNotices>
        <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {model.changedAt && (
          <Banner
            tone="info"
            title={t('record.changed', { time: when(model.changedAt) })}
            action={
              <Button size="sm" onClick={() => actions?.onReload?.()}>
                {t('record.reload')}
              </Button>
            }
          />
        )}
        {!model.online && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
        {file.status === 'COMPLETE' && (
          <Banner tone="success" title={t('record.completeSince', { date: day(file.completedAt), name: file.completedBy?.name ?? '—' })}>
            {t('record.completeBody')}
          </Banner>
        )}
        {file.status === 'ARCHIVED' && (
          <Banner tone="neutral" title={t('record.archivedSince', { date: day(file.archivedAt), until: day(file.retainUntil) })}>
            {file.archiveReason ? t('record.archivedReason', { reason: file.archiveReason }) : t('record.archivedBody')}
          </Banner>
        )}
      </RecordNotices>

      {tab === 'annex' && <AnnexTab model={model} actions={actions} />}
      {tab === 'risk' && <RiskTab model={model} actions={actions} />}
      {tab === 'tests' && <TestsTab model={model} actions={actions} />}
      {tab === 'production' && <ProductionTab model={model} actions={actions} />}
      {tab === 'pack' && <PacksTab model={model} actions={actions} />}

      {model.fileDialog && <FileDialogView model={model} actions={actions} />}
      {model.evidence && <EvidenceDialogView model={model} state={model.evidence} actions={actions} />}
      {model.riskUi.sign && <SignDialog model={model} actions={actions} />}
      {model.testDialog && <TestDialogView model={model} state={model.testDialog} actions={actions} />}
      {model.share && <ShareDialog model={model} state={model.share} actions={actions} />}
      {model.withdraw && <WithdrawDialog model={model} state={model.withdraw} actions={actions} />}
      {model.pack && <PackDialog model={model.pack} actions={actions?.pack} />}
      <TechfilesStepUp state={model.stepUp} confirm={t('stepUp.confirm')} onSubmit={actions?.onStepUp} onCancel={actions?.onStepUpCancel} />
      {keysOpen && <KeysModal keys={RECORD_KEYS(t)} onClose={() => setKeysOpen(false)} />}
    </RecordFrame>
  )
}

/** Edit (certificate, keeper, note; a later keep-until of an archived file), Reopen and Archive (each with its reason). */
function FileDialogView({ model, actions }: { model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const state = model.fileDialog!
  const { dialog, writing } = state
  const file = model.record.file
  const set = (patch: Partial<FileDialog>) => actions?.onFileDialog?.({ ...dialog, ...patch } as FileDialog)
  const close = () => actions?.onFileDialog?.(null)
  const keepers = valueOf(model.keepers) ?? []

  if (dialog.kind === 'edit') {
    const certificateLocked = file.status !== 'OPEN'
    return (
      <Modal
        open
        onClose={close}
        title={t('edit.title', { number: file.number })}
        size="md"
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={writing.busy} heldReason={!model.online ? t('held.offline') : null} onClick={() => actions?.onFileSave?.()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="fw-tf-form">
          <NoticeBanner notice={writing.problem} />
          <Field label={t('edit.certificate')} hint={certificateLocked ? t('edit.certificateLocked') : model.certificates?.status === 'error' ? t(model.certificates.problem) : t('edit.certificateHint')}>
            <Select size="sm" value={dialog.certificateId} disabled={certificateLocked} onChange={(event) => set({ certificateId: event.target.value })}>
              <option value="">{t('edit.noCertificate')}</option>
              {file.certificate && <option value={file.certificate.id}>{`${file.certificate.number} · ${file.certificate.standard}`}</option>}
              {(valueOf(model.certificates) ?? [])
                .filter((option) => option.recordType === 'Certificate' && option.recordId && option.recordId !== file.certificate?.id)
                .map((option) => (
                  <option key={option.recordId!} value={option.recordId!}>
                    {option.label}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('edit.keeper')} hint={model.keepers?.status === 'error' ? t(model.keepers.problem) : t('edit.keeperHint')}>
            <Select size="sm" value={dialog.keeperId} disabled={model.keepers?.status === 'loading'} onChange={(event) => set({ keeperId: event.target.value })}>
              <option value="">{t('edit.noKeeper')}</option>
              {file.keeper && !keepers.some((person) => person.id === file.keeper!.id) && <option value={file.keeper.id}>{file.keeper.name}</option>}
              {keepers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('edit.note')}>
            <Textarea rows={3} value={dialog.note} maxLength={2000} onChange={(event) => set({ note: event.target.value })} />
          </Field>
          {file.status === 'ARCHIVED' && (
            <Field label={t('edit.retainUntil')} hint={t('edit.retainHint', { date: file.retainUntil ?? '—' })}>
              <DateField value={dialog.retainUntil} min={file.retainUntil ?? undefined} onChange={(value) => set({ retainUntil: value })} />
            </Field>
          )}
        </div>
      </Modal>
    )
  }

  const problem = reasonProblem(dialog.reason)
  const archive = dialog.kind === 'archive'
  return (
    <Modal
      open
      onClose={close}
      title={t(archive ? 'archive.title' : 'reopen.title', { number: file.number })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant={archive ? 'danger' : 'primary'} disabled={writing.busy} heldReason={problem ? t(problem) : !model.online ? t('held.offline') : null} onClick={() => actions?.onFileSave?.()}>
            {t(archive ? 'archive.do' : 'reopen.do')}
          </Button>
        </>
      }
    >
      <div className="fw-tf-form">
        <NoticeBanner notice={writing.problem} />
        <p className="fw-tf-muted">{t(archive ? 'archive.lead' : 'reopen.lead')}</p>
        <Field label={t(archive ? 'archive.reason' : 'reopen.reason')} required>
          <Textarea rows={3} value={dialog.reason} maxLength={500} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        {dialog.kind === 'archive' && (
          <Field label={t('archive.retainUntil')} hint={t('archive.retainHint')}>
            <DateField value={dialog.retainUntil} min={model.today} clearable onChange={(value) => set({ retainUntil: value })} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

/**
 * The file could not be read (missing, another company's, not for the role, or the read failed): said in words with a way back, inside
 * the frame (B-TH-267: the band stays in the shell's row; no thread — nothing of the file was read).
 */
export function RecordProblemView({ problem, prefix, onRetry }: { problem: string; prefix: string; onRetry?: () => void }) {
  return (
    <TechfilesMessages>
      <StateInner prefix={prefix} problem={problem} onRetry={onRetry} />
    </TechfilesMessages>
  )
}

/** The record being read: the band and the body's shape, inside the frame (no thread until the file is read). */
export function RecordLoadingView({ prefix = '' }: { prefix?: string }) {
  return (
    <TechfilesMessages>
      <StateInner prefix={prefix} problem={null} />
    </TechfilesMessages>
  )
}

function StateInner({ prefix, problem, onRetry }: { prefix: string; problem: string | null; onRetry?: (() => void) | undefined }) {
  const t = useWords()
  const back = <Link href={listAddress(prefix)}>{t('record.back')}</Link>
  const missing = problem === 'problem.notFound'
  const forbidden = problem === 'problem.forbidden'
  return (
    <RecordFrame recordType={RECORD_TYPE} personId={null} band={{ back, title: problem === null ? <Skeleton width={260} height={22} /> : t('record.name'), moreLabel: t('band.more') }} thread={null} threadLabel={t('record.name')}>
      {problem === null ? (
        <Card padded aria-busy="true">
          <p className="fw-tf-muted" role="status">
            <Spinner size={14} /> {t('common.reading')}
          </p>
          <div className="fw-tf-form">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      ) : (
        <Card padded>
          <EmptyState
            icon={forbidden ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
            title={t(missing ? 'record.notFound' : forbidden ? 'record.forbidden' : 'record.failed')}
            description={t(problem)}
            action={
              missing || forbidden || !onRetry ? (
                <Button size="sm" asChild>
                  {back}
                </Button>
              ) : (
                <Button size="sm" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              )
            }
          />
        </Card>
      )}
    </RecordFrame>
  )
}
