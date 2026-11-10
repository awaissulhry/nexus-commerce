'use client'

import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Banner, Menu, Tabs } from '@nexus/ui/components'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { tabOf, tabsFor, type SettingsTab } from '../model'
import type { RulesMarketsActions, RulesMarketsModel } from '../view-model'
import '../settings.css'
import { Cr6Tab } from './Cr6Tab'
import { GatesTab } from './GatesTab'
import { MarketsTab } from './MarketsTab'
import { OperatorsTab } from './OperatorsTab'
import { PhrasesTab } from './PhrasesTab'
import { RegsTab } from './RegsTab'
import { KeysModal, NoTabAccess, NoticeBanner, RulesStepUp, SETTINGS_NAMESPACES, useWords } from './parts'

export type { RulesMarketsActions, RulesMarketsModel } from '../view-model'

/** Which tabs have an "Add …" (`c`) and the right it needs. */
const ADDS: Readonly<Partial<Record<SettingsTab, 'requirementsManage' | 'rulesManage' | 'phrasesManage'>>> = { gates: 'requirementsManage', regulations: 'rulesManage', markets: 'rulesManage', phrases: 'phrasesManage', operators: 'rulesManage' }

/**
 * SCR-262 — Compliance › Settings › Rules & markets (design compliance.settings, archetype settings-form; PRD-272 … PRD-275,
 * PRD-298, PRD-343): the band (when it was read and whether it is live; ⋯ Read again, keys), the link tabs (rm-tabs: one save
 * model each — Chromium VI and Gates with the EditModeBar, Regulations, Markets and Operators autosaved per cell, Phrases
 * proposed and approved), then the tab: each loads and fails on its own, the rest of the page stays usable. One view model,
 * nothing fetched; the page fills the main area (no max-width); every word from the catalogues; every held button says why.
 */
export function RulesMarketsView({ model, actions }: { model: RulesMarketsModel; actions?: RulesMarketsActions }) {
  return (
    <WithMessages namespaces={SETTINGS_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: RulesMarketsModel; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const tab = tabOf(model.address, model.can)
  const tabs = tabsFor(model.can)
  const right = tab ? ADDS[tab] : undefined
  const mayAdd = !!right && model.can[right] && model.live !== 'offline'
  const latest = useRef({ model, actions, mayAdd })
  latest.current = { model, actions, mayAdd }
  const dialogOpen = model.address.add || !!model.address.open || !!model.address.change || keysOpen || model.stepUp.open

  // c adds on the tab shown (when the person may), ? the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'c' && current.mayAdd) {
        event.preventDefault()
        current.actions?.onAddress?.({ add: true })
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen])

  if (!tab) {
    return (
      <div className="fw-rm">
        <NoTabAccess title={t('access.title')} body={t('access.body')} />
      </div>
    )
  }

  const help = () => setKeysOpen(true)
  const notice = model.notice
  return (
    <div className="fw-rm">
      <div className="fw-rm-band" role="group" aria-label={t('band.label')}>
        <span className="fw-rm-status" role="status">
          {model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-rm-muted">{t('common.reading')}</span>}
          <span className="fw-rm-muted"> · {t(`live.${model.live}`)}</span>
        </span>
        <span className="fw-rm-tools">
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'reload', label: t('band.reload'), onSelect: () => actions?.onReload?.() },
              { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
            ]}
          />
        </span>
      </div>
      {model.live === 'offline' && <Banner tone="warning" title={t('held.offline')} />}
      {notice && <NoticeBanner tone={notice.tone} title={t(notice.key, notice.params)} onClose={() => actions?.onDismissNotice?.()} />}
      <Tabs
        ariaLabel={t('tabs.label')}
        size="lg"
        tabs={tabs.map((id) => ({ id, label: t(`tabs.${id}`), href: `${model.prefix}/compliance/settings?tab=${id}` }))}
        active={tab}
      />
      <div className="fw-rm-panel-body">
        {tab === 'cr6' && <Cr6Tab model={model} state={model.cr6} actions={actions?.cr6} />}
        {tab === 'gates' && <GatesTab model={model} state={model.gates} actions={actions} onHelp={help} />}
        {tab === 'regulations' && <RegsTab model={model} state={model.regs} actions={actions} onHelp={help} />}
        {tab === 'markets' && <MarketsTab model={model} state={model.markets} actions={actions} onHelp={help} />}
        {tab === 'phrases' && <PhrasesTab model={model} state={model.phrases} actions={actions} onHelp={help} />}
        {tab === 'operators' && <OperatorsTab model={model} state={model.operators} actions={actions} onHelp={help} />}
      </div>
      <RulesStepUp state={model.stepUp} onSubmit={actions?.onStepUp} onCancel={actions?.onStepUpCancel} />
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
