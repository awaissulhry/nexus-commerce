'use client'

import { useEffect, useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { rulesChanged, toleranceChanges, type Scope } from '../model'
import { SETTINGS_NAMESPACES, type ProductSettingsActions, type ProductSettingsModel } from '../view-model'
import { CostingCard } from './CostingCard'
import { EditRulesCard } from './EditRulesCard'
import { Freshness, KeysDialog, LoosenDialog, NoAccess } from './parts'
import { ToleranceCard } from './ToleranceCard'
import { TypeDialog } from './TypeDialog'
import { newTypeHeld, TypesCard } from './TypesCard'
import '../settings.css'

/**
 * SCR-251 Products › Settings › Product settings (design products.settings, settings-form; PRD-008, PRD-105, PRD-182): whose
 * settings (this company, or every company: a company follows every company where it keeps nothing), then four cards —
 * Product types (the tree in the list frame, the type dialog), Edit rules per lifecycle state (the visible state × rule
 * table), Consumption tolerance (general and per material kind) and Costing defaults (read only: Finance settings is their
 * one home). Each form card saves with its EditModeBar (⌘S) and says who changed it last. Fetches nothing.
 */
export function ProductSettingsView({ model, actions }: { model: ProductSettingsModel; actions?: ProductSettingsActions }) {
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

function Page({ model, actions }: { model: ProductSettingsModel; actions?: ProductSettingsActions }) {
  const t = useT('products-settings')
  const locale = useLocale()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  // c: New product type (outside fields and dialogs), when the person may keep types.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      if (current.model.typeDialog || current.model.loosen || current.model.keysOpen || newTypeHeld(current.model) !== null) return
      event.preventDefault()
      current.actions?.onTypeOpen?.('new')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!model.can.view) return <NoAccess />
  const settings = model.settings.value
  const rulesCount = settings && model.rules ? rulesChanged(settings, model.rules).length : 0
  const toleranceCount = settings && model.tolerance ? toleranceChanges(settings, model.tolerance, locale) : 0
  const dialogOpen = !!model.typeDialog || !!model.loosen || model.keysOpen
  const moreItems: MenuItemDef[] = [
    { id: 'reload', label: t('head.reload'), onSelect: () => actions?.onReload?.() },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.() },
  ]
  return (
    <div className="fw-pst">
      <div className="fw-pst-head">
        <div className="fw-pst-head-text">
          <p className="fw-pst-intro">{t('head.intro')}</p>
          <Freshness asOf={model.asOf} live={model.live} />
        </div>
        <div className="fw-pst-actions">
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
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params as Record<string, string | number> | undefined)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
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
      {model.live === 'offline' && <Banner tone="warning" title={t('held.offlineTitle')}>{t('held.offlineBody')}</Banner>}
      {settings && <p className="fw-pst-hint">{t(model.address.scope === 'company' ? 'scope.companyHint' : 'scope.allHint', { company: model.companyName })}</p>}

      <TypesCard model={model} actions={actions} />
      <EditRulesCard model={model} actions={actions} shortcut={!dialogOpen && rulesCount > 0} />
      <div className="fw-pst-grid">
        <ToleranceCard model={model} actions={actions} shortcut={!dialogOpen && rulesCount === 0 && toleranceCount > 0} />
        <CostingCard model={model} actions={actions} />
      </div>

      <TypeDialog model={model} actions={actions} />
      <LoosenDialog loosen={model.loosen} busy={model.busy === 'rules'} onReason={(reason) => actions?.onLoosenReason?.(reason)} onConfirm={() => actions?.onLoosenConfirm?.()} onClose={() => actions?.onLoosenCancel?.()} />
      <KeysDialog open={model.keysOpen} onClose={() => actions?.onKeysClose?.()} />
    </div>
  )
}
