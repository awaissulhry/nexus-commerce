'use client'

import { MoreHorizontal } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { NoAccess, NoticeBanner, RecordFrame, RecordProblem, RecordSkeleton } from '../../../_shared/parts'
import type { StepUpState } from '../../../_shared/hooks'
import type { LiveState, Notice, Read } from '../../../_shared/model'
import type { PlanRecord, ProfilesAnswer, VersionRecord } from '../../api'
import {
  appliesChanges,
  approveHeld,
  bandPrimary,
  editHeld,
  printHref,
  recordQuery,
  retireHeld,
  submitHeld,
  versionChanges,
  type AppliesDraft,
  type PlansCan,
  type RecordAddress,
  type RecordTab,
  type VersionDraft,
} from '../../model'
import { PlansMessages, PlansStepUp, PlanStatePill, useSay, type ChipSearch } from '../../view/parts'
import { AppliesTab, type AppliesActions } from './AppliesTab'
import { ApproveDialog, RetireDialog, type DialogActions } from './dialogs'
import { ChecksTab, type ChecksActions } from './ChecksTab'
import { SamplingTab, type SamplingActions } from './SamplingTab'
import { VersionsTab, type VersionsActions } from './VersionsTab'

export interface PlanRecordModel {
  readonly prefix: string
  /** The person looking (the author may not approve). */
  readonly me: string
  readonly can: PlansCan
  readonly address: RecordAddress
  readonly record: Read<PlanRecord>
  /** The builder's draft of the version shown (Checks + Sampling: ONE save). */
  readonly draft: VersionDraft | null
  readonly applies: AppliesDraft | null
  /** Show every problem (after a try to save), and the fields the API refused. */
  readonly shown: boolean
  readonly refused: readonly string[]
  /** The row of the check open for editing. */
  readonly openCheck: string | null
  readonly profiles: Read<ProfilesAnswer> | null
  readonly exampleLot: number
  readonly version: Read<VersionRecord> | null
  readonly approve: { readonly problem: string | null } | null
  readonly retire: { readonly versionId: string; readonly number: number; readonly status: 'DRAFT' | 'APPROVED'; readonly reason: string; readonly shown: boolean; readonly problem: string | null } | null
  readonly chipSearch: ChipSearch | null
  readonly busy: 'save' | 'applies' | 'submit' | 'approve' | 'retire' | 'newVersion' | 'owner' | null
  readonly notice: Notice | null
  readonly stepUp: StepUpState
  readonly live: LiveState
  readonly savedAt: string | null
  /** The plan changed on another screen while this one holds unsaved changes. */
  readonly changedElsewhere: boolean
}

export interface PlanRecordActions extends ChecksActions, SamplingActions, AppliesActions, VersionsActions, DialogActions {
  onSubmit?: () => void
  onNewVersion?: () => void
  onOwner?: (ownerId: string | null) => void
  onReload?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
}

const TABS: readonly RecordTab[] = ['checks', 'sampling', 'applies', 'versions']

/**
 * SCR-077-plan — an inspection plan's record in Builder page mode (design quality.plans rec "Inspection plan"; QHS-008,
 * QHS-009, QHS-016): the band (code and name, stage, owner, the version, its state, the one next step — Submit for
 * approval, Approve version N, or Start version N+1 — and ⋯ Print checklist, Retire, Copy), then the tabs Checks and
 * Sampling (one draft, one save: the builder's PUT), Applies to (the plan's own save) and Versions (read-only, compared).
 * Fetches nothing.
 */
export function PlanRecordView({ model, actions }: { model: PlanRecordModel; actions?: PlanRecordActions }) {
  return (
    <PlansMessages>
      <Record model={model} actions={actions} />
    </PlansMessages>
  )
}

