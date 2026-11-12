'use client'

import { useEffect, useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { auditHref, defaultChanges, mayKeepTolerances, ownDefaultOf, type Scope } from '../model'
import { SETTINGS_NAMESPACES, type PurchasingSettingsActions, type PurchasingSettingsModel } from '../view-model'
import { ApprovalCard } from './ApprovalCard'
import { ConfirmationCard } from './ConfirmationCard'
import { Freshness, KeysDialog, NoAccess, NoticeBanner, NS, ReminderStepUp } from './parts'
import { ToleranceCard } from './ToleranceCard'
import { ToleranceDialog } from './ToleranceDialog'
import '../settings.css'

/**
 * SCR-256 Purchasing › Settings › Purchasing settings (design purchasing.settings, settings-form; SCM-078, SCM-061, SCM-087;
 * follow-up PU2:01): whose settings (this company, or every company — a company follows every company where it keeps
 * nothing), the band (when read and live, SaveStatus, ⋯ Reload · History · Keyboard shortcuts), then three cards — PO
 * approval (the approval engine's purchase order rules, shown and opened in Admin › Automation), Delivery tolerances (the
 * default with its EditModeBar and the exceptions in the list frame) and Confirmation (the confirm-by time, the Owner's
 * reminder switch with its step-up, the buyer's alert). Each card says who changed it last. Fetches nothing.
 */
export function PurchasingSettingsView({ model, actions }: { model: PurchasingSettingsModel; actions?: PurchasingSettingsActions }) {
  return (
    <WithMessages namespaces={SETTINGS_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
}

function Page({ model, actions }: { model: PurchasingSettingsModel; actions?: PurchasingSettingsActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const ds = useDsWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const dialogOpen = !!model.dialog || model.keysOpen || model.stepUp.open
  // c: New exception (outside fields and dialogs), when the person may keep tolerances.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      if (current.model.dialog || current.model.keysOpen || current.model.stepUp.open || !current.model.tolerances.value) return
      if (!mayKeepTolerances(current.model.tolerances.value, current.model.address.scope, current.model.companyId, current.model.can.tolerances) || current.model.live === 'offline') return
      event.preventDefault()
      current.actions?.onToleranceOpen?.('new')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!model.can.view) return <NoAccess />
  const rows = model.tolerances.value
  const defaultCount = rows && model.defaultDraft ? defaultChanges(ownDefaultOf(rows, model.address.scope, model.companyId), model.defaultDraft) : 0
  const reminderChanged = model.reminders.value !== null && model.reminderDraft !== null && model.reminderDraft !== model.reminders.value.on
  const moreItems: MenuItemDef[] = [
    { id: 'reload', label: t('head.reload'), onSelect: () => actions?.onReload?.() },
    ...(model.can.audit ? [{ id: 'history', label: t('head.history'), href: auditHref(model.prefix, 'DeliveryTolerance'), target: '_blank' as const }] : []),
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.() },
  ]
  return (
    <div className="fw-pus">
      <div className="fw-pus-head">
        <div className="fw-pus-head-text">
          <p className="fw-pus-intro">{t('head.intro')}</p>
          <Freshness asOf={model.asOf} live={model.live} />
        </div>
        <div className="fw-pus-actions">
          <SaveStatus state={model.save} labels={ds.saveStatus} formatTime={(iso) => formatTime(iso, { locale })} />
          <SegmentedControl
            size="sm"
            ariaLabel={t('scope.label')}
            value={model.address.scope}
            onChange={(value) => actions?.onScope?.(value as Scope)}
            options={[
              { value: 'company', label: t('scope.company', { company: model.companyName }) },
              { value: 'all', label: t('scope.all') },
            ]}
          />
          <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('head.more') }} items={moreItems} />
        </div>
      </div>
      {model.notice && <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />}
      {model.changedElsewhere && (
        <Banner
          tone="warning"
          title={t('live.changedTitle')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('live.reload')}
            </Button>
          }
        >
          {t('live.changedBody')}
        </Banner>
      )}
      {model.live === 'offline' && (
        <Banner tone="warning" title={t('held.offlineTitle')}>
          {t('held.offlineBody')}
        </Banner>
      )}
      <p className="fw-pus-hint">{t(model.address.scope === 'company' ? 'scope.companyHint' : 'scope.allHint', { company: model.companyName })}</p>

      <ApprovalCard model={model} actions={actions} />
      <ToleranceCard model={model} actions={actions} shortcut={!dialogOpen && defaultCount > 0} />
      <ConfirmationCard model={model} actions={actions} shortcut={!dialogOpen && defaultCount === 0 && reminderChanged} />

      <ToleranceDialog model={model} actions={actions} />
      <ReminderStepUp state={model.stepUp} onSubmit={actions?.onStepUpSubmit} onCancel={actions?.onStepUpCancel} />
      <KeysDialog open={model.keysOpen} onClose={() => actions?.onKeysClose?.()} />
    </div>
  )
}
