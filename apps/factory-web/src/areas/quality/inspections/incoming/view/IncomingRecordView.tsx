'use client'

import Link from 'next/link'
import { Hand } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { AqlSummary } from '../../../_shared/aql/AqlSummary'
import type { Notice, QualityCan } from '../../../_shared/model'
import { dash, Facts, NoticeBanner, RecordFrame, Section } from '../../../_shared/parts'
import type { StepUpState } from '../../../_shared/hooks'
import type { Incoming } from '../../depth/api'
import { decisionWords, labelIn, quantityWords, type DepthCan } from '../../depth/model'
import { ClassTag, DepthMessages, DepthStepUp, useDepthT, useSay } from '../../depth/parts'
import type { AmendmentsState } from '../../depth/use-amendments'
import { AmendmentsSection, type AmendmentsActions } from '../../depth/view/AmendmentsSection'
import { AqlResultTable } from '../../depth/view/AqlTab'

export const INCOMING_TABS = ['units', 'decision'] as const
export type IncomingTab = (typeof INCOMING_TABS)[number]

/** SCR-076-incoming — the incoming inspection record's view model (B-W2b-98's record; the list's incoming rows open it). */
export interface IncomingRecordModel {
  readonly prefix: string
  readonly tab: IncomingTab
  readonly read: Incoming
  readonly can: QualityCan
  readonly depth: DepthCan
  readonly amendments: AmendmentsState
  readonly notice?: Notice | null
}

