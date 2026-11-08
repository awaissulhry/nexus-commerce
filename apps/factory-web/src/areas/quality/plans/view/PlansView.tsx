'use client'

import { useEffect, useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { Freshness, NoAccess, NoticeBanner, PageHead } from '../../_shared/parts'
import type { StepUpState } from '../../_shared/hooks'
import type { LiveState, Notice, Read } from '../../_shared/model'
import type { AqlPlanView, Assignment, PickOption, PlansAnswer, ProfilesAnswer, RulePreview, RulesAnswer, Starter } from '../api'
import { PAGE_TABS, queryOf, tabAllowed, type NewPlanDraft, type PageTab, type PlansAddress, type PlansCan, type ProfileDraft, type RuleDraft } from '../model'
import { AqlTab, type AqlActions } from './AqlTab'
import { CalculatorTab, type CalculatorActions } from './CalculatorTab'
import { NewPlanDialog, type NewPlanActions } from './NewPlanDialog'
import { KeysDialog, PlansMessages, PlansStepUp, type ChipSearch } from './parts'
import { PlansTab, type PlansTabActions } from './PlansTab'
import { TriggersTab, type TriggersActions } from './TriggersTab'

export interface PlansModel {
  readonly prefix: string
  readonly companyId: string | null
  readonly can: PlansCan
  readonly address: PlansAddress
  readonly live: LiveState
  readonly asOf: string | null
  readonly notice: Notice | null
  readonly plans: Read<PlansAnswer>
  readonly selected: readonly string[]
  /** The starter set (New plan's "Start from", the empty list's offer); null until asked. */
  readonly starter: Read<Starter[]> | null
  readonly newPlan: { readonly draft: NewPlanDraft; readonly shown: boolean; readonly problem: string | null } | null
  readonly profiles: Read<ProfilesAnswer>
  readonly profileDrafts: readonly ProfileDraft[] | null
  readonly assignments: {
    readonly profileId: string
    readonly read: Read<Assignment[]>
    readonly customer: PickOption | null
    readonly style: PickOption | null
    readonly customers: Read<PickOption[]> | null
    readonly styles: Read<PickOption[]> | null
    readonly problem: string | null
  } | null
  readonly rules: Read<RulesAnswer>
  readonly ruleDrafts: readonly RuleDraft[] | null
  readonly ruleDialog: { readonly draft: RuleDraft; readonly shown: boolean; readonly preview: Read<RulePreview> | null } | null
  readonly chipSearch: ChipSearch | null
  readonly calc: Read<{ readonly profile: { readonly code: string; readonly name: string } | null; readonly plan: AqlPlanView }>
  readonly busy: 'newPlan' | 'starter' | 'aql' | 'assign' | 'triggers' | null
  readonly stepUp: StepUpState
  readonly keysOpen: boolean
}

export interface PlansActions extends PlansTabActions, NewPlanActions, AqlActions, TriggersActions, CalculatorActions {
  onReload?: () => void
  onDismissNotice?: () => void
  onKeys?: () => void
  onKeysClose?: () => void
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
}

/**
 * SCR-077 Quality › Settings › Inspection plans & AQL (design quality.plans, a settings page; QHS-008 … QHS-013, QHS-020,
 * QHS-021): four link tabs (`?tab=`), each with ONE save model — Plans (the list frame: checklist templates per stage,
 * New plan, the starter set), AQL profiles (a form card with its EditModeBar; critical locked at 0 with the law; where a
 * profile applies), When inspections are created (the ordered rules, an EditModeBar, a preview of last month), and the AQL
 * calculator (read-only: lot and level → code letter, sample and Ac/Re in words). Fetches nothing.
 */
export function PlansView({ model, actions }: { model: PlansModel; actions?: PlansActions }) {
  return (
    <PlansMessages>
      <Page model={model} actions={actions} />
    </PlansMessages>
  )
}

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || !!element.closest('[role="dialog"]'))
}

function Page({ model, actions }: { model: PlansModel; actions?: PlansActions }) {
  const t = useT('quality-plans')
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  // c: New plan (Plans tab, outside fields and dialogs), when the person may keep plans.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      if (current.model.address.tab !== 'plans' || current.model.newPlan || !current.model.can.manage) return
      event.preventDefault()
      current.actions?.onNewPlan?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const allowed = PAGE_TABS.filter((tab) => tabAllowed(tab, model.can))
  if (allowed.length === 0) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />
  const tab = model.address.tab
  const href = (to: PageTab) => `${model.prefix}/quality/plans${queryOf({ ...model.address, tab: to, newPlan: false, copy: null, profile: null, rule: null })}`
  const tabs: TabItem[] = PAGE_TABS.map((id) => ({
    id,
    label: t(`tab.${id}`),
    href: href(id),
    count: id === 'plans' ? (model.plans.value?.plans.length ?? null) : id === 'aql' ? (model.profiles.value?.profiles.filter((profile) => profile.active).length ?? null) : id === 'triggers' ? (model.rules.value?.rules.length ?? null) : null,
    disabled: !tabAllowed(id, model.can),
  }))
  const moreItems: MenuItemDef[] = [
    { id: 'reload', label: t('head.reload'), onSelect: () => actions?.onReload?.() },
    { id: 'import', label: t('head.import'), description: t('head.later'), disabled: true },
    { id: 'export', label: t('head.export'), description: t('head.later'), disabled: true },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.() },
  ]
  return (
    <div className="fw-q fw-qp">
      <PageHead
        intro={t('head.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('head.more') }} items={moreItems} />
            {tab === 'plans' && model.can.manage && (
              <Button variant="primary" size="sm" aria-keyshortcuts="c" heldReason={model.live === 'offline' ? t('held.offline') : null} onClick={() => actions?.onNewPlan?.()}>
                {t('plans.new')}
              </Button>
            )}
          </>
        }
      />
      <Tabs ariaLabel={t('tab.label')} tabs={tabs} active={tab} size="sm" overflow="scroll" />
      <NoticeBanner notice={model.notice} namespace="quality-plans" onDismiss={() => actions?.onDismissNotice?.()} />
      {model.live === 'offline' && <Banner tone="warning" title={t('held.offlineBanner')} />}
      {!tabAllowed(tab, model.can) ? (
        <Card padded>
          <EmptyState title={t('noAccess.tabTitle')} description={t(`noAccess.${tab}`)} />
        </Card>
      ) : tab === 'plans' ? (
        <PlansTab model={model} actions={actions} />
      ) : tab === 'aql' ? (
        <AqlTab model={model} actions={actions} />
      ) : tab === 'triggers' ? (
        <TriggersTab model={model} actions={actions} />
      ) : (
        <CalculatorTab model={model} actions={actions} />
      )}
      {model.newPlan && <NewPlanDialog model={model} actions={actions} />}
      <PlansStepUp state={model.stepUp} onSubmit={(code) => actions?.onStepUp?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />
      <KeysDialog
        open={model.keysOpen}
        onClose={() => actions?.onKeysClose?.()}
        keys={[
          { keys: 'c', does: t('keys.new') },
          { keys: '⌘S', does: t('keys.save') },
          { keys: '/', does: t('keys.search') },
          { keys: 'j / k', does: t('keys.rows') },
          { keys: 'x', does: t('keys.select') },
          { keys: 'Enter', does: t('keys.open') },
        ]}
      />
    </div>
  )
}
