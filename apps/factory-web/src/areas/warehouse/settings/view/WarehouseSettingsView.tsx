'use client'

import { MoreHorizontal } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { auditHref, dirtyCards, type Scope } from '../model'
import { SETTINGS_NAMESPACES, type WarehouseSettingsActions, type WarehouseSettingsModel } from '../view-model'
import { AdjustCard } from './AdjustCard'
import { CrViPanel } from './CrViPanel'
import { DefaultsCard } from './DefaultsCard'
import { Freshness, KeysDialog, NoAccess, NoticeBanner, NS, RulesStepUp } from './parts'
import { PostingCard } from './PostingCard'
import { SeparationCard } from './SeparationCard'
import '../settings.css'

/**
 * SCR-258 Warehouse › Settings › Warehouse rules (design warehouse.settings, settings-form; SCM-293, SCM-179, SCM-192,
 * SCM-196): whose rules (this company — it follows every company where it keeps nothing — or every company), the band (when
 * read and live, SaveStatus, ⋯ Read again · History · Keyboard shortcuts), then the cards — Separation of duties, Posting
 * dates, Default locations, Adjustment approval (with the low-stock alerts) and the Cr VI evidence rule (where it lives).
 * Each card says who changed it last and saves on its own (EditModeBar; ⌘S saves the first card changed); a change that
 * widens what one person may do asks the reason, then "Confirm it is you". Fetches nothing.
 */
export function WarehouseSettingsView({ model, actions }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions }) {
  return (
    <WithMessages namespaces={SETTINGS_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const ds = useDsWords()
  if (!model.can.view) return <NoAccess />
  const dirty = dirtyCards(model)
  const dialogOpen = model.keysOpen || model.stepUp.open
  // ⌘S saves the first card with a change (the page's order), never behind a dialog.
  const first = dialogOpen ? null : (dirty[0] ?? null)
  const moreItems: MenuItemDef[] = [
    { id: 'reload', label: t('head.reload'), onSelect: () => actions?.onReload?.() },
    ...(model.can.audit ? [{ id: 'history', label: t('head.history'), href: auditHref(model.prefix, 'InventorySettings', model.rowId), target: '_blank' as const }] : []),
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.() },
  ]
  return (
    <div className="fw-whs">
      <div className="fw-whs-head">
        <div className="fw-whs-head-text">
          <p className="fw-whs-intro">{t('head.intro')}</p>
          <Freshness asOf={model.asOf} live={model.live} />
        </div>
        <div className="fw-whs-actions">
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
      <p className="fw-whs-hint">{t(model.address.scope === 'company' ? 'scope.companyHint' : 'scope.allHint', { company: model.companyName })}</p>

      <div className="fw-whs-grid">
        <SeparationCard model={model} actions={actions} shortcut={first === 'separation'} />
        <PostingCard model={model} actions={actions} shortcut={first === 'posting'} />
        <DefaultsCard model={model} actions={actions} shortcut={first === 'defaults'} />
        <AdjustCard model={model} actions={actions} shortcut={first === 'adjust'} alertsShortcut={first === 'alerts'} />
        <CrViPanel model={model} actions={actions} />
      </div>

      <RulesStepUp state={model.stepUp} onSubmit={actions?.onStepUpSubmit} onCancel={actions?.onStepUpCancel} />
      <KeysDialog open={model.keysOpen} onClose={() => actions?.onKeysClose?.()} />
    </div>
  )
}
