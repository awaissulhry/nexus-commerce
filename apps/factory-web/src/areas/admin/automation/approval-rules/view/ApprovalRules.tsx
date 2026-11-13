'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { Lock, Plus } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag, Toggle } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { ApprovalRule } from '../api'
import { NAMESPACE, newHeld, said, sortedRules, switchHeld, type ApprovalRulesModel } from '../model'
import { ApprovalRuleDialog, type ApprovalRuleDialogActions } from './ApprovalRuleDialog'
import '../approval-rules.css'

export interface ApprovalRulesActions extends ApprovalRuleDialogActions {
  /** Open a rule's pop-up (`?rule=<id>`, `?rule=new`), or close it (null). */
  onRule?: (id: string | null) => void
  onSwitch?: (rule: ApprovalRule, next: boolean) => void
  onRetry?: () => void
}

const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return event.key.length === 1 && event.key !== ' '
}

/**
 * Admin › Automation › Approval rules (B-W2b-307; design admin.automation sec:approval-rules, PLT-086, PLT-042): the locked
 * rule "Nobody approves their own request" first, then every rule as its sentence — area, approver, signature meaning,
 * fired in 30 days, on/off (Space or the switch; a new rule is written OFF) — in the shared list frame; a row opens the
 * rule pop-up. A money threshold the reader's grains do not show reads "…" and the rule is held for them. It fetches
 * nothing (use-approval-rules.ts).
 */
export function ApprovalRules({ model, actions }: { model: ApprovalRulesModel; actions?: ApprovalRulesActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'lists']}>
      <Rules model={model} actions={actions} />
    </WithMessages>
  )
}

