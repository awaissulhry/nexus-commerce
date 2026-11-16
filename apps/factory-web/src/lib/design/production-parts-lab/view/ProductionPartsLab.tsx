'use client'

import type { ReactNode } from 'react'
import { Card, ProgressBar } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { Button } from '@nexus/ui/primitives'
import { densityAttrs } from '@nexus/ui/tokens/density'
import { WithMessages } from '../../../../record-panels/i18n'
import { useT } from '../../../i18n/provider'
import { progressFigure, type Face, type HoldInput, type PiecesColourway, type RequestInput, type StepCounts } from '../../../production/model'
import { useProductionWords } from '../../../production/words'
import { FreshnessLine } from '../../../production/view/FreshnessLine'
import { HealthPill } from '../../../production/view/HealthPill'
import { PiecesGrid } from '../../../production/view/PiecesGrid'
import { ProductionHoldBanner } from '../../../production/view/ProductionHoldBanner'
import { RequestCard } from '../../../production/view/RequestCard'
import { StageStrip } from '../../../production/view/StageStrip'
import { WaitingOnPill } from '../../../production/view/WaitingOnPill'
import './production-parts-lab.css'

/**
 * The production parts lab (`/design/production-parts`, F-PR-01): every shared part of `lib/production/view` in its
 * states, for the office (every customer) or one customer's portal (comfortable density) — the five plain stages (row and
 * full form, blocked, unknown), who it waits on, the health chip with its "why", pieces by stage and size, request cards,
 * the hold banner, the freshness line, and the one rule "a bar shows the figure its words name". Light and dark, 1440 /
 * 1920 / 390, Italian and English are the gallery's own switches. Made-up data only (Brand Alpha, Alex Demo, Bea Esempio).
 */
export interface ProductionPartsLabModel {
  face?: Face
  /** One group alone, or every part. */
  show?: 'all' | 'stages' | 'waiting' | 'health' | 'pieces' | 'requests' | 'holds' | 'fresh' | 'progress'
  /** Every part as it reads, still loading, could not be read, or not known yet. */
  state?: 'ready' | 'loading' | 'problem' | 'unknown'
}

/** The lab's clock: every age and every "as of" counts from it, so the frame never jumps. */
export const LAB_NOW = Date.parse('2026-11-17T09:42:00Z')
const hoursAgo = (hours: number) => new Date(LAB_NOW - hours * 3_600_000).toISOString()

