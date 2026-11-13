'use client'

import { useMemo, useRef, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Lock, Plus, ShieldCheck } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ApprovalRule } from '../api'
import { adminRuleHref, approvalStateOf, inboxHref, poFactsOf, poRulesOf } from '../model'
// B-W2b-382 (XF7:06): a new PO rule opens with its kind chosen.
import { newRuleHref } from '../../../admin/automation/approval-rules/new-kind/new-kind'
import type { PurchasingSettingsActions, PurchasingSettingsModel } from '../view-model'
import { CardDescription, CardFailed, NS } from './parts'

/**
 * sec:approval — PO approval (SCM-078; design purchasing.settings "Who approves which POs"): the PURCHASE_ORDER rules of the
 * one approval engine (B-W2b-282, B-W2b-305), SHOWN here and opened in Admin › Automation › Approval rules, where they are
 * written and switched (one editor, B-W2b-307). The locked rule first — nobody approves their own request, the Owner
 * included —, then whether any rule is on (none is until the Owner switches one on: said in words), the rules in the list
 * frame (each its sentence, company, approver, signature, time to decide, fired in 30 days, on or off, who changed it), what a
 * rule may check, and where the requests wait (Home › Approvals). No money: a threshold the reader's grains do not show
 * comes from the API as "…".
 */
