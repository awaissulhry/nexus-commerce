'use client'

import { useEffect, useState } from 'react'
import { Lock, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Field, Menu, Modal, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Tag, Textarea } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { isPageKey } from '../../../library/model'
import { KeysDialog, LibraryMessages, NoticeBanner, RecordFrame, RecordState, SaveWords } from '../../../library/parts'
import type { MaterialView } from '../../api'
import { crViText, STATUS_TONE, tabsFor, type MaterialTab } from '../../model'
import type { MaterialRecordActions, MaterialRecordViewModel } from '../record-model'
import { ColoursTab, ColourDialog } from './ColoursTab'
import { ComplianceTab } from './ComplianceTab'
import { OverviewTab } from './OverviewTab'
import { PropertiesTab } from './PropertiesTab'
import { StockTab } from './StockTab'
import { SuppliersTab } from './SuppliersTab'

export type { MaterialRecordViewModel, MaterialRecordActions } from '../record-model'

const KEYS = [
  { keys: ['n'], does: 'keys.newColour' },
  { keys: ['⌘', 'S'], does: 'keys.save' },
  { keys: ['?'], does: 'keys.help' },
]

/**
 * SCR-048 — the material record (design products.materials "Record: Material"; 00 §2.2; Owner L1: the tabs in the
 * band). The band: ‹ Materials & trims, "<code> · <name>", default supplier and base unit as meta, the kind, the state,
 * tracking and the Cr VI rule as tags, the save words, New colour as the primary and ⋯ (Archive / Reactivate, Copy code,
 * Keyboard shortcuts). Tabs: Overview (identity and units with the live converter; the facts people ask first),
 * Colours, Properties & grades, Suppliers & prices (the standard cost: cost grain only), Compliance (evidence rules, the
 * certificates covering it, its lots' test results) and Stock (Warehouse's numbers, read only). It fetches nothing.
 */