export interface IncomingRecordActions extends AmendmentsActions {
  onPlaceHold?: () => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

const DECISION_TONE = { ACCEPTED: 'success', REJECTED: 'danger', TO_SORT: 'warning' } as const
const AREA_TONE = { WITHIN: 'success', SHORT: 'danger', OVER: 'info' } as const

/**
 * An incoming inspection (design quality.inspections: one list with Incoming, In-line, Final; B-W2b-98, B-W2b-111): the lot,
 * its material and supplier, the plan version, the sample (ISO 2859-1 from the profile, drawn by AqlSummary) with the result
 * per class; hide by hide — area measured against the tannery's, shade group, grade, the worst defect, the decision — and the
 * lot's area check; the plan's checks; Decision & signature — computed result, the split (accepted · rejected · to sort), the
 * next step in words (the lot moves only by the lab's release, never by this decision), Place hold on the rejected and to-sort
 * hides, the signature — and the Amendments after signing. Recorded on the floor's Incoming inspection; read here.
 */
export function IncomingRecordView({ model, actions, stepUp }: { model: IncomingRecordModel; actions?: IncomingRecordActions; stepUp?: StepUpState }) {
  return (
    <DepthMessages>
      <Record model={model} actions={actions} stepUp={stepUp} />
    </DepthMessages>
  )
}

function Record({ model, actions, stepUp }: { model: IncomingRecordModel; actions?: IncomingRecordActions; stepUp?: StepUpState }) {
  const td = useDepthT()
  const t = useT('quality')
  const say = useSay()
  const locale = useLocale()
  const { read } = model
  const inspection = read.inspection
  const base = `${model.prefix}/quality/inspections/incoming/${encodeURIComponent(inspection.id)}`
  const status = inspection.status === 'OPEN' ? { key: 'status.OPEN', tone: 'info' as const } : inspection.status === 'CANCELLED' ? { key: 'status.CANCELLED', tone: 'neutral' as const } : inspection.computedResult === 'FAIL' ? { key: 'status.DECIDED_FAIL', tone: 'danger' as const } : { key: 'status.DECIDED_PASS', tone: 'success' as const }
  const amended = model.amendments.read?.value?.record.amended ?? false
  const holdHides = read.next?.holdPrefill?.subjectIds.length ?? 0
  const holdHeld = !model.can.holdsPlace ? t('held.noHoldPlace') : holdHides === 0 ? td('incoming.held.noHides') : null
  const when = (iso: string | null) => (iso ? formatDateTime(iso, { locale }) : null)
  const inspector = read.inspector.hidden ? td('incoming.inspectorHidden') : read.inspector.name ?? td(read.inspector.kind === 'FLOOR' ? 'who.bench' : read.inspector.kind === 'OFFICE' ? 'who.office' : 'who.nobody')
  return (
    <RecordFrame
      back={{ href: `${model.prefix}/quality/inspections?kind=incoming`, label: t('record.back') }}
      title={td('incoming.title', { number: inspection.number })}
      meta={
        <span className="fw-q-cell-row">
          {read.lot && <span className="fw-q-code">{read.lot.code}</span>}
          {read.lot && <span className="fw-q-hint">· {read.lot.item.name}</span>}
          {read.lot?.supplier && <span className="fw-q-hint">· {read.lot.supplier.name}</span>}
          {read.receipt && <span className="fw-q-hint">· {td('incoming.workshopOf', { workOrder: read.receipt.workOrder.number, workshop: read.receipt.workshop?.name ?? '—' })}</span>}
        </span>
      }
      status={
        <span className="fw-q-tags">
          <Pill tone={status.tone} dot>
            {td(status.key)}
          </Pill>
          {amended && <Tag tone="info">{td('status.AMENDED')}</Tag>}
          {read.plan && <Tag tone="neutral">{td('plan.version', { code: read.plan.code, number: read.plan.number })}</Tag>}
        </span>
      }
      tabs={INCOMING_TABS.map((tab) => ({ id: tab, label: td(`incoming.tab.${tab}`) }))}
      active={model.tab}
      tabHref={(tab) => `${base}?tab=${tab}`}
    >
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {inspection.status === 'OPEN' && <Banner tone="info" title={td('incoming.openOnFloor')} />}
      {model.tab === 'units' ? (
        <div className="fw-q-stack">
          <div className="fw-qd-two">
            <Section id="facts" title={td('incoming.facts')}>
              <Facts
                items={[
                  { label: td('incoming.lot'), value: read.lot ? <Link className="fw-q-link" href={`${model.prefix}/warehouse/lots/${encodeURIComponent(read.lot.id)}`}>{read.lot.code}</Link> : '—' },
                  { label: td('incoming.material'), value: read.lot ? `${read.lot.item.code} · ${read.lot.item.name}` : '—' },
                  { label: td('col.supplier'), value: dash(read.lot?.supplier?.name ?? null) },
                  { label: td('plan.label'), value: read.plan ? <Link className="fw-q-link" href={`${model.prefix}/quality/plans/${encodeURIComponent(read.plan.planId)}`}>{td('plan.version', { code: read.plan.code, number: read.plan.number })}</Link> : '—' },
                  { label: td('col.lot'), value: say(quantityWords(inspection.lotSize, inspection.uom)) },
                  { label: td('col.sample'), value: td('sample.nOf', { done: read.progress.done, sample: read.progress.sampleSize }) },
                  { label: td('incoming.inspector'), value: inspector },
                  { label: td('incoming.due'), value: dash(when(inspection.dueAt)) },
                ]}
              />
            </Section>
            <Section id="sample" title={td('aql.heading')} sub={td(`incoming.method.${read.sampling.method}`)}>
              {read.sampling.plan ? <AqlSummary plan={read.sampling.plan} source={read.sampling.profile ? td('aql.profile.named', { code: read.sampling.profile.code, name: read.sampling.profile.name }) : undefined} title={td('aql.derivation')} headingLevel={4} compact /> : <p className="fw-q-hint">{td(`incoming.method.${read.sampling.method}`)}</p>}
              <AqlResultTable result={read.result} />
            </Section>
          </div>
          {inspection.byHide && (
            <Section id="hides" title={td('incoming.hides')} sub={td('incoming.hidesSub', { done: read.progress.done, sample: read.progress.sampleSize, accepted: read.progress.accepted, rejected: read.progress.rejected, toSort: read.progress.toSort })}>
              {read.hides.length === 0 ? (
                <p className="fw-q-hint">{td('incoming.noHides')}</p>
              ) : (
                <SummaryTable
                  label={td('incoming.hides')}
                  columns={[td('incoming.col.hide'), td('incoming.col.area'), td('incoming.col.check'), td('incoming.col.shade'), td('incoming.col.grade'), td('incoming.col.worst'), td('incoming.col.decision')]}
                  rows={read.hides.map((hide) => ({
                    id: hide.id,
                    cells: [
                      <span key="h" className="fw-q-code">
                        {hide.code}
                      </span>,
                      <span key="a" className="fw-q-cell">
                        <span>{td('incoming.area', { area: Number(hide.measuredArea), uom: hide.areaUom })}</span>
                        <span className="fw-q-hint">{hide.measured ? td('incoming.measuredHere') : td('incoming.received')}</span>
                      </span>,
                      hide.areaCheck ? (
                        <Tag key="c" tone={AREA_TONE[hide.areaCheck.outcome]}>
                          {td(`incoming.areaCheck.${hide.areaCheck.outcome}`, { percent: Number(hide.areaCheck.differencePercent) })}
                        </Tag>
                      ) : (
                        '—'
                      ),
                      hide.shadeGroup ? `${hide.shadeGroup.label}${hide.shadeGroup.outOfShade ? ` · ${td('incoming.outOfShade')}` : ''}` : '—',
                      hide.grade?.code ?? '—',
                      hide.worstClass ? <ClassTag key="w" klass={hide.worstClass} /> : <span key="w" className="fw-q-hint">{td('incoming.noDefect')}</span>,
                      hide.decision ? (
                        <Tag key="d" tone={DECISION_TONE[hide.decision]}>
                          {td(`incoming.decision.${hide.decision}`)}
                        </Tag>
                      ) : (
                        '—'
                      ),
                    ],
                  }))}
                  stackOnPhone
                />
              )}
              {read.areaCheck?.outcome && (
                <p className="fw-q-hint">
                  {td(`incoming.lotArea.${read.areaCheck.outcome}`, { percent: Number(read.areaCheck.differencePercent ?? 0), tolerance: Number(read.areaCheck.tolerancePercent), hides: read.areaCheck.hides })}
                  {read.areaCheck.opensClaim ? ` ${td('incoming.claim')}` : ''}
                </p>
              )}
            </Section>
          )}
          {read.checks.length > 0 && (
            <Section id="checks" title={td('incoming.checks')}>
              <ul className="fw-qd-checks">
                {read.checks.map((check) => {
                  const pass = check.answers.filter((entry) => entry.outcome === 'PASS').length
                  const fail = check.answers.filter((entry) => entry.outcome === 'FAIL').length
                  const na = check.answers.filter((entry) => entry.outcome === 'NOT_APPLICABLE').length
                  return (
                    <li key={check.id} className="fw-qd-check">
                      <span className="fw-q-cell-row">
                        <strong>{labelIn(check, locale)}</strong>
                        <ClassTag klass={check.checkClass} />
                        {check.mandatory && <Tag tone="neutral">{td('checks.mandatory')}</Tag>}
                      </span>
                      <span className="fw-q-hint">{check.answers.length === 0 ? td('checks.answer.none') : td('incoming.answers', { pass, fail, na })}</span>
                      <span className="fw-q-hint">{check.answers.map((entry) => entry.note).filter(Boolean).join(' · ')}</span>
                    </li>
                  )
                })}
              </ul>
            </Section>
          )}
        </div>
      ) : (
        <div className="fw-q-stack">
          <div className="fw-qd-two">
            <Section id="decision" title={td('incoming.decisionHeading')}>
              {inspection.status === 'OPEN' ? (
                <p className="fw-q-hint">{td('incoming.notDecided')}</p>
              ) : inspection.status === 'CANCELLED' ? (
                <p className="fw-q-hint">{td('incoming.cancelled', { reason: inspection.cancelReason ?? '—' })}</p>
              ) : (
                <Facts
                  items={[
                    { label: td('incoming.computed'), value: inspection.computedResult ? td(`result.short.${inspection.computedResult}`) : '—' },
                    { label: td('incoming.split'), value: (() => { const words = decisionWords(inspection.decision, inspection.uom); return words ? say(words) : '—' })() },
                    { label: td('incoming.override'), value: dash(inspection.overrideReason) },
                    { label: td('incoming.signedAt'), value: dash(when(inspection.decidedAt)) },
                    { label: td('incoming.signature'), value: <span className="fw-q-code">{inspection.signatureSha256 ? `${inspection.signatureSha256.slice(0, 16)}…` : '—'}</span> },
                    { label: td('incoming.inspector'), value: inspector },
                  ]}
                />
              )}
            </Section>
            <Section id="next" title={td('incoming.next')}>
              {read.next ? (
                <>
                  <p>{locale.startsWith('it') ? read.next.words.it : read.next.words.en}</p>
                  {read.next.rejectedHides.length > 0 && <p className="fw-q-hint">{td('incoming.rejectedHides', { hides: read.next.rejectedHides.map((hide) => hide.code).join(', ') })}</p>}
                  {read.next.toSortHides.length > 0 && <p className="fw-q-hint">{td('incoming.toSortHides', { hides: read.next.toSortHides.map((hide) => hide.code).join(', ') })}</p>}
                  <span className="fw-q-actions">
                    <Button size="sm" onClick={() => actions?.onPlaceHold?.()} heldReason={holdHeld}>
                      <Hand size={13} aria-hidden /> {td('incoming.placeHold', { count: holdHides })}
                    </Button>
                    {read.lot && (
                      <Button size="sm" variant="quiet" asChild>
                        <Link href={`${model.prefix}/warehouse/lots/${encodeURIComponent(read.lot.id)}`}>{td('incoming.lotRelease')}</Link>
                      </Button>
                    )}
                  </span>
                </>
              ) : (
                <p className="fw-q-hint">{td('incoming.nextAfter')}</p>
              )}
            </Section>
          </div>
          {inspection.status === 'DECIDED' ? (
            <AmendmentsSection state={model.amendments} can={model.depth} actions={actions} />
          ) : (
            <Section id="amendments" title={td('amend.heading')}>
              <p className="fw-q-hint">{td('amend.notSigned')}</p>
            </Section>
          )}
        </div>
      )}
      {stepUp && <DepthStepUp state={stepUp} onSubmit={(code) => actions?.onStepUpSubmit?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />}
    </RecordFrame>
  )
}
