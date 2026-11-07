'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { FileX, MoreHorizontal, Plus, ShieldOff, ShieldPlus } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { AsOf, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../../record-panels/i18n'
import { isListKey } from '../../../../../list-frame/model'
import { dvrHref, newVersionHeld, planPrintHref, RECORD_TABS, roleSheetsHref, versionNo, type RecordTab } from '../../model'
import type { RiskRecordActions, RiskRecordModel } from '../../view-model'
import '../../risk.css'
import { MeasureDialog, MoveDialog } from '../../view/MeasureParts'
import { InForcePill, KeysModal, RISK_NAMESPACES, StepUpDialog, useDay, useWords } from '../../view/parts'
import { NewSheetDialog } from '../../view/SheetCard'
import { VersionDialog } from '../../view/VersionDialog'
import { PlanTab } from './PlanTab'
import { EditAssessmentDialog, SignDialog, WithdrawDialog } from './RecordDialogs'
import { RolesTab } from './RolesTab'
import { VersionsTab } from './VersionsTab'

export type { RiskRecordActions, RiskRecordModel } from '../../view-model'

/**
 * SCR-209-record — one Risk assessment (design plant.risk rec "Risk assessment", the new tab "⌘-click a site"): the band
 * (‹ Risk assessment, the assessment's name, the version in force with its certain date, a version waiting, the next review;
 * Add measure `c`, New DVR version; ⋯ the frozen PDF, the plan and the role sheets to print, the assessment's facts, the
 * keys) and its tabs in the band (Owner answer L1): Role sheets, Improvement plan, Versions. Hazards (structured hazards, the
 * risk matrix) stay Later and are not drawn. One view model, nothing fetched.
 */
export function RecordView({ model, actions }: { model: RiskRecordModel; actions?: RiskRecordActions }) {
  return (
    <WithMessages namespaces={RISK_NAMESPACES}>
      <Record model={model} actions={actions} />
    </WithMessages>
  )
}