function Rules({ model, actions }: { model: ApprovalRulesModel; actions?: ApprovalRulesActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const data = model.rules.status === 'ready' ? model.rules.data : null
  const kinds = model.kinds.status === 'ready' ? model.kinds.data.kinds : []
  const rows = useMemo(() => (data ? sortedRules(data.rules, kinds) : null), [data, kinds])
  const held = newHeld(model)

  const columns = useMemo<ColDef<ApprovalRule>[]>(() => {
    const heldOf = (rule: ApprovalRule) => {
      const key = switchHeld(rule, latest.current.model)
      return key ? t(key) : null
    }
    const SentenceCell = ({ data: rule }: ICellRendererParams<ApprovalRule>) =>
      rule ? (
        <span className="fw-apr-cell">
          <Link
            className="fw-apr-link"
            href={`${latest.current.model.prefix}/admin/automation?view=approvals&rule=${encodeURIComponent(rule.id)}`}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              latest.current.actions?.onRule?.(rule.id)
            }}
          >
            {said(rule.sentence, locale)}
          </Link>
          <span className="fw-apr-sub">
            {rule.name}
            {rule.companyName ? ` · ${rule.companyName}` : ` · ${t('rules.everyCompany')}`}
            {!rule.registered ? ` · ${t('rules.notRegistered')}` : ''}
            {rule.heldReason ? ` · ${t('rules.thresholdHeld')}` : ''}
          </span>
        </span>
      ) : null
    const SwitchCell = ({ data: rule }: ICellRendererParams<ApprovalRule>) => {
      if (!rule) return null
      const reason = heldOf(rule)
      return (
        <span className="fw-apr-switch">
          <Toggle size="xs" checked={rule.active} disabled={reason !== null} title={reason ?? undefined} aria-label={t('rules.switch', { rule: rule.name })} onChange={(next) => latest.current.actions?.onSwitch?.(rule, next)} />
          <Tag tone={rule.active ? 'success' : 'neutral'}>{t(rule.active ? 'rules.on' : 'rules.off')}</Tag>
          {latest.current.model.saving.includes(rule.id) && <span className="fw-apr-sub">{t('inbox.held.busy')}</span>}
        </span>
      )
    }
    return [
      { colId: 'sentence', headerName: t('rules.col.sentence'), flex: 3, minWidth: 300, valueGetter: (params) => (params.data ? said(params.data.sentence, locale) : ''), cellRenderer: SentenceCell },
      { colId: 'area', headerName: t('rules.col.area'), flex: 1, minWidth: 140, valueGetter: (params) => (params.data ? said(params.data.kindLabel, locale) : '') },
      { colId: 'approver', headerName: t('rules.col.approver'), flex: 1, minWidth: 150, valueGetter: (params) => (params.data ? `${params.data.approver.name}${params.data.approver.kind === 'PERSON' ? ` (${t('rules.named')})` : ''}` : '') },
      { colId: 'delegation', headerName: t('rules.col.delegation'), flex: 1, minWidth: 120, valueGetter: () => t('later.W3') },
      { colId: 'meaning', headerName: t('rules.col.meaning'), flex: 1, minWidth: 140, valueGetter: (params) => (params.data?.signatureMeaning ? `${t(`meaning.${params.data.signatureMeaning}`)}${params.data.requireStepUp ? ` · ${t('rules.withCode')}` : ''}` : '—') },
      { colId: 'fired', headerName: t('rules.col.fired'), flex: 0.8, minWidth: 110, type: 'rightAligned', valueGetter: (params) => params.data?.fired30Days ?? 0 },
      {
        colId: 'active',
        headerName: t('rules.col.active'),
        flex: 1,
        minWidth: 150,
        valueGetter: (params) => (params.data?.active ? t('rules.on') : t('rules.off')),
        cellRenderer: SwitchCell,
        suppressKeyboardEvent: (params: { event: KeyboardEvent; editing: boolean; data?: ApprovalRule }) => cellKeys(() => params.data && heldOf(params.data) === null && latest.current.actions?.onSwitch?.(params.data, !params.data.active))(params),
      },
    ]
  }, [t, locale])

  if (model.rules.status === 'error') {
    return <EmptyState title={t('rules.error')} description={t(model.rules.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
  }

  return (
    <div className="fw-apr">
      <div className="fw-apr-band">
        <p className="fw-apr-muted">{t('rules.body')}</p>
        <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onRule?.('new')} aria-keyshortcuts="c">
          <Plus size={14} aria-hidden /> {t('rules.new')}
        </Button>
      </div>
      {(data?.fixed ?? []).map((fixed) => (
        <Card key={fixed.code} padded>
          <div className="fw-apr-fixed">
            <Lock size={16} aria-hidden />
            <span className="fw-apr-cell">
              <b>{said(fixed.sentence, locale)}</b>
              <span className="fw-apr-sub">{t('rules.fixedBody')}</span>
            </span>
            <Tag tone="neutral">{t('rules.locked')}</Tag>
          </div>
        </Card>
      ))}
      {data && data.rules.every((rule) => !rule.active) && data.rules.length > 0 && <Banner tone="info" title={t('rules.allOff')} />}
      <ListFrame<ApprovalRule>
        label={t('rules.label')}
        title={t('rules.title')}
        rows={rows}
        rowId={(rule) => rule.id}
        columns={columns}
        count={rows ? t('rules.count', { count: rows.length }) : '—'}
        keys={[{ keys: ['c'], does: t('rules.new') }]}
        listKey="admin.automation.approvals"
        onOpen={(rule) => actions?.onRule?.(rule.id)}
        state={
          rows && rows.length === 0 ? (
            <EmptyState
              title={t('rules.empty')}
              description={t('rules.emptyBody')}
              action={
                held === null ? (
                  <Button size="sm" onClick={() => actions?.onRule?.('new')}>
                    <Plus size={13} aria-hidden /> {t('rules.new')}
                  </Button>
                ) : undefined
              }
            />
          ) : undefined
        }
      />
      {model.dialog && <ApprovalRuleDialog key={`${model.dialog.mode}:${model.dialog.rule?.id ?? 'new'}:${model.dialog.rule?.version ?? 0}:${model.dialog.kind ?? ''}`} model={model} actions={actions} onClose={() => actions?.onRule?.(null)} />}
    </div>
  )
}
