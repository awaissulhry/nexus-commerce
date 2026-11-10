'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Check, PencilLine, X } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Timeline } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { decimalText, minutesText } from '../../../styles/model'
import type { OperationMinutesView, TimeVersionView } from '../api'
import { decideHeld, pendingOf, typedSmvHeld, versionState, type MinutesActions, type MinutesModel, type Place } from '../model'
import { DecideDialog } from './DecideDialog'
import { ImpactCard } from './ImpactCard'
import { ProposeDialog } from './ProposeDialog'
import '../depth.css'

/**
 * Operation › Minutes, the W2b parts (B-W2b-235 on B-W2b-215's API; design products.operations rec:Operation tab
 * operation.minutes: "Basic time + personal, fatigue and delay allowances", "SMV versions with effective dates and
 * approver", PRD-111/113): the SMV in force today and how it is built, whether a change needs a second person, the waiting
 * proposal with Approve / Reject (never for the one who proposed it), Propose SMV change, the versions newest first, what an
 * SMV change reaches (routings and piece rates) and the links to People › Piece rates and Changes & versions. W1's typed SMV
 * (`typed`) shows only while the operation is not governed, not built from allowances and no proposal waits; else it says
 * why. It fetches nothing.
 */
export function MinutesSection({ model, actions, typed, routings }: { model: MinutesModel; actions?: MinutesActions; typed?: ReactNode; routings?: ReactNode }) {
  return (
    <WithMessages namespaces={['products-operations-depth']}>
      <Body model={model} actions={actions} typed={typed} routings={routings} />
    </WithMessages>
  )
}

function Body({ model, actions, typed, routings }: { model: MinutesModel; actions?: MinutesActions; typed?: ReactNode; routings?: ReactNode }) {
  const t = useT('products-operations-depth')
  const tl = useT('library')
  const part = model.part
  if (part.status === 'error')
    return (
      <div className="fw-opd-stack-lg">
        <Banner tone="danger" title={t('minutes.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{tl('common.retry')}</Button>}>
          {tl(part.problem)}
        </Banner>
        {routings}
      </div>
    )
  if (part.status !== 'ready')
    return (
      <Card header={t('minutes.title')} aria-busy="true">
        <p className="fw-opd-hint" role="status">
          <Spinner size={14} /> {t('minutes.loading')}
        </p>
        <div className="fw-opd-stack">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  return <Ready view={part.value} model={model} actions={actions} typed={typed} routings={routings} />
}

function Ready({ view, model, actions, typed, routings }: { view: OperationMinutesView; model: MinutesModel; actions?: MinutesActions; typed?: ReactNode; routings?: ReactNode }) {
  const t = useT('products-operations-depth')
  const tl = useT('library')
  const locale = useLocale()
  const min = (value: string | null) => (value === null ? '—' : t('min', { minutes: minutesText(value, locale) }))
  const pct = (value: string | null) => (value === null ? '—' : t('pct', { value: decimalText(value, locale, 4) }))
  const day = (value: string | null) => (value ? formatDate(value, { locale }) : '—')
  const pending = pendingOf(view)
  const typedHeld = typedSmvHeld(view)
  const proposeHeld = !view.may.propose ? t('propose.held.noRight') : view.operation.status === 'ARCHIVED' ? t('propose.held.archived') : model.offline ? t('offline.held') : model.busy ? t('held.busy') : null
  const current = view.current
  const built = current.basicMinutes !== null
  const notice = model.notice

  return (
    <div className="fw-opd-stack-lg">
      {notice && (
        <Banner
          tone={notice.tone}
          title={notice.key.startsWith('problem.') ? tl(notice.key, notice.params) : t(notice.key, { ...notice.params, ...(notice.params?.day ? { day: day(String(notice.params.day)) } : {}) })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {tl('common.dismiss')}
            </Button>
          }
        />
      )}
      {pending && <PendingBanner view={view} pending={pending} model={model} actions={actions} />}

      <div className="fw-opd-pair">
        <Card
          header={t('minutes.title')}
          description={view.governed ? t('minutes.governed') : t('minutes.notGoverned')}
          headerAction={
            <Button size="sm" variant="primary" heldReason={proposeHeld} onClick={() => actions?.onDialog?.({ kind: 'propose' })}>
              <PencilLine size={13} aria-hidden /> {t('propose.open')}
            </Button>
          }
        >
          <div className="fw-opd-stack">
            <div className="fw-opd-sum" aria-label={t('minutes.inForceLabel')}>
              <span className="fw-opd-big">{min(view.inForce.standardMinutes)}</span>
              <span className="fw-opd-hint">
                {view.inForce.number !== null ? t('minutes.inForceVersion', { number: view.inForce.number, day: day(view.inForce.effectiveFrom) }) : t('minutes.inForceOwn')}
              </span>
              {view.governed && <Tag tone="info">{t('minutes.governedTag')}</Tag>}
            </div>
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('minutes.basic'), value: built ? min(current.basicMinutes) : t('minutes.noBasic') },
                { label: t('minutes.personal'), value: pct(current.personalPct) },
                { label: t('minutes.fatigue'), value: pct(current.fatiguePct) },
                { label: t('minutes.delay'), value: pct(current.delayPct) },
                { label: t('minutes.smv'), value: built ? t('minutes.formula', { basic: minutesText(current.basicMinutes!, locale), allowances: decimalText(String(Math.round((Number(current.personalPct) + Number(current.fatiguePct) + Number(current.delayPct)) * 10000) / 10000), locale, 4), smv: minutesText(current.standardMinutes, locale) }) : min(current.standardMinutes) },
              ]}
            />
            {!sameText(view.inForce.standardMinutes, current.standardMinutes) && <p className="fw-opd-hint fw-opd-warn">{t('minutes.notYetMoved', { minutes: minutesText(current.standardMinutes, locale) })}</p>}
            {typedHeld === null ? typed : <p className="fw-opd-hint">{t(typedHeld)}</p>}
            <p className="fw-opd-hint">{t('minutes.suggestedLater')}</p>
          </div>
        </Card>
        <Card header={t('versions.title', { count: view.versions.length })} description={t('versions.intro')}>
          {view.versions.length === 0 ? (
            <EmptyState title={t('versions.empty.title')} description={t('versions.empty.body')} />
          ) : (
            <Timeline
              label={t('versions.title', { count: view.versions.length })}
              steps={view.versions.map((version) => {
                const state = versionState(version)
                const held = decideHeld(version, view, model.userId)
                return {
                  key: version.id,
                  tone: state.tone,
                  label: (
                    <span className="fw-opd-inline">
                      <b>{t('versions.label', { number: version.number, minutes: minutesText(version.standardMinutes, locale) })}</b>
                      <Tag tone={state.tone}>{t(state.key)}</Tag>
                    </span>
                  ),
                  at: version.decidedAt ?? version.proposedAt,
                  detail: <VersionDetail version={version} />,
                  action:
                    version.status === 'PROPOSED' && held === null ? (
                      <span className="fw-opd-inline">
                        <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'approve', versionId: version.id })}>
                          <Check size={13} aria-hidden /> {t('decide.approve')}
                        </Button>
                        <Button size="sm" variant="quiet" onClick={() => actions?.onDialog?.({ kind: 'reject', versionId: version.id })}>
                          <X size={13} aria-hidden /> {t('decide.reject')}
                        </Button>
                      </span>
                    ) : undefined,
                }
              })}
            />
          )}
        </Card>
      </div>

      <div className="fw-opd-pair">
        <ImpactCard view={view} />
        <div className="fw-opd-stack-lg">
          <ConnectionsCard connections={model.connections} view={view} />
          {routings}
        </div>
      </div>

      {model.dialog?.kind === 'propose' && <ProposeDialog view={view} model={model} actions={actions} />}
      {(model.dialog?.kind === 'approve' || model.dialog?.kind === 'reject') && (
        <DecideDialog view={view} version={view.versions.find((version) => version.id === (model.dialog as { versionId: string }).versionId) ?? null} decision={model.dialog.kind} model={model} actions={actions} />
      )}
    </div>
  )
}