export function MaterialRecordView({ model, actions }: { model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  return (
    <LibraryMessages>
      <Record model={model} actions={actions} />
    </LibraryMessages>
  )
}

function Record({ model, actions }: { model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const back = { href: `${model.prefix}/products/materials`, label: t('material.back') }
  const loaded = model.material
  if (loaded.status === 'ready') return <Ready material={loaded.value} model={model} actions={actions} />
  return <RecordState back={back} state={loaded.status} problem={loaded.status === 'error' ? loaded.problem : null} onRetry={() => actions?.onRetry?.()} />
}

function Ready({ material, model, actions }: { material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const href = `${model.prefix}/products/materials/${material.id}`
  const tabs = tabsFor(model.can)
  const archived = material.status === 'ARCHIVED'
  const manage = model.can.materialsManage && !archived

  // n: a new colour; ?: the keys — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog) return
      if (event.key === 'n' && manage) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'colour', colourId: null })
      } else if (event.key === '?') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'help' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const more: MenuItemDef[] = [
    archived
      ? { id: 'reactivate', label: t('material.action.reactivate'), disabled: !model.can.materialsManage, description: model.can.materialsManage ? undefined : t('held.noManage'), onSelect: () => actions?.onReactivate?.() }
      : { id: 'archive', label: t('material.action.archive'), tone: 'danger', disabled: !model.can.materialsManage, description: model.can.materialsManage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'archive' }) },
    {
      id: 'copy',
      label: t('list.copyCode'),
      onSelect: () => {
        void navigator.clipboard?.writeText(material.code).catch(() => undefined)
      },
    },
    { id: 'keys', label: t('keys.menu'), onSelect: () => actions?.onDialog?.({ kind: 'help' }) },
  ]
  const crvi = crViText(material, locale)
  const meta = [material.defaultSupplier?.name ?? (material.sourcing === 'MAKE' ? t('materials.list.made') : t('materials.list.noSupplier')), t('material.baseIn', { unit: t(`uom.${material.baseUom}`) })].join(' · ')

  return (
    <RecordFrame
      back={{ href: `${model.prefix}/products/materials`, label: t('material.back') }}
      title={
        <span className="fw-lib-title">
          {material.code} <span className="fw-lib-title-name">· {material.name}</span>
        </span>
      }
      meta={meta}
      actions={
        <>
          <Button size="sm" variant="primary" heldReason={archived ? t('material.held.archived') : !model.can.materialsManage ? t('held.noManage') : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'colour', colourId: null })} aria-keyshortcuts="n">
            <Plus size={14} aria-hidden /> {t('material.action.newColour')}
          </Button>
          <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
        </>
      }
      facts={
        <>
          <span className="fw-lib-tags">
            <Tag tone="neutral">{t(`kind.${material.kind}`)}</Tag>
            <Pill tone={STATUS_TONE[material.status]}>{t(`status.${material.status}`)}</Pill>
            {material.tracking !== 'NONE' && <Tag tone="info">{t(`tracking.${material.tracking}`)}</Tag>}
            {crvi && <Tag tone="info">{t('materials.list.crvi', { limit: crvi })}</Tag>}
            {material.isPpeComponent && <Tag tone="warning">{t('materials.list.ppe')}</Tag>}
          </span>
          <SaveWords state={model.save.state} at={model.save.at} />
        </>
      }
      tabs={tabs.map((tab) => ({ id: tab, label: t(`material.tab.${tab}`), count: tab === 'colours' ? material.colours.filter((colour) => colour.status === 'ACTIVE').length : null }))}
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
      {archived && <Banner tone="info" title={<span className="fw-lib-inline"><Lock size={14} aria-hidden /> {t('material.archivedBanner')}</span>} />}
      {model.refused && model.refused.messages.length > 0 && model.notice?.tone === 'danger' && (
        <Banner tone="warning" title={t('material.refusedTitle')}>
          <ul className="fw-lib-list">
            {model.refused.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Banner>
      )}
      <Body tab={model.tab} material={material} model={model} actions={actions} />
      {model.dialog?.kind === 'colour' && <ColourDialog material={material} colourId={model.dialog.colourId} model={model} actions={actions} />}
      {model.dialog?.kind === 'archive' && <ArchiveDialog material={material} busy={model.busy} actions={actions} />}
      {model.dialog?.kind === 'help' && <KeysDialog keys={KEYS.map((entry) => ({ keys: entry.keys, does: t(entry.does) }))} onClose={() => actions?.onDialog?.(null)} />}
    </RecordFrame>
  )
}

function Body({ tab, material, model, actions }: { tab: MaterialTab; material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  switch (tab) {
    case 'colours':
      return <ColoursTab material={material} model={model} actions={actions} />
    case 'properties':
      return <PropertiesTab key={`${material.id}-${material.version}`} material={material} model={model} actions={actions} />
    case 'suppliers':
      return <SuppliersTab key={`${material.id}-${material.version}`} material={material} model={model} actions={actions} />
    case 'compliance':
      return <ComplianceTab key={`${material.id}-${material.version}`} material={material} model={model} actions={actions} />
    case 'stock':
      return <StockTab material={material} model={model} />
    default:
      return <OverviewTab key={`${material.id}-${material.version}`} material={material} model={model} actions={actions} />
  }
}

function ArchiveDialog({ material, busy, actions }: { material: MaterialView; busy: boolean; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const [reason, setReason] = useState('')
  const close = () => actions?.onDialog?.(null)
  const go = () => {
    if (busy) return
    void actions?.onArchive?.(reason.trim()).then((done) => done && close())
  }
  return (
    <Modal
      open
      onClose={close}
      title={t('material.archive.title', { code: material.code })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={go}>
            {t('material.action.archive')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          <li>{t('materials.archive.reach')}</li>
          <li>{t('materials.archive.kept')}</li>
          <li>{t('materials.archive.back')}</li>
        </ul>
        <Field label={t('dialog.reason')} hint={t('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