function Record({ model, actions }: { model: RiskRecordModel; actions?: RiskRecordActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const { address } = model
  const record = model.record.status === 'ready' ? model.record.value : null
  const dialogOpen = !!address.add || !!address.sign || !!address.withdraw || !!model.move || !!model.measure || keysOpen || (address.mode === 'edit' && !!address.sheet)
  const measureHeld = !record ? t('common.reading') : record.may.manage ? null : t('held.manage')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'c' && !measureHeld) {
        event.preventDefault()
        actions?.onAddress?.({ add: 'measure' })
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const back = <Link href={`${model.prefix}/plant/risk`}>{t('record.back')}</Link>
  if (!model.can.view || model.record.status !== 'ready') {
    const status = model.record.status
    const problem = status === 'error' ? model.record.problem : null
    const forbidden = !model.can.view || problem === 'problem.forbidden'
    return (
      <div className="fw-rk">
        <div className="fw-rk-record-band">
          <DetailHeader backAsChild backLabel={back} title={status === 'loading' && model.can.view ? <Skeleton width={260} height={22} /> : t('record.noun')} />
        </div>
        <Card padded aria-busy={status === 'loading'}>
          {status === 'loading' && model.can.view ? (
            <p className="fw-rk-muted" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
          ) : (
            <EmptyState
              icon={forbidden ? <ShieldOff size={22} aria-hidden /> : <FileX size={22} aria-hidden />}
              title={forbidden ? t('access.title') : problem === 'problem.notFound' ? t('record.notFound') : t('record.failed')}
              description={forbidden ? t('access.body') : problem === 'problem.notFound' ? t('record.notFoundBody') : t(problem ?? 'problem.read')}
              action={
                forbidden || problem === 'problem.notFound' ? (
                  <Button size="sm" asChild>
                    <Link href={`${model.prefix}/plant/risk`}>{t('record.back')}</Link>
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                )
              }
            />
          )}
        </Card>
      </div>
    )
  }

  const value = model.record.value
  const a = value.assessment
  const versionHeld = newVersionHeld(value)
  const inForce = value.versions.find((version) => version.inForce) ?? null
  const waiting = value.versions.find((version) => version.status === 'AWAITING_SIGNATURES') ?? null
  const tabs = RECORD_TABS.map((id) => ({ id, label: t(`tab.${id}`), count: id === 'plan' ? value.plan.open : id === 'versions' ? value.versions.length : id === 'roles' ? a.roles : null }))
  const sheetIds = model.sheets.status === 'ready' ? model.sheets.value.roleSheets.map((row) => row.id) : []

  return (
    <div className="fw-rk">
      <div className="fw-rk-record-band">
        <DetailHeader
          backAsChild
          backLabel={back}
          title={a.name}
          actions={
            <span className="fw-rk-actions">
              <Button size="sm" aria-keyshortcuts="c" heldReason={measureHeld} onClick={() => actions?.onAddress?.({ add: 'measure' })}>
                <Plus size={14} aria-hidden /> {t('band.addMeasure')}
              </Button>
              <Button size="sm" variant="primary" heldReason={versionHeld ? t(versionHeld) : null} onClick={() => actions?.onAddress?.({ add: 'version' })}>
                <ShieldPlus size={14} aria-hidden /> {t('band.newVersion')}
              </Button>
              <Menu
                label={<MoreHorizontal size={16} aria-hidden />}
                align="right"
                triggerProps={{ 'aria-label': t('band.more') }}
                items={[
                  { id: 'pdf', label: t('record.openInForce'), description: inForce ? versionNo(inForce) : t('version.noneSigned'), disabled: !inForce, onSelect: () => inForce && window.open(dvrHref(model.prefix, a.id, inForce.id), '_blank', 'noopener') },
                  { id: 'plan', label: t('band.printPlan'), description: t('band.printPlanHint'), onSelect: () => window.open(planPrintHref(model.prefix, { assessments: [a.id] }), '_blank', 'noopener') },
                  { id: 'sheets', label: t('band.printSheets'), description: t('band.printSheetsHint'), disabled: sheetIds.length === 0, onSelect: () => window.open(roleSheetsHref(model.prefix, sheetIds), '_blank', 'noopener') },
                  { id: 'edit', label: t('editAssessment.title'), description: value.may.manage ? t('editAssessment.hint') : t('held.manage'), disabled: !value.may.manage, onSelect: () => actions?.onAddress?.({ add: 'edit' }) },
                  { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
                ]}
              />
            </span>
          }
        />
        <div className="fw-rk-meta">
          <span className="fw-rk-row">
            <span className="fw-rk-muted">{a.site.name}</span>
            <InForcePill version={inForce} />
            {waiting && <Pill tone="warning">{t('version.waitingPill', { version: versionNo(waiting), count: waiting.missing.length })}</Pill>}
            <span className="fw-rk-row">
              <span className="fw-rk-muted">{t('review.label')}</span>
              <DueCell value={a.nextReviewOn} today={model.today} formatDate={(iso) => day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('due.on', { date: text }), none: t('review.none') }} />
            </span>
          </span>
          <span className="fw-rk-status" role="status">
            {model.readAt ? <AsOf at={model.readAt} /> : null}
          </span>
        </div>
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={address.tab} onChange={(id) => actions?.onAddress?.({ tab: id as RecordTab, sheet: null, measure: null })} size="sm" overflow="scroll" />
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.close')}
            </Button>
          }
        />
      )}
      {a.note && <p className="fw-rk-muted">{a.note}</p>}

      <div role="tabpanel" aria-label={t(`tab.${address.tab}`)}>
        {address.tab === 'versions' && <VersionsTab model={model} record={value} actions={actions} />}
        {address.tab === 'plan' && <PlanTab model={model} record={value} actions={actions} onHelp={() => setKeysOpen(true)} />}
        {address.tab === 'roles' && <RolesTab model={model} record={value} actions={actions} />}
      </div>

      {model.measure && <MeasureDialog frame={model} state={model.measure} assessments={[a]} actions={actions} />}
      {model.move && <MoveDialog state={model.move} actions={actions} />}
      {model.version && <VersionDialog frame={model} state={model.version} assessments={[a]} fixed actions={actions} />}
      {model.sign && <SignDialog model={model} record={value} state={model.sign} actions={actions} />}
      {model.withdraw && <WithdrawDialog record={value} state={model.withdraw} actions={actions} />}
      {model.edit && <EditAssessmentDialog model={model} record={value} state={model.edit} actions={actions} />}
      {model.newSheet && <NewSheetDialog frame={model} state={model.newSheet} sites={[{ id: a.siteId, name: a.site.name }]} actions={actions} />}
      {model.stepUp && <StepUpDialog state={model.stepUp} onSubmit={actions?.onStepUpSubmit} onCancel={actions?.onStepUpCancel} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