const sameText = (a: string, b: string): boolean => Number(a) === Number(b)

function PendingBanner({ view, pending, model, actions }: { view: OperationMinutesView; pending: TimeVersionView; model: MinutesModel; actions?: MinutesActions }) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  const held = decideHeld(pending, view, model.userId)
  return (
    <Banner
      tone="warning"
      title={t('pending.title', { number: pending.number, from: minutesText(view.current.standardMinutes, locale), to: minutesText(pending.standardMinutes, locale), day: formatDate(pending.effectiveFrom, { locale }) })}
      action={
        held === null ? (
          <span className="fw-opd-inline">
            <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'approve', versionId: pending.id })}>
              {t('decide.approve')}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => actions?.onDialog?.({ kind: 'reject', versionId: pending.id })}>
              {t('decide.reject')}
            </Button>
          </span>
        ) : undefined
      }
    >
      <p className="fw-opd-hint">{t('pending.by', { name: pending.proposedBy.name })}</p>
      {held !== null && <p className="fw-opd-hint">{t(held)}</p>}
    </Banner>
  )
}

function VersionDetail({ version }: { version: TimeVersionView }) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  const day = (value: string) => formatDate(value, { locale })
  return (
    <span className="fw-opd-stack">
      <span>
        {t('versions.built', {
          basic: minutesText(version.basicMinutes, locale),
          personal: decimalText(version.personalPct, locale, 4),
          fatigue: decimalText(version.fatiguePct, locale, 4),
          delay: decimalText(version.delayPct, locale, 4),
        })}
        {' · '}
        {t(`source.${version.source}`)}
        {' · '}
        {t('versions.from', { day: day(version.effectiveFrom) })}
      </span>
      <span className="fw-opd-reason">{t('versions.reason', { reason: version.reason })}</span>
      <span>
        {t('versions.proposed', { name: version.proposedBy.name, day: day(version.proposedAt) })}
        {version.decidedBy && version.decidedAt ? ` · ${t(version.status === 'REJECTED' ? 'versions.rejectedBy' : 'versions.approvedBy', { name: version.decidedBy.name, day: day(version.decidedAt) })}` : ''}
      </span>
      {version.decisionNote && <span className="fw-opd-reason">{t('versions.note', { note: version.decisionNote })}</span>}
    </span>
  )
}

function ConnectionsCard({ connections, view }: { connections: { pieceRates: Place; changes: Place }; view: OperationMinutesView }) {
  const t = useT('products-operations-depth')
  const place = (where: Place, label: string, notBuilt: string, noRight: string) =>
    where.kind === 'page' ? (
      <Link className="fw-opd-link" href={where.href}>
        {label}
      </Link>
    ) : (
      <span className="fw-opd-hint">
        {label} — {where.kind === 'notBuilt' ? notBuilt : noRight}
      </span>
    )
  return (
    <Card header={t('conn.title')}>
      <div className="fw-opd-links">
        {place(connections.pieceRates, t('conn.pieceRates'), t('conn.notBuilt'), t('conn.pieceRatesNoRight'))}
        <span className="fw-opd-hint">{t('conn.pieceRatesWhy', { count: view.impact.pieceRates.count })}</span>
        {place(connections.changes, t('conn.changes'), t('conn.changesNotBuilt'), t('conn.notBuilt'))}
        <span className="fw-opd-hint">{t('conn.changesWhy')}</span>
      </div>
    </Card>
  )
}
