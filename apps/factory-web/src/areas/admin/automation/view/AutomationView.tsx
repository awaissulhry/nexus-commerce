'use client'

import { useEffect, useState } from 'react'
import { MoreHorizontal, Plus, Workflow } from 'lucide-react'
import { Banner, Card, EmptyState, Menu } from '@nexus/ui/components'
import { Button, InfoTip, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { AsOf, Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { AlertRule } from '../../../_shared/rules/api'
import type { RuleDraft } from '../../../_shared/rules/model'
import { RuleDialog } from '../../../_shared/rules/view/RuleDialog'
import { RulesList } from '../../../_shared/rules/view/RulesList'
import { BUILT, isDateRule, KNOWN_MODULE_TIMERS, LATER, moduleTimerKey, newHeld, VIEWS, viewOfKey, type AutomationView as View, type AutomationViewModel } from '../model'
import '../automation.css'

export type { AutomationViewModel } from '../model'

/** What the page asks of its container (AutomationPage.tsx). Absent in the design index: the view keeps its own state. */
export interface AutomationActions {
  onView?: (view: View) => void
  onRule?: (id: string | null) => void
  onRetry?: () => void
  onSwitch?: (rule: AlertRule, next: boolean) => void
  onNumber?: (rule: AlertRule, key: string, value: number) => void
  onSave?: (draft: RuleDraft) => Promise<boolean>
  onTest?: (draft: RuleDraft, ruleId: string) => void
  onRetryChoices?: () => void
  onRetryTimers?: () => void
  onHelp?: (open: boolean) => void
  onDismissNotice?: () => void
}

/**
 * SCR-167 — Admin › Platform › Approvals, automation & AI (design admin.automation, the W2a part; PLT-100): the band (when
 * read, New rule `c`, ⋯ Run log and Turn all AI off — W3, held), the five lists in a segmented control (keys 1–5; W2a builds
 * Reminders & timers, the others say when they come), and Reminders & timers: every date rule as its sentence — "30 days
 * before a certificate expires, tell Quality inspector by the bell at most once a day." — its number edited in place,
 * whom it tells, how often, its waiting timers and the next one, last fired, fired in 7 days, on/off; a row opens the rule
 * dialog with its timers. Then the reminders the modules keep themselves, with where. It draws ONE view model.
 */
export function AutomationView({ model, actions }: { model: AutomationViewModel; actions?: AutomationActions }) {
  return (
    <WithMessages namespaces={['admin-automation', 'rules', 'lists']}>
      <Automation model={model} actions={actions} />
    </WithMessages>
  )
}

function Automation({ model, actions }: { model: AutomationViewModel; actions?: AutomationActions }) {
  const t = useT('admin-automation')
  const r = useT('rules')
  const [ownHelp, setOwnHelp] = useState(model.help)
  useEffect(() => setOwnHelp(model.help), [model.help])
  const help = actions?.onHelp ? model.help : ownHelp
  const setHelp = (open: boolean) => (actions?.onHelp ? actions.onHelp(open) : setOwnHelp(open))
  const held = newHeld(model)
  const heldText = held ? t(held) : null

  // c opens New rule, 1–5 switch the list (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (model.ruleDialog !== null || help || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .ag-cell-inline-editing')) return
      if (event.key === 'c' && held === null) {
        event.preventDefault()
        actions?.onRule?.('new')
        return
      }
      const view = viewOfKey(event.key)
      if (view) {
        event.preventDefault()
        actions?.onView?.(view)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (model.access === 'refused') {
    return (
      <div className="fw-automation">
        <EmptyState icon={<Workflow size={24} aria-hidden />} title={t('refused.title')} description={t('refused.body')} />
      </div>
    )
  }

  const asOf = model.rules.status === 'ready' ? model.rules.data.asOf : null
  return (
    <div className="fw-automation">
      <div className="fw-automation-band" role="group" aria-label={t('band.label')}>
        <div className="fw-automation-status">
          {asOf ? <AsOf at={asOf} now={model.now} /> : <span className="fw-automation-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </div>
        <div className="fw-automation-actions">
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'runs', label: t('band.runLog'), disabled: true, description: t('later.W3') },
              { id: 'ai-off', label: t('band.aiOff'), disabled: true, description: t('later.W3') },
              { id: 'keys', label: t('band.keys'), onSelect: () => setHelp(true) },
            ]}
          />
          <Button variant="primary" heldReason={heldText} onClick={() => actions?.onRule?.('new')} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('band.new')}
          </Button>
        </div>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.key.startsWith('rules:') ? r(model.notice.key.slice(6), model.notice.params) : t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <section className="fw-automation-section" aria-label={t('views.label')}>
        <div className="fw-automation-views">
          <SegmentedControl
            ariaLabel={t('views.label')}
            size="sm"
            wrap
            value={model.view}
            onChange={(value) => BUILT.has(value as View) && actions?.onView?.(value as View)}
            options={VIEWS.map((view) => ({
              value: view,
              label: t(`views.${view}`),
              disabled: !BUILT.has(view),
              title: BUILT.has(view) ? undefined : t(`later.${LATER[view as Exclude<View, 'timers'>]}`),
            }))}
          />
          <InfoTip tip={t('views.later')} />
        </div>
        <p className="fw-automation-muted">{t('views.later')}</p>
      </section>

      <section className="fw-automation-section" aria-labelledby="fw-automation-timers">
        <h2 id="fw-automation-timers" className="fw-automation-h">
          {t('timers.title')}
        </h2>
        <p className="fw-automation-muted">{t('timers.body')}</p>
        <RulesList
          rules={model.rules}
          only={isDateRule}
          words={{ label: t('timers.label'), title: t('timers.title'), empty: t('timers.empty'), emptyBody: t('timers.emptyBody') }}
          listKey="admin.automation"
          ruleHref={(rule) => `${model.prefix}/admin/automation?rule=${encodeURIComponent(rule.id)}`}
          offline={model.live === 'offline'}
          busy={model.busy}
          saving={model.savingRules}
          timers
          addButton={false}
          onOpen={(rule) => actions?.onRule?.(rule.id)}
          onNew={model.manage ? () => actions?.onRule?.('new') : undefined}
          onSwitch={actions?.onSwitch}
          onNumber={actions?.onNumber}
          onRetry={actions?.onRetry}
        />
      </section>

      <section className="fw-automation-section" aria-labelledby="fw-automation-modules">
        <h2 id="fw-automation-modules" className="fw-automation-h">
          {t('module.title')}
        </h2>
        <Card padded>
          <ul className="fw-automation-modules">
            {model.moduleTimers.map((kind) => (
              <li key={kind}>
                <b>{t(`${moduleTimerKey(kind, KNOWN_MODULE_TIMERS)}.title`)}</b>
                <span className="fw-automation-muted">{t(`${moduleTimerKey(kind, KNOWN_MODULE_TIMERS)}.body`)}</span>
              </li>
            ))}
            {model.moduleTimers.length === 0 && <li className="fw-automation-muted">{t('module.none')}</li>}
          </ul>
        </Card>
      </section>

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keysTitle')} size="sm">
          <ul className="fw-automation-keys">
            <li>
              <b>c</b> — {t('keys.new')}
            </li>
            <li>
              <b>1 – 5</b> — {t('keys.views')}
            </li>
            <li>
              <b>⌘S</b> — {t('keys.save')}
            </li>
            <li>
              <b>Esc</b> — {t('keys.close')}
            </li>
          </ul>
        </Modal>
      )}

      {model.ruleDialog && (
        <RuleDialog
          key={`${model.ruleDialog.mode}:${model.ruleDialog.rule?.id ?? 'new'}:${model.ruleDialog.rule?.version ?? 0}`}
          state={model.ruleDialog}
          rules={model.rules.status === 'ready' ? model.rules.data.rules : []}
          offline={model.live === 'offline'}
          busy={model.busy}
          prefix={model.prefix}
          onSave={actions?.onSave}
          onTest={actions?.onTest}
          onRetryChoices={actions?.onRetryChoices}
          onRetryTimers={actions?.onRetryTimers}
          onClose={() => actions?.onRule?.(null)}
        />
      )}
    </div>
  )
}