type Words = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The lab's made-up order in the frame's language (names stay as they are: Brand Alpha's people, the style code). */
function labData(t: Words, reason: ReturnType<typeof useProductionWords>['reason']) {
  const colourways: readonly PiecesColourway[] = [
    {
      id: 'blk',
      label: t('data.colourway', { colour: t('data.black') }),
      sizes: [
        { size: 'S', ordered: 10, cut: 10, sewn: 9, inspected: 6, packed: 0 },
        { size: 'M', ordered: 20, cut: 20, sewn: 18, inspected: 8, packed: 0 },
        { size: 'L', ordered: 20, cut: 20, sewn: 16, inspected: 6, packed: 0 },
        { size: 'XL', ordered: 10, cut: 10, sewn: 7, inspected: 0, packed: 0 },
      ],
    },
    {
      id: 'red',
      label: t('data.colourway', { colour: t('data.red') }),
      sizes: [
        { size: 'M', ordered: 20, cut: 20, sewn: null, inspected: 0, packed: 0 },
        { size: 'L', ordered: 20, cut: 12, sewn: null, inspected: 0, packed: 0 },
      ],
    },
  ]
  const requests: readonly RequestInput[] = [
    {
      id: 'r1',
      kind: 'CHANGE',
      state: 'OPEN',
      askedAt: hoursAgo(4),
      askedBy: 'Alex Demo',
      changes: [
        { id: 'c1', label: t('data.cell', { colour: t('data.black'), size: 'M' }), from: '20', to: '24' },
        { id: 'c2', label: t('data.cell', { colour: t('data.black'), size: 'XL' }), from: '10', to: '6' },
      ],
      note: t('data.changeNote'),
      impact: { frozen: [t('data.frozen')], earliest: { best: '2026-11-25', likely: '2026-11-27', worst: '2026-12-02' }, price: 'MAY_APPLY' },
    },
    {
      id: 'r2',
      kind: 'RUSH',
      state: 'COUNTERED',
      askedAt: hoursAgo(30),
      askedBy: 'Alex Demo',
      impact: { earliest: { best: '2026-11-21' }, price: 'NONE' },
      answer: { at: hoursAgo(6), by: 'Bea Esempio', words: t('data.counter') },
    },
    { id: 'r3', kind: 'CANCEL', state: 'REFUSED', askedAt: hoursAgo(80), askedBy: 'Alex Demo', note: t('data.cancelNote'), answer: { at: hoursAgo(60), by: 'Carlo Prova', words: t('data.refused') } },
  ]
  const holds: readonly HoldInput[] = [
    { id: 'h1', kind: 'QUALITY', since: '2026-11-14', reason: t('data.qualityReason'), customerWords: reason('QUALITY') },
    { id: 'h2', kind: 'BRAND', since: '2026-11-15' },
  ]
  const production: HoldInput = { id: 'h3', kind: 'PRODUCTION', since: '2026-11-16', reason: t('data.productionReason'), customerWords: null }
  return { colourways, requests, holds, production }
}

const PROGRESS_ROWS: readonly { number: string; pieces: number; counts: StepCounts | null; released: boolean }[] = [
  { number: 'WO-0311', pieces: 100, counts: { cut: 100, bundled: 100, sewn: 80, finished: 0 }, released: true },
  { number: 'WO-0298', pieces: 120, counts: { cut: 40, bundled: 40, sewn: null, finished: 0 }, released: true },
  { number: 'WO-0305', pieces: 60, counts: { cut: 0, bundled: 0, sewn: 0, finished: 0 }, released: true },
  { number: 'WO-0320', pieces: 24, counts: null, released: false },
]

export function ProductionPartsLab({ model }: { model: ProductionPartsLabModel }) {
  return (
    <WithMessages namespaces={['production-parts-lab']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Section({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <Card padded header={title} headingLevel={2} className={wide ? 'fw-ppl-card fw-ppl-span' : 'fw-ppl-card'}>
      <div className="fw-ppl-stack">{children}</div>
    </Card>
  )
}

function Example({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fw-ppl-example">
      <span className="fw-ppl-label">{label}</span>
      <div className="fw-ppl-part">{children}</div>
    </div>
  )
}

function Lab({ model }: { model: ProductionPartsLabModel }) {
  const t = useT('production-parts-lab')
  const face = model.face ?? 'office'
  const show = model.show ?? 'all'
  const state = model.state ?? 'ready'
  const on = (group: NonNullable<ProductionPartsLabModel['show']>) => show === 'all' || show === group
  const loading = state === 'loading'
  const problem = state === 'problem'
  const unknown = state === 'unknown'
  const retry = () => undefined
  const w = useProductionWords()
  const data = labData(t, w.reason)
  const sewn = w.say(progressFigure({ cut: 100, bundled: 100, sewn: 80, finished: 0 }, 100, true).words)
  return (
    <main id="main-content" className="fw-ppl" {...(face === 'customer' ? densityAttrs('comfortable') : {})}>
      <PageHeader title={t('title')} subtitle={t(face === 'customer' ? 'subtitleCustomer' : 'subtitleOffice')} />
      <div className="fw-ppl-grid">
        {on('stages') ? (
          <Section title={t('section.stages')} wide>
            {unknown ? (
              <Example label={t('example.unknown')}>
                <StageStrip face={face} stage={null} />
              </Example>
            ) : loading || problem ? (
              <Example label={t(loading ? 'example.loading' : 'example.problem')}>
                <StageStrip face={face} stage="SEWING" loading={loading} problem={problem} onRetry={retry} />
              </Example>
            ) : (
              <>
                <Example label={t('example.full')}>
                  <StageStrip
                    face={face}
                    stage="SEWING"
                    reached={{ PREPARING: '2026-11-03', CUTTING: '2026-11-08' }}
                    expected={{ SEWING: '2026-11-19', QUALITY: '2026-11-21', READY: '2026-11-24' }}
                    note={sewn}
                    promise={{
                      date: '2026-11-24',
                      history: [
                        { on: '2026-10-20', from: null, to: '2026-11-18', reason: null },
                        { on: '2026-11-10', from: '2026-11-18', to: '2026-11-24', reason: 'MATERIAL_LATE' },
                      ],
                    }}
                  />
                </Example>
                <Example label={t('example.blocked')}>
                  <StageStrip face={face} stage="PREPARING" blocked={{ why: t(face === 'office' ? 'data.blockedOffice' : 'data.blockedCustomer') }} expected={{ CUTTING: '2026-11-20' }} />
                </Example>
                <Example label={t('example.rows')}>
                  <div className="fw-ppl-rows">
                    <StageStrip face={face} stage="PREPARING" layout="compact" />
                    <StageStrip face={face} stage="CUTTING" layout="compact" />
                    <StageStrip face={face} stage="SEWING" layout="compact" sewingCounted={false} />
                    <StageStrip face={face} stage="QUALITY" layout="compact" />
                    <StageStrip face={face} stage="READY" layout="compact" />
                    <StageStrip face={face} stage="CUTTING" layout="compact" blocked={{ why: t(face === 'office' ? 'data.material' : 'data.onUs') }} />
                  </div>
                </Example>
              </>
            )}
          </Section>
        ) : null}

        {on('waiting') ? (
          <Section title={t('section.waiting')}>
            {loading ? (
              <WaitingOnPill face={face} who="US" loading />
            ) : unknown ? (
              <Example label={t('example.unknown')}>
                <WaitingOnPill face={face} who={undefined} />
              </Example>
            ) : face === 'office' ? (
              <div className="fw-ppl-chips">
                <WaitingOnPill face="office" who="US" since={hoursAgo(4)} kind="request" now={LAB_NOW} />
                <WaitingOnPill face="office" who="US" since={hoursAgo(80)} kind="request" now={LAB_NOW} />
                <WaitingOnPill face="office" who="BRAND" what={t('data.ppSample')} since={hoursAgo(50)} dueAt={hoursAgo(-48)} now={LAB_NOW} />
                <WaitingOnPill face="office" who="BRAND" what={t('data.sizeSet')} since={hoursAgo(200)} dueAt={hoursAgo(20)} now={LAB_NOW} />
                <WaitingOnPill face="office" who="SUPPLIER" since={hoursAgo(26)} now={LAB_NOW} />
                <WaitingOnPill face="office" who="WORKSHOP" since={hoursAgo(100)} now={LAB_NOW} />
              </div>
            ) : (
              <div className="fw-ppl-chips">
                <WaitingOnPill face="customer" who="BRAND" since={hoursAgo(26)} dueAt={hoursAgo(-48)} now={LAB_NOW} />
                <WaitingOnPill face="customer" who="BRAND" since={hoursAgo(200)} dueAt={hoursAgo(20)} now={LAB_NOW} />
                <WaitingOnPill face="customer" who="US" since={hoursAgo(4)} kind="request" now={LAB_NOW} />
                <WaitingOnPill face="customer" who="SUPPLIER" since={hoursAgo(100)} now={LAB_NOW} />
              </div>
            )}
            <p className="fw-ppl-note">{t(face === 'office' ? 'note.waitingOffice' : 'note.waitingCustomer')}</p>
          </Section>
        ) : null}

        {on('health') ? (
          <Section title={t('section.health')}>
            {loading ? (
              <HealthPill face={face} computed="ON_TIME" loading />
            ) : unknown ? (
              <div className="fw-ppl-chips">
                <HealthPill face={face} computed={undefined} />
                <HealthPill face={face} computed={null} />
              </div>
            ) : (
              <div className="fw-ppl-chips">
                <HealthPill face={face} computed="ON_TIME" plan="2026-11-22" promise="2026-11-24" />
                <HealthPill face={face} computed="AT_RISK" plan="2026-11-26" promise="2026-11-24" />
                <HealthPill face={face} computed="LATE" daysLate={3} plan="2026-11-18" promise="2026-11-14" />
                <HealthPill face={face} computed="NOT_PROMISED" />
                <HealthPill face={face} computed="ON_TIME" plan="2026-11-22" promise="2026-11-24" raised={{ reason: 'QUALITY', note: t('data.healthNote'), by: 'Bea Esempio', at: '2026-11-14' }} />
              </div>
            )}
            <p className="fw-ppl-note">{t(face === 'office' ? 'note.healthOffice' : 'note.healthCustomer')}</p>
          </Section>
        ) : null}

        {on('pieces') ? (
          <Section title={t('section.pieces')} wide>
            <PiecesGrid colourways={unknown ? [] : data.colourways} loading={loading} problem={problem} onRetry={retry} />
          </Section>
        ) : null}

        {on('requests') ? (
          <Section title={t('section.requests')} wide>
            {unknown || loading || problem ? (
              <p className="fw-ppl-note">{t('note.requestsCaller')}</p>
            ) : (
              <div className="fw-ppl-requests">
                {data.requests.map((request) => (
                  <RequestCard
                    key={request.id}
                    face={face}
                    request={face === 'customer' ? { ...request, askedBy: null, mine: request.id === 'r1' } : request}
                    now={LAB_NOW}
                    action={request.state === 'OPEN' ? <Button size="sm" variant={face === 'office' ? 'primary' : 'quiet'}>{t(face === 'office' ? 'action.answer' : 'action.withdraw')}</Button> : request.state === 'COUNTERED' && face === 'customer' ? <Button size="sm" variant="primary">{t('action.counter')}</Button> : undefined}
                  />
                ))}
              </div>
            )}
          </Section>
        ) : null}

        {on('holds') ? (
          <Section title={t('section.holds')} wide>
            <Example label={t('example.mostSerious')}>
              <ProductionHoldBanner face={face} holds={unknown ? [] : data.holds} action={face === 'office' ? <Button size="sm">{t('action.release')}</Button> : undefined} />
            </Example>
            <Example label={t('example.pause')}>
              <ProductionHoldBanner face={face} holds={unknown ? [] : [data.holds[1]!]} />
            </Example>
            <Example label={t('example.production')}>
              <ProductionHoldBanner face={face} holds={unknown ? [] : [data.production]} />
            </Example>
            {unknown ? <p className="fw-ppl-note">{t('note.noHold')}</p> : null}
          </Section>
        ) : null}

        {on('fresh') ? (
          <Section title={t('section.fresh')}>
            <div className="fw-ppl-chips fw-ppl-column">
              {unknown ? (
                <FreshnessLine mode="polling" asOf={null} />
              ) : (
                <>
                  <FreshnessLine mode="live" asOf={hoursAgo(0)} />
                  <FreshnessLine mode="polling" asOf={hoursAgo(0)} />
                  <FreshnessLine mode="polling" asOf={hoursAgo(0)} everySeconds={30} />
                  <FreshnessLine mode="offline" asOf={hoursAgo(0.1)} />
                  <FreshnessLine mode="connecting" asOf={null} />
                </>
              )}
            </div>
          </Section>
        ) : null}

        {on('progress') && face === 'office' ? (
          <Section title={t('section.progress')}>
            <ProgressRule />
            <p className="fw-ppl-note">{t('note.progress')}</p>
          </Section>
        ) : null}
      </div>
    </main>
  )
}

/** The list's progress cell: the bar and its words from one figure (rule R5). */
function ProgressRule() {
  const w = useProductionWords()
  return (
    <ul className="fw-ppl-progress">
      {PROGRESS_ROWS.map((row) => {
        const figure = progressFigure(row.counts, row.pieces, row.released)
        const words = w.say(figure.words)
        return (
          <li key={row.number} className="fw-ppl-progress-row">
            <strong>{row.number}</strong>
            <ProgressBar value={figure.percent} height={6} ariaLabel={w.t('list.progressLabel', { number: row.number, figure: words })} />
            <span className="fw-ppl-note">{words}</span>
          </li>
        )
      })}
    </ul>
  )
}
