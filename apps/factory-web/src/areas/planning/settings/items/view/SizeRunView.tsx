'use client'

import { Ruler } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Pill, SegmentedControl, Skeleton, Spinner } from '@nexus/ui/primitives'
import type { SizeRunRule } from '@nexus/factory-domain/planning/planned-orders/rules'
import type { SizeRunValues } from '@nexus/factory-domain/planning/lot-sizing/size-run'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { ITEM_RULES_NAMESPACE, sizeRunPlan, type RuleWords } from '../model'
import { useRuleSay } from './RuleColumns'
import '../items.css'

export interface SizeRunModel {
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  values: SizeRunValues
  /** planning.settings.manage: the site's settings. */
  canManage: boolean
  dialog: { rule: SizeRunRule; text: string; busy: boolean; problem: RuleWords | null } | null
  notice: RuleWords | null
}

export interface SizeRunActions {
  onOpen?: () => void
  onRule?: (rule: SizeRunRule) => void
  onText?: (text: string) => void
  onSave?: () => void
  onClose?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * B-W2b-335 — the site's size-run rule on Item parameters (B-W2b-318's PLN-068 setting): what "Plan by: the site's rule"
 * means — one grid per colourway, or the site's size groups ("44-48 · 50-54") — and Change… (planning.settings.manage):
 * the rule and the groups, one group per line, checked with factory-domain's rules before it is sent.
 */
export function SizeRunView({ model, actions }: { model: SizeRunModel; actions?: SizeRunActions }) {
  return (
    <WithMessages namespaces={[ITEM_RULES_NAMESPACE]}>
      <SizeRunCard model={model} actions={actions} />
    </WithMessages>
  )
}

function SizeRunCard({ model, actions }: { model: SizeRunModel; actions?: SizeRunActions }) {
  const t = useT(ITEM_RULES_NAMESPACE)
  const say = useRuleSay()
  const groups = model.values.sizeRunRule === 'SIZE_GROUPS' ? model.values.sizeGroups : []
  return (
    <Card padded>
      <div className="fw-pir-run">
        <div className="fw-pir-run-text">
          <h2 className="fw-pir-run-title">
            <Ruler size={14} aria-hidden /> {t('items.sizeRun.title')}
          </h2>
          {model.load.status === 'loading' ? (
            <Skeleton width={260} height={18} />
          ) : model.load.status === 'error' ? (
            <span className="fw-pir-problem">{t(model.load.problem)}</span>
          ) : model.values.sizeRunRule === 'SIZE_GROUPS' ? (
            <span className="fw-pir-groups">
              <span className="fw-pir-hint">{t('items.sizeRun.groups', { count: groups.length })}</span>
              {groups.map((group) => (
                <Pill key={group.join('-')} tone="neutral">
                  {group.join(' · ')}
                </Pill>
              ))}
            </span>
          ) : (
            <span className="fw-pir-hint">{t('items.sizeRun.oneGrid')}</span>
          )}
          <span className="fw-pir-hint">{t('items.sizeRun.hint')}</span>
        </div>
        {model.load.status === 'error' ? (
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('retry')}
          </Button>
        ) : (
          <Button size="sm" heldReason={!model.canManage ? t('items.held.settings') : model.load.status !== 'ready' ? t('items.held.loading') : null} onClick={() => actions?.onOpen?.()}>
            {t('items.sizeRun.change')}
          </Button>
        )}
      </div>
      {model.notice && <Banner tone="success" title={say(model.notice)} onDismiss={actions?.onDismissNotice} />}
      {model.dialog && <SizeRunDialog model={model} actions={actions} />}
    </Card>
  )
}

function SizeRunDialog({ model, actions }: { model: SizeRunModel; actions?: SizeRunActions }) {
  const t = useT(ITEM_RULES_NAMESPACE)
  const say = useRuleSay()
  const dialog = model.dialog!
  const plan = sizeRunPlan(model.values, dialog.rule, dialog.text)
  const held = !model.canManage ? t('items.held.settings') : dialog.busy ? t('items.held.busy') : plan.kind === 'refused' ? say(plan.words) : plan.kind === 'none' ? t('items.held.same') : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('items.sizeRun.dialogTitle')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onSave?.()}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('items.sizeRun.save')}
          </Button>
        </>
      }
    >
      <div className="fw-pir-dialog">
        <SegmentedControl
          ariaLabel={t('items.sizeRun.rule')}
          wrap
          value={dialog.rule}
          options={[
            { value: 'ONE_GRID', label: t('items.sizeRun.ONE_GRID') },
            { value: 'SIZE_GROUPS', label: t('items.sizeRun.SIZE_GROUPS') },
          ]}
          onChange={(value) => actions?.onRule?.(value as SizeRunRule)}
        />
        <p className="fw-pir-hint">{t(`items.sizeRun.hint${dialog.rule}`)}</p>
        {dialog.rule === 'SIZE_GROUPS' && (
          <Field label={t('items.sizeRun.groupsField')} hint={t('items.sizeRun.groupsHint')} error={plan.kind === 'refused' ? say(plan.words) : undefined}>
            <Textarea value={dialog.text} rows={5} onChange={(event) => actions?.onText?.(event.target.value)} />
          </Field>
        )}
        {dialog.rule === 'ONE_GRID' && model.values.sizeGroups.length > 0 && <Banner tone="info">{t('items.sizeRun.clears')}</Banner>}
        {dialog.problem && <Banner tone="danger" title={say(dialog.problem)} />}
      </div>
    </Modal>
  )
}
