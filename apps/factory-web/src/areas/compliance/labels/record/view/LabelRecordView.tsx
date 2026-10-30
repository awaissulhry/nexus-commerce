'use client'

import { useEffect, useMemo } from 'react'
import Link from 'next/link'
import { Lock, MoreHorizontal, Printer as PrinterIcon } from 'lucide-react'
import { Banner, Card, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Kbd, Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { isPageKey } from '../../../../quality/_shared/hooks'
import { NoAccess, NoticeBanner, RecordFrame, RecordProblem, RecordSkeleton } from '../../../../quality/_shared/parts'
import type { LabelDetail } from '../../api'
import { activateHeld, classWords, isDirty, localActivation, localRender, newestRevision, patchOf, retireHeld, reviseHeld, saveHeld, testPrintHeld } from '../../model'
import { LabelsMessages, ShortcutsDialog, StatusPill } from '../../view/parts'
import type { LabelRecordActions, LabelRecordModel, RecordTab } from '../../view-model'
import { Builder, ContentFacts } from './Builder'
import { RecordDialogs } from './dialogs'
import { PrintsTab, VersionsTab } from './OtherTabs'
import { PreviewPanel } from './PreviewPanel'

export type { LabelRecordActions, LabelRecordModel } from '../../view-model'

/**
 * SCR-053 the label record (design compliance.labels "Record: Label", 00 §2.2; Owner L1: the tabs in the band): ‹ Labels &
 * marking, "<code> r<n> · PPE garment label", the style it marks, its status and the save words; the next step as the
 * primary — Activate revision N (the approval: held with the count of what still fails) on a draft, New revision on an
 * active label — then Print test label and ⋯ (Retire…, the print sheet as a PDF, Copy code, keys). Tabs: Content (the
 * builder: the form beside the live preview and the rule checks), Versions, Test prints. An active or retired label is
 * frozen: its content shows as text with the words why. It draws one view model and fetches nothing.
 */
export function LabelRecordView({ model, actions }: { model: LabelRecordModel; actions?: LabelRecordActions }) {
  return (
    <LabelsMessages>
      <Record model={model} actions={actions} />
    </LabelsMessages>
  )
}

function Record({ model, actions }: { model: LabelRecordModel; actions?: LabelRecordActions }) {
  const t = useT('labels')
  const back = (
    <Button size="sm" asChild>
      <Link href={`${model.prefix}/compliance/labels`}>{t('record.back')}</Link>
    </Button>
  )
  if (!model.can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />
  if (model.detail.problem) return <RecordProblem problem={model.detail.problem} back={back} onRetry={actions?.onRetry} />
  if (!model.detail.value) return <RecordSkeleton />
  return <Ready detail={model.detail.value} model={model} actions={actions} />
}

function Ready({ detail, model, actions }: { detail: LabelDetail; model: LabelRecordModel; actions?: LabelRecordActions }) {
  const t = useT('labels')
  const q = useT('quality')
  const locale = useLocale()
  const can = model.can
  const editable = detail.status === 'DRAFT' && can.manage
  const draft = editable ? model.draft : null
  const dirty = isDirty(detail, draft)
  const changes = draft ? Object.keys(patchOf(detail, draft)).length : 0
  const values = model.preview.value?.values ?? null
  const local = dirty && !!draft && !!values
  const label = useMemo(() => (local && draft ? localRender(detail, draft, values) : (model.preview.value?.label ?? null)), [local, draft, detail, values, model.preview.value])
  const activation = useMemo(() => (dirty && draft ? localActivation(detail, draft, values, model.today) : detail.problems), [dirty, draft, detail, values, model.today])
  const warnings = detail.warnings

  const activate = activateHeld(detail, can, activation.length, dirty)
  const revise = reviseHeld(detail, can)
  const retire = retireHeld(detail, can)
  const test = testPrintHeld(can, model.printers.value)
  const save = saveHeld(can, dirty, model.save.state === 'saving')
  const words = (held: { key: string; params?: Record<string, string | number> } | null) => (held ? t(held.key, held.params) : null)

  // Keys: ⌘S saves the draft, t prints a test label, ? the keys (never while typing or in a dialog; ⌘S works in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
        if (!editable || model.dialog) return
        event.preventDefault()
        if (!save) actions?.onSave?.()
        return
      }
      if (model.dialog || !isPageKey(event)) return
      if (event.key === 't' && !test) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'test', printerId: null, copies: 1 })
      } else if (event.key === '?') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'shortcuts' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, editable, model.dialog, save, test])

  const tabs: { id: RecordTab; label: string; count?: number | null }[] = [
    { id: 'content', label: t('tab.content') },
    { id: 'versions', label: t('tab.versions'), count: detail.revisions.length },
    ...(can.printView ? [{ id: 'prints' as const, label: t('tab.prints'), count: model.prints.value?.length ?? null }] : []),
  ]
  const tab = tabs.some((entry) => entry.id === model.tab) ? model.tab : 'content'
  const recordHref = `${model.prefix}/compliance/labels/${encodeURIComponent(detail.id)}`

  const primary =
    detail.status === 'DRAFT' ? (
      <Button size="sm" variant="primary" heldReason={words(activate)} onClick={() => actions?.onDialog?.({ kind: 'activate' })}>
        {t('action.activate', { revision: detail.revision })}
      </Button>
    ) : detail.status === 'ACTIVE' ? (
      <Button size="sm" variant="primary" heldReason={words(revise)} onClick={() => actions?.onDialog?.({ kind: 'revise' })}>
        {t('action.revise', { revision: newestRevision(detail) + 1 })}
      </Button>
    ) : null
  const more: MenuItemDef[] = [
    ...(detail.status === 'RETIRED' ? [{ id: 'revise', label: t('action.revise', { revision: newestRevision(detail) + 1 }), disabled: !!revise, description: words(revise) ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'revise' }) }] : []),
    { id: 'retire', label: t('action.retire'), tone: 'danger' as const, disabled: !!retire, description: words(retire) ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'retire', reason: '' }) },
    { id: 'sheet', label: t('action.sheet'), disabled: !model.preview.value, description: model.preview.value ? t('action.sheetHint') : t('held.noPreview'), onSelect: () => actions?.onPrintSheet?.() },
    { id: 'copy', label: t('action.copy'), onSelect: () => actions?.onCopy?.(detail.code) },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onDialog?.({ kind: 'shortcuts' }) },
  ]

  const saveWords =
    model.save.state === 'saving' ? (
      <span className="fw-lb-save" role="status">
        <Spinner size={12} /> {t('save.saving')}
      </span>
    ) : model.save.state === 'failed' ? (
      <span className="fw-lb-save is-failed" role="status">
        {t('save.failed')}
      </span>
    ) : dirty ? (
      <span className="fw-lb-save" role="status">
        {t('save.unsaved', { count: changes })}
      </span>
    ) : model.save.at ? (
      <span className="fw-lb-save" role="status">
        {t('save.saved', { time: formatTime(model.save.at, { locale }) })}
      </span>
    ) : null

  const classes = classWords(detail.style)
  return (
    <>
      <RecordFrame
        back={{ href: `${model.prefix}/compliance/labels`, label: t('record.back') }}
        title={
          <span className="fw-lb-title">
            {t('record.title', { code: detail.code, revision: detail.revision })} <span className="fw-lb-title-kind">· {t('record.kind')}</span>
          </span>
        }
        meta={
          <span className="fw-q-cell-row">
            {detail.style ? (
              can.styles ? (
                <Link className="fw-q-link fw-q-code" href={`${model.prefix}/products/styles/${encodeURIComponent(detail.style.id)}?tab=compliance`}>
                  {detail.style.code}
                </Link>
              ) : (
                <span className="fw-q-code">{detail.style.code}</span>
              )
            ) : (
              <Tag tone="neutral">{t('list.shared')}</Tag>
            )}
            {classes && <span className="fw-q-hint">{classes}</span>}
            <span className="fw-q-hint">{detail.name}</span>
          </span>
        }
        status={
          <span className="fw-q-cell-row">
            <StatusPill status={detail.status} />
            {saveWords}
            <span className="fw-q-hint">{q(`live.${model.live}`)}</span>
          </span>
        }
        actions={
          <>
            {primary}
            <Button size="sm" heldReason={words(test)} onClick={() => actions?.onDialog?.({ kind: 'test', printerId: null, copies: 1 })} aria-keyshortcuts="t">
              <PrinterIcon size={14} aria-hidden /> <span className="fw-lb-hide-phone">{t('action.test')}</span>
            </Button>
            <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('record.more') }} items={more} />
          </>
        }
        tabs={tabs}
        active={tab}
        tabHref={(id) => `${recordHref}?tab=${id}`}
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
          >
            {dirty ? t('record.changedDirty') : undefined}
          </Banner>
        )}
        <NoticeBanner notice={model.notice} namespace="labels" onDismiss={actions?.onDismissNotice} />
        {detail.status !== 'DRAFT' && (
          <Banner
            tone="info"
            title={
              <span className="fw-q-cell-row">
                <Lock size={14} aria-hidden /> {t(detail.status === 'ACTIVE' ? 'record.frozenActive' : 'record.frozenRetired', { code: detail.code, revision: detail.revision })}
              </span>
            }
          />
        )}
        {detail.status === 'DRAFT' && !can.manage && <Banner tone="info" title={t('record.viewOnly')} />}

        {tab === 'content' && (
          <div className="fw-lb-builder">
            <div className="fw-lb-main">
              {draft && (
                <Card padded className="fw-lb-savebar">
                  <span className="fw-lb-savebar-row" role="region" aria-label={t('save.bar')}>
                    <span>{dirty ? t('save.unsaved', { count: changes }) : t('save.none')}</span>
                    <span className="fw-lb-savebar-keys" aria-hidden>
                      <Kbd>⌘</Kbd>
                      <Kbd>S</Kbd>
                    </span>
                    <span className="fw-lb-grow" />
                    <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'discard' })} heldReason={dirty ? null : t('held.nothing')}>
                      {t('save.discard')}
                    </Button>
                    <Button size="sm" variant="primary" heldReason={words(save)} onClick={() => actions?.onSave?.()} aria-keyshortcuts="Meta+S Control+S">
                      {t('save.save')}
                    </Button>
                  </span>
                </Card>
              )}
              {draft ? <Builder detail={detail} draft={draft} problems={activation} onDraft={(next) => actions?.onDraft?.(next)} /> : <ContentFacts detail={detail} />}
            </div>
            <PreviewPanel detail={detail} model={model} actions={actions} label={label} activation={detail.status === 'DRAFT' ? activation : []} warnings={warnings} local={local} />
          </div>
        )}
        {tab === 'versions' && <VersionsTab detail={detail} model={model} />}
        {tab === 'prints' && <PrintsTab model={model} actions={actions} />}
      </RecordFrame>
      <RecordDialogs detail={detail} model={model} actions={actions} activation={activation} />
      <ShortcutsDialog
        open={model.dialog?.kind === 'shortcuts'}
        onClose={() => actions?.onDialog?.(null)}
        keys={[
          { keys: ['⌘', 'S'], does: t('keys.save') },
          { keys: ['t'], does: t('keys.test') },
          { keys: ['Alt', '↑'], does: t('keys.moveUp') },
          { keys: ['Alt', '↓'], does: t('keys.moveDown') },
          { keys: ['?'], does: t('keys.help') },
        ]}
      />
    </>
  )
}