export function ApprovalCard({ model, actions }: { model: PurchasingSettingsModel; actions?: PurchasingSettingsActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const answer = model.rules?.value ?? null
  const rules = useMemo(() => poRulesOf(answer, model.address.scope, model.companyId), [answer, model.address.scope, model.companyId])
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  const columns = useMemo<ColDef<ApprovalRule>[]>(() => {
    const open = (event: MouseEvent, id: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      latest.current.actions?.onOpenRule?.(id)
    }
    const RuleCell = ({ data }: ICellRendererParams<ApprovalRule>) => {
      if (!data) return null
      return (
        <span className="fw-pus-cell">
          <Link className="fw-pus-rowlink" href={adminRuleHref(latest.current.model.prefix, data.id)} onClick={(event) => open(event, data.id)}>
            <strong>{data.name}</strong>
          </Link>
          <span className="fw-pus-sub">{data.sentence[locale]}</span>
        </span>
      )
    }
    const ApproverCell = ({ data }: ICellRendererParams<ApprovalRule>) => {
      if (!data) return null
      return (
        <span className="fw-pus-cell">
          <span>{data.approver.name}</span>
          <span className="fw-pus-sub">{t(data.approver.kind === 'ROLE' ? 'approval.byRole' : 'approval.byPerson')}</span>
        </span>
      )
    }
    const SignCell = ({ data }: ICellRendererParams<ApprovalRule>) => {
      if (!data) return null
      if (!data.signatureMeaning) return <span className="fw-pus-sub">{t('approval.noSignature')}</span>
      return (
        <span className="fw-pus-cell">
          <span>{t(`meaning.${data.signatureMeaning}`)}</span>
          {data.requireStepUp && <span className="fw-pus-sub">{t('approval.withCode')}</span>}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<ApprovalRule>) => {
      if (!data) return null
      return <Pill tone={data.active ? 'success' : 'neutral'}>{t(data.active ? 'approval.on' : 'approval.off')}</Pill>
    }
    const ChangedCell = ({ data }: ICellRendererParams<ApprovalRule>) => {
      if (!data) return null
      const time = formatDateTime(data.updatedAt, { locale })
      return (
        <span className="fw-pus-cell">
          <span>{time}</span>
          {data.changedBy && <span className="fw-pus-sub">{data.changedBy.me ? t('approval.byYou') : data.changedBy.name}</span>}
        </span>
      )
    }
    return [
      { colId: 'rule', headerName: t('approval.col.rule'), minWidth: 240, flex: 2.6, valueGetter: (params) => params.data?.name ?? '', cellRenderer: RuleCell, autoHeight: true, wrapText: true },
      { colId: 'company', headerName: t('approval.col.company'), minWidth: 120, flex: 1, wrapText: true, autoHeight: true, valueGetter: (params) => (params.data ? (params.data.companyName ?? t('common.everyCompany')) : '') },
      { colId: 'approver', headerName: t('approval.col.approver'), minWidth: 150, flex: 1.1, valueGetter: (params) => params.data?.approver.name ?? '', cellRenderer: ApproverCell, autoHeight: true, wrapText: true },
      { colId: 'signature', headerName: t('approval.col.signature'), minWidth: 130, flex: 1, cellRenderer: SignCell, autoHeight: true, wrapText: true, sortable: false },
      { colId: 'due', headerName: t('approval.col.due'), minWidth: 120, flex: 0.8, wrapHeaderText: true, autoHeaderHeight: true, valueGetter: (params) => (params.data?.dueHours ? t('approval.hours', { count: params.data.dueHours }) : '—') },
      { colId: 'fired', headerName: t('approval.col.fired'), minWidth: 120, flex: 0.8, wrapHeaderText: true, autoHeaderHeight: true, type: 'rightAligned', valueGetter: (params) => params.data?.fired30Days ?? null },
      { colId: 'state', headerName: t('approval.col.state'), minWidth: 96, flex: 0.6, valueGetter: (params) => (params.data ? (params.data.active ? 1 : 0) : null), cellRenderer: StateCell },
      { colId: 'changed', headerName: t('approval.col.changed'), minWidth: 140, flex: 0.9, valueGetter: (params) => params.data?.updatedAt ?? '', cellRenderer: ChangedCell, autoHeight: true },
    ]
  }, [t, locale])

  const newHeld = !model.can.approvals ? t('held.noApprovalsView') : !model.can.rulesManage ? t('held.noRulesManage') : null
  const newButton = newHeld ? (
    <Button size="sm" variant="secondary" heldReason={newHeld}>
      <Plus size={14} aria-hidden /> {t('approval.add')}
    </Button>
  ) : (
    <Button size="sm" variant="secondary" asChild>
      <Link href={newRuleHref(model.prefix, 'PURCHASE_ORDER')}>
        <Plus size={14} aria-hidden /> {t('approval.add')}
      </Link>
    </Button>
  )

  const body = (): ReactNode => {
    if (!model.rules) {
      return (
        <div className="fw-pus-stack">
          <Locked text={t('approval.locked')} />
          <p className="fw-pus-held">{t('held.noApprovalsView')}</p>
        </div>
      )
    }
    if (model.rules.problem) return <CardFailed title={t('approval.failed')} problem={model.rules.problem} onRetry={actions?.onRetryRules} />
    if (!answer) return <Skeleton height={260} />
    const state = approvalStateOf(rules)
    const facts = poFactsOf(model.kinds?.value ?? null, locale)
    const fixed = answer.fixed.find((entry) => entry.code === 'NO_SELF_APPROVAL')
    return (
      <div className="fw-pus-stack">
        <Locked text={fixed ? fixed.sentence[locale] : t('approval.locked')} />
        <p className={state.state === 'ON' ? 'fw-pus-hint' : 'fw-pus-warn'} role="note">
          <ShieldCheck size={14} aria-hidden /> {t(`approval.state.${state.state}`, { count: state.state === 'ON' ? state.on : state.total, total: state.total })}
          {state.later > 0 && <> {t('approval.notYetInForce', { count: state.later })}</>}
        </p>
        <ListFrame<ApprovalRule>
          label={t('approval.table')}
          title={t('approval.title')}
          rows={rules}
          rowId={(rule) => rule.id}
          columns={columns}
          count={t('approval.count', { count: rules.length })}
          keys={[{ keys: ['↵'], does: t('keys.openRule') }]}
          onHelp={() => actions?.onKeys?.()}
          onOpen={(rule) => actions?.onOpenRule?.(rule.id)}
          listKey={null}
          state={
            rules.length === 0 ? (
              <EmptyState title={t('approval.empty.title')} description={t('approval.empty.body')} action={newButton} />
            ) : undefined
          }
        />
        <ul className="fw-pus-notes">
          {facts && facts.length > 0 && <li>{t('approval.facts', { facts: facts.join(', ') })}</li>}
          <li>{t('approval.firstDecides')}</li>
          <li>{t('approval.comesLater')}</li>
          <li>
            {t('approval.inbox')}{' '}
            <Link className="fw-pus-link" href={inboxHref(model.prefix)}>
              {t('approval.inboxLink')} <ExternalLink size={12} aria-hidden />
            </Link>
          </li>
        </ul>
      </div>
    )
  }

  return (
    <Card
      header={t('approval.title')}
      description={<CardDescription text={t('approval.description')} changed={answer ? model.changed.approval : undefined} href={null} />}
      headerAction={newButton}
      headingLevel={2}
      className="fw-pus-card"
    >
      {body()}
    </Card>
  )
}

/** The rule nobody switches off, first and with its lock. */
function Locked({ text }: { text: string }) {
  return (
    <p className="fw-pus-locked">
      <Lock size={14} aria-hidden /> <span>{text}</span>
    </p>
  )
}