function Record({ model, actions }: { model: PlanRecordModel; actions?: PlanRecordActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const locale = useLocale()
  const back = { href: `${model.prefix}/quality/plans`, label: t('record.back') }
  if (!model.can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.plans')} />
  if (model.record.problem)
    return (
      <RecordProblem
        problem={model.record.problem === 'problem.notFound' || model.record.problem === 'problem.forbidden' ? model.record.problem : 'problem.unavailable'}
        back={
          <Button size="sm" asChild>
            <a href={back.href}>{back.label}</a>
          </Button>
        }
        onRetry={() => actions?.onRetry?.()}
      />
    )
  const record = model.record.value
  if (!record) return <RecordSkeleton />
  const plan = record.plan
  const current = record.current
  const offline = model.live === 'offline'
  const versionCount = model.draft ? versionChanges(current, model.draft) : 0
  const appliesCount = model.applies ? appliesChanges(plan, model.applies) : 0
  const primary = bandPrimary(record, model.me, model.can)
  const held = editHeld(record, model.can, offline)
  const approveWhy = approveHeld(record, model.me, model.can, offline)
  const submitWhy = submitHeld(record, model.can, versionCount > 0, offline)
  const draft = current.status === 'DRAFT' ? current : null
  const tabHref = (tab: string) => `${model.prefix}/quality/plans/${encodeURIComponent(plan.id)}${recordQuery({ ...model.address, tab: tab as RecordTab, approve: false, version: tab === 'versions' ? model.address.version : null })}`
  const unsaved = versionCount + appliesCount
  const status = (
    <span className="fw-qp-band-status">
      <PlanStatePill row={plan} />
      <span className="fw-qp-muted" role="status">
        {model.busy === 'save' || model.busy === 'applies' ? t('record.saving') : unsaved > 0 ? t('record.unsaved', { count: unsaved }) : model.savedAt ? t('record.savedAt', { time: formatTime(model.savedAt, { locale }) }) : ''}
      </span>
    </span>
  )
  const retireTarget = draft ?? (current.status === 'APPROVED' ? current : null)
  const retireWhy = retireTarget ? say(retireHeld(record, retireTarget.status, model.can)) || null : t('retire.nothing')
  const nextNumber = plan.latestNumber + 1
  const more: MenuItemDef[] = [
    { id: 'print', label: t('record.print'), href: printHref(model.prefix, { plans: [plan.id], version: current.id }), target: '_blank' },
    {
      id: 'newVersion',
      label: t('record.newVersion', { number: nextNumber }),
      disabled: !!draft || !model.can.manage || offline,
      description: draft ? t('record.draftExists', { number: draft.number }) : !model.can.manage ? t('held.noManage') : offline ? t('held.offline') : undefined,
      onSelect: () => actions?.onNewVersion?.(),
    },
    {
      id: 'retire',
      label: retireTarget ? t('record.retire', { number: retireTarget.number }) : t('record.retireNone'),
      disabled: !!retireWhy,
      description: retireWhy ?? undefined,
      onSelect: () => retireTarget && actions?.onRetireOpen?.(retireTarget.id, retireTarget.number, retireTarget.status as 'DRAFT' | 'APPROVED'),
    },
    { id: 'copy', label: t('record.copy'), href: `${model.prefix}/quality/plans?copy=${encodeURIComponent(current.id)}`, disabled: !model.can.manage, description: !model.can.manage ? t('held.noManage') : undefined },
    { id: 'sep', separator: true },
    plan.owner?.id === model.me
      ? { id: 'owner', label: t('record.ownerClear'), disabled: !model.can.manage || offline, onSelect: () => actions?.onOwner?.(null) }
      : { id: 'owner', label: t('record.ownerMe'), disabled: !model.can.manage || offline, description: !model.can.manage ? t('held.noManage') : undefined, onSelect: () => actions?.onOwner?.(model.me) },
  ]
  const primaryButton =
    primary === 'approve' ? (
      <Button variant="primary" size="sm" heldReason={approveWhy && approveWhy.key !== 'approve.notReady' && approveWhy.key !== 'held.offline' ? null : say(approveWhy) || null} onClick={() => actions?.onApproveOpen?.()}>
        {t('record.approve', { number: draft?.number ?? 0 })}
      </Button>
    ) : primary === 'submit' ? (
      <Button variant="primary" size="sm" disabled={model.busy === 'submit'} heldReason={say(submitWhy) || null} onClick={() => actions?.onSubmit?.()}>
        {draft?.submitted ? t('record.submitted') : t('record.submit')}
      </Button>
    ) : primary === 'newVersion' ? (
      <Button variant="primary" size="sm" disabled={model.busy === 'newVersion'} heldReason={offline ? t('held.offline') : null} onClick={() => actions?.onNewVersion?.()}>
        {t('record.newVersion', { number: nextNumber })}
      </Button>
    ) : null
  const meta = (
    <span className="fw-qp-meta">
      <span>{t(`stage.${plan.stage}`)}</span>
      <span>{plan.owner ? t('record.owner', { name: plan.owner.name }) : t('record.noOwner')}</span>
      <span>{t('record.showing', { number: current.number, status: t(`status.${current.status}`) })}</span>
    </span>
  )
  return (
    <div className="fw-q fw-qp">
      <RecordFrame
        back={back}
        title={`${plan.code} · ${plan.name}`}
        meta={meta}
        status={status}
        actions={
          <>
            {primaryButton}
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={more} />
          </>
        }
        tabs={TABS.map((tab) => ({
          id: tab,
          label: t(`recordTab.${tab}`),
          count: tab === 'checks' ? (model.draft?.checks.length ?? current.checks.length) : tab === 'applies' ? (model.applies?.chips.length ?? plan.appliesTo.length) : tab === 'versions' ? record.versions.length : null,
        }))}
        active={model.address.tab}
        tabHref={tabHref}
      >
        <NoticeBanner notice={model.notice} namespace="quality-plans" onDismiss={() => actions?.onDismissNotice?.()} />
        {model.changedElsewhere && (
          <Banner
            tone="warning"
            title={t('live.planChanged')}
            action={
              <Button size="sm" onClick={() => actions?.onReload?.()}>
                {t('live.reload')}
              </Button>
            }
          />
        )}
        {offline && <Banner tone="warning" title={t('held.offlineBanner')} />}
        {draft?.submitted && (
          <Banner tone="info" title={t('record.waiting', { number: draft.number, who: draft.submitted.by?.name ?? '—', when: formatDateTime(draft.submitted.at, { locale }) })}>
            {draft.submitted.note}
          </Banner>
        )}
        {held && model.address.tab !== 'versions' && (model.address.tab !== 'applies' || held.key === 'held.noManage') && (
          <Banner
            tone="info"
            title={say(held)}
            action={
              current.status === 'APPROVED' && model.can.manage ? (
                <Button size="sm" onClick={() => actions?.onNewVersion?.()}>
                  {t('record.newVersion', { number: nextNumber })}
                </Button>
              ) : undefined
            }
          />
        )}
        {model.address.tab === 'checks' && <ChecksTab model={model} record={record} editable={!held} count={versionCount} actions={actions} />}
        {model.address.tab === 'sampling' && <SamplingTab model={model} record={record} editable={!held} count={versionCount} actions={actions} />}
        {model.address.tab === 'applies' && <AppliesTab model={model} record={record} count={appliesCount} actions={actions} />}
        {model.address.tab === 'versions' && <VersionsTab model={model} record={record} actions={actions} />}
      </RecordFrame>
      {model.approve && <ApproveDialog model={model} record={record} actions={actions} />}
      {model.retire && <RetireDialog model={model} actions={actions} />}
      <PlansStepUp state={model.stepUp} onSubmit={(code) => actions?.onStepUp?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />
    </div>
  )
}
