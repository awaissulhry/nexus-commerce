'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Camera, FileText, Package, Ruler, Shield, Shirt, Sticker, Tag, Zap } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { densityAttrs } from '@nexus/ui/tokens/density'
import { FloorButton } from '@nexus/ui/floor'
import { PinSignBlock } from '@nexus/ui/components/PinSignBlock/index'
import { GateExplainer, gateHeldReason, type GateCheck } from '@nexus/ui/components/GateExplainer/index'
import { SignOffPanel, type SignOffStep } from '@nexus/ui/components/SignOffPanel/index'
import { LimitMeter, ToleranceCell } from '@nexus/ui/components/LimitMeter/index'
import { FloorChecklist, type FloorChecklistAnswer, type FloorChecklistGroup } from '@nexus/ui/floor/FloorChecklist/index'
import type { ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { WithMessages } from '../../../../record-panels/i18n'
import { useDsLabels } from '../../../i18n/ds-labels'
import { INTL_LOCALE } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import './ds-quality-lab.css'

/**
 * The quality and floor parts lab (`/design/ds-quality-parts`, B-W2b-78): GateExplainer, SignOffPanel, LimitMeter (with
 * ToleranceCell) at the console's size, and FloorChecklist with a GateExplainer line and a PIN sign-off inside a
 * `data-density="floor"` box (tablet and glove sizes) — each with the `ds-words` catalogue as its `labels`, in the
 * gallery's language. In the browser the parts work: answer the checklist (Fail asks a reason, then a photo), open the
 * gate's popover, release with the second person, sign on the floor with the demo PIN. Made-up data only.
 */
export interface DsQualityLabModel {
  /** One group alone, or every part. */
  show?: 'all' | 'office' | 'floor'
  /** The certificate gate: blocked (default), not known yet, clear, frozen at release, nothing listed. */
  gate?: 'held' | 'unknown' | 'open' | 'frozen' | 'none'
  /** The release sign-off: the viewer signed the result (default: four-eyes holds), another person may release, done, rejected. */
  signoff?: 'self' | 'other' | 'done' | 'rejected'
  /** The floor checklist: from the start (default), part answered, every check answered, held, no checks. */
  checklist?: 'start' | 'partly' | 'done' | 'held' | 'empty'
}

const DEMO_PIN = '246810'
const SHA = '0b00b462fe392b8669ea5dcea35fe681daf365a1920525c0b0884c39a2606312'
type Answers = Record<string, FloorChecklistAnswer | undefined>

export function DsQualityLab({ model }: { model: DsQualityLabModel }) {
  return (
    <WithMessages namespaces={['ds-words', 'ds-quality-lab']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <Card padded header={title} className="fw-dql-card">
      {note ? <p className="fw-dql-note">{note}</p> : null}
      {children}
    </Card>
  )
}

function Part({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'fw-dql-part fw-dql-span' : 'fw-dql-part'}>
      <span className="fw-dql-label">{label}</span>
      {children}
    </div>
  )
}

function Lab({ model }: { model: DsQualityLabModel }) {
  const t = useT('ds-quality-lab')
  const show = model.show ?? 'all'
  return (
    <main id="main-content" className="fw-dql">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {show === 'all' || show === 'office' ? (
        <Section title={t('section.office')}>
          <div className="fw-dql-grid">
            <OfficeParts model={model} />
          </div>
        </Section>
      ) : null}
      {show === 'all' || show === 'floor' ? (
        <Section title={t('section.floor')} note={t('section.floorNote')}>
          <div className="fw-dql-floor fw-dql-grid" {...densityAttrs('floor')}>
            <FloorParts model={model} />
          </div>
        </Section>
      ) : null}
    </main>
  )
}

/* ── the gate's checks, shared by the office and the floor ─────────────────────────────────────────────────────── */

function useGateChecks(gate: NonNullable<DsQualityLabModel['gate']>): GateCheck[] {
  const t = useT('ds-quality-lab')
  return useMemo(() => {
    if (gate === 'none') return []
    const covered = gate !== 'held'
    const crvi = gate === 'unknown' ? 'unknown' : 'pass'
    return [
      {
        id: 'cert',
        label: t('gate.cert'),
        state: covered ? 'pass' : 'fail',
        stateLabel: covered ? t('gate.covered') : t('gate.notCovered'),
        reason: covered ? t('gate.certOk') : t('gate.certNo'),
        who: t('gate.certWho'),
        how: t('gate.certHow'),
        law: { law: 'Reg. (UE) 2016/425 art. 8', plain: t('gate.law') },
        fix: { label: t('gate.certFix'), href: '/design/ds-quality-parts/gate-open' },
      },
      {
        id: 'crvi',
        label: t('gate.crvi'),
        state: crvi,
        now: crvi === 'unknown' ? t('gate.pending') : undefined,
        reason: crvi === 'pass' ? t('gate.crviOk') : undefined,
        who: t('gate.crviWho'),
        fix: { label: t('gate.crviFix'), onClick: () => {}, heldReason: t('gate.crviFixHeld') },
      },
      { id: 'label', label: t('gate.label'), state: 'pass', reason: t('gate.labelOk') },
      { id: 'four', label: t('gate.four'), state: 'notNeeded' },
    ] satisfies GateCheck[]
  }, [gate, t])
}

/* ── the office parts ─────────────────────────────────────────────────────────────────────────────────────────── */

function OfficeParts({ model }: { model: DsQualityLabModel }) {
  const t = useT('ds-quality-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const gate = model.gate ?? 'held'
  const checks = useGateChecks(gate)
  const fmt = useMemo(() => {
    const f = new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 3 })
    return (n: number) => f.format(n)
  }, [locale])
  const held = gateHeldReason(checks, ds.gateExplainer)
  const blockers: GateCheck[] = [
    { id: 'b1', label: t('list.de'), state: 'fail', who: t('list.deWho'), fix: { label: t('list.deFix'), onClick: () => {} } },
    { id: 'b2', label: t('list.cert'), state: 'unknown', who: t('list.certWho'), fix: { label: t('list.certFix'), onClick: () => {}, heldReason: t('list.certHeld') } },
    { id: 'b3', label: t('list.lot'), state: 'fail', who: t('list.lotWho'), fix: { label: t('list.lotFix'), onClick: () => {} } },
  ]
  const measures = [
    { id: 'chest', label: t('measure.chest'), value: 52.2, nominal: 52, tolerance: 0.5 },
    { id: 'waist', label: t('measure.waist'), value: 53.3, nominal: 52, tolerance: 0.5 },
    { id: 'sleeve', label: t('measure.sleeve'), value: 63.4, nominal: 64, minus: 0.5, plus: 1 },
    { id: 'back', label: t('measure.back'), value: null, nominal: 72, tolerance: 1 },
  ]

  return (
    <>
      <Part label={t('part.gate')} wide>
        <GateExplainer
          title={t('gate.title')}
          rule={t('gate.rule')}
          checks={checks}
          asOf={gate === 'frozen' ? t('gate.asOf') : undefined}
          override={{
            label: t('gate.override'),
            who: t('gate.overrideWho'),
            how: t('gate.overrideHow'),
            action: { label: t('gate.overrideAction'), onClick: () => {}, heldReason: t('gate.overrideHeld') },
          }}
          labels={ds.gateExplainer}
          lawLabels={ds.lawRef}
        />
      </Part>
      <Part label={t('part.gateCompact')}>
        <div className="fw-dql-stack">
          <GateExplainer form="compact" checks={checks} labels={ds.gateExplainer} />
          <GateExplainer form="popover" title={t('gate.title')} checks={checks} labels={ds.gateExplainer} lawLabels={ds.lawRef} />
          <div className="fw-dql-row">
            <FloorButton variant="primary" heldReason={held} onClick={() => {}}>
              {t('gate.release')}
            </FloorButton>
          </div>
          {held ? <p className="fw-dql-held">{held}</p> : null}
        </div>
      </Part>
      <Part label={t('part.gateList')}>
        <GateExplainer form="list" checks={gate === 'open' ? [] : blockers} labels={ds.gateExplainer} />
      </Part>
      <Part label={t('part.signoff')} wide>
        <ReleaseSignOff start={model.signoff ?? 'self'} />
      </Part>
      <Part label={t('part.limits')}>
        <div className="fw-dql-stack">
          <LimitMeter label={t('limit.crvi')} value={1.2} unit="mg/kg" limit={3} loq={0.5} format={fmt} labels={ds.limitMeter} />
          <LimitMeter label={t('limit.crviFail')} value={4.1} unit="mg/kg" limit={3} loq={0.5} format={fmt} labels={ds.limitMeter} />
          <LimitMeter label={t('limit.crviBelow')} value={null} belowDetection loq={3} limit={3} unit="mg/kg" format={fmt} labels={ds.limitMeter} />
          <LimitMeter label={t('limit.crviInconclusive')} value={null} belowDetection loq={5} limit={3} unit="mg/kg" format={fmt} labels={ds.limitMeter} />
          <LimitMeter label={t('limit.tear')} value={46} unit="N" limit={40} rule="atLeast" format={fmt} labels={ds.limitMeter} />
          <LimitMeter label={t('limit.ph')} value={null} limit={3.5} rule="atLeast" format={fmt} labels={ds.limitMeter} />
        </div>
      </Part>
      <Part label={t('part.tolerance')}>
        <div className="fw-dql-stack">
          <LimitMeter label={t('measure.waist')} value={53.3} nominal={52} tolerance={0.5} unit="cm" format={fmt} labels={ds.limitMeter} />
          <dl className="fw-dql-measures">
            {measures.map((m) => (
              <div key={m.id} className="fw-dql-measure">
                <dt>{m.label}</dt>
                <dd>
                  <ToleranceCell
                    value={m.value}
                    nominal={m.nominal}
                    tolerance={m.tolerance}
                    minus={m.minus}
                    plus={m.plus}
                    unit="cm"
                    format={fmt}
                    labels={ds.limitMeter}
                  />
                </dd>
              </div>
            ))}
          </dl>
          <p className="fw-dql-note">
            {t('limit.cellNote')} <LimitMeter variant="cell" value={1.2} limit={3} unit="mg/kg" format={fmt} labels={ds.limitMeter} />
          </p>
        </div>
      </Part>
    </>
  )
}

function ReleaseSignOff({ start }: { start: NonNullable<DsQualityLabModel['signoff']> }) {
  const t = useT('ds-quality-lab')
  const ds = useDsLabels()
  const [released, setReleased] = useState(start === 'done')
  const result: SignOffStep = {
    id: 'result',
    label: t('sign.result'),
    role: t('sign.inspector'),
    state: 'signed',
    signer: 'Marta Demo',
    method: 'pin',
    methodDetail: t('sign.bench'),
    signedAt: '10:42',
    fingerprint: SHA,
  }
  const rules = [
    { id: 'maker', kind: 'maker' as const, state: 'met' as const, text: t('sign.maker') },
    { id: 'four', kind: 'fourEyes' as const, state: start === 'self' ? ('broken' as const) : ('met' as const) },
  ]
  const release: SignOffStep =
    start === 'rejected'
      ? { id: 'release', label: t('sign.release'), state: 'rejected', signer: 'Paolo Prova', method: 'code', signedAt: '11:05', rejectedReason: t('sign.rejectedWhy') }
      : released
        ? {
            id: 'release',
            label: t('sign.release'),
            state: 'signed',
            signer: 'Luca Esempio',
            signerRole: t('sign.qualityLead'),
            method: 'code',
            signedAt: '11:05',
            fingerprint: SHA,
            rules,
          }
        : {
            id: 'release',
            label: t('sign.release'),
            state: 'waiting',
            whoMay: t('sign.whoMay'),
            rules,
            action: { label: t('sign.releaseAction'), onClick: () => setReleased(true) },
          }
  return <SignOffPanel title={t('sign.title')} steps={[result, release]} labels={ds.signOffPanel} />
}

/* ── the floor parts ──────────────────────────────────────────────────────────────────────────────────────────── */

function FloorParts({ model }: { model: DsQualityLabModel }) {
  const t = useT('ds-quality-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const checks = useGateChecks(model.gate ?? 'held')
  return (
    <>
      <Part label={t('part.checklist')} wide>
        <ChecklistLab start={model.checklist ?? 'start'} locale={INTL_LOCALE[locale]} />
      </Part>
      <Part label={t('part.floorGate')}>
        <GateExplainer form="compact" checks={checks} labels={ds.gateExplainer} />
      </Part>
      <Part label={t('part.floorSign')}>
        <FloorSignOff />
      </Part>
    </>
  )
}

function ChecklistLab({ start, locale }: { start: NonNullable<DsQualityLabModel['checklist']>; locale: string }) {
  const t = useT('ds-quality-lab')
  const ds = useDsLabels()
  const reason = (id: string, photoNeeded?: boolean): ReasonTile => ({ id, label: t(`reason.${id}`), tone: 'danger', photoNeeded })
  const groups: FloorChecklistGroup[] =
    start === 'empty'
      ? []
      : [
          {
            id: 'labels',
            label: t('group.labels'),
            icon: <Tag />,
            reasons: [reason('missing'), reason('wrong'), reason('unreadable')],
            items: [
              { id: 'class', label: t('item.class'), hint: t('item.classHint'), icon: <Shield /> },
              { id: 'ce', label: t('item.ce'), icon: <Sticker /> },
              { id: 'care', label: t('item.care'), icon: <Tag /> },
              { id: 'fibre', label: t('item.fibre'), icon: <FileText /> },
              { id: 'origin', label: t('item.origin'), required: false, icon: <Tag /> },
            ],
          },
          {
            id: 'garment',
            label: t('group.garment'),
            icon: <Shirt />,
            reasons: [reason('stitching'), reason('zip'), reason('damage', true)],
            items: [
              { id: 'build', label: t('item.build'), icon: <Shirt /> },
              { id: 'zips', label: t('item.zips'), icon: <Zap /> },
              { id: 'reflective', label: t('item.reflective'), icon: <Ruler /> },
            ],
          },
          {
            id: 'armour',
            label: t('group.armour'),
            icon: <Shield />,
            reasons: [reason('armourMissing'), reason('armourSize')],
            items: [
              { id: 'fitted', label: t('item.fitted'), icon: <Shield /> },
              { id: 'marked', label: t('item.marked'), hint: t('item.markedHint'), icon: <Sticker />, heldReason: start === 'start' ? t('item.markedHeld') : null },
            ],
          },
          {
            id: 'packaging',
            label: t('group.packaging'),
            icon: <Package />,
            reasons: [reason('leaflet'), reason('hangtag')],
            items: [
              { id: 'leaflet', label: t('item.leaflet'), icon: <FileText /> },
              { id: 'hangtag', label: t('item.hangtag'), icon: <Tag /> },
            ],
          },
        ]
  const initial: Answers =
    start === 'partly'
      ? {
          class: { result: 'pass', by: 'Marta Demo', at: '10:31' },
          ce: { result: 'pass', by: 'Marta Demo', at: '10:31' },
          care: { result: 'fail', reasonId: 'unreadable', reasonLabel: t('reason.unreadable'), photo: true, by: 'Marta Demo', at: '10:32' },
        }
      : start === 'done'
        ? Object.fromEntries(groups.flatMap((g) => g.items.map((i) => [i.id, { result: 'pass' as const, by: 'Marta Demo', at: '10:40' }])))
        : {}
  const [answers, setAnswers] = useState<Answers>(initial)
  const [signed, setSigned] = useState(false)
  const tileLabel = (id?: string) => (id ? t(`reason.${id}`) : undefined)
  const now = () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date())
  return (
    <div className="fw-dql-stack">
      <FloorChecklist
        title={t('checklist.title')}
        groups={groups}
        answers={answers}
        reasons={[reason('other', true)]}
        onPass={(id) => setAnswers((a) => ({ ...a, [id]: { result: 'pass', by: 'Marta Demo', at: now() } }))}
        onFail={(id, fail) =>
          setAnswers((a) => ({
            ...a,
            [id]: { result: 'fail', reasonId: fail.reasonId, reasonLabel: tileLabel(fail.reasonId), photo: fail.photo !== undefined, by: 'Marta Demo', at: now() },
          }))
        }
        onPassGroup={(_, ids) => setAnswers((a) => ({ ...a, ...Object.fromEntries(ids.map((id) => [id, { result: 'pass' as const, by: 'Marta Demo', at: now() }])) }))}
        renderPhoto={(step) => (
          <div className="fw-dql-photo">
            <span className="fw-dql-photo-frame" aria-hidden>
              <Camera />
            </span>
            <p className="fw-dql-note">{t('checklist.photoNote')}</p>
            <FloorButton variant="primary" icon={<Camera />} onClick={() => step.done('demo-photo')}>
              {t('checklist.usePhoto')}
            </FloorButton>
          </div>
        )}
        action={{ label: t('checklist.sign'), onClick: () => setSigned(true) }}
        heldReason={start === 'held' ? t('checklist.held') : null}
        labels={ds.floorChecklist}
        locale={locale}
      />
      {signed ? (
        <p className="fw-dql-done" role="status">
          {t('checklist.signed')}
        </p>
      ) : null}
    </div>
  )
}

function FloorSignOff() {
  const t = useT('ds-quality-lab')
  const ds = useDsLabels()
  const [state, setState] = useState<'idle' | 'done'>('idle')
  const [wrong, setWrong] = useState(0)
  const sign = (pin: string) => (pin === DEMO_PIN ? setState('done') : setWrong((n) => n + 1))
  const steps: SignOffStep[] = [
    {
      id: 'first',
      label: t('floor.firstPiece'),
      role: t('sign.inspector'),
      state: state === 'done' ? 'signed' : 'waiting',
      signer: state === 'done' ? 'Marta Demo' : undefined,
      method: 'pin',
      methodDetail: t('sign.bench'),
      signedAt: state === 'done' ? '10:50' : undefined,
      fingerprint: state === 'done' ? SHA : undefined,
      whoMay: t('floor.whoMay'),
      rules: [{ id: 'maker', kind: 'maker', state: 'met', text: t('floor.maker') }],
      sign: (
        <PinSignBlock
          meaning={t('floor.meaning')}
          signer={{ name: 'Marta Demo', detail: t('sign.inspector') }}
          onSign={sign}
          locked={wrong >= 3}
          message={wrong >= 3 ? t('floor.locked') : wrong > 0 ? t('floor.wrong', { count: 3 - wrong }) : undefined}
          labels={ds.pinSignBlock}
        />
      ),
    },
  ]
  return (
    <div className="fw-dql-stack">
      <SignOffPanel title={t('floor.title')} steps={steps} labels={ds.signOffPanel} />
      {state !== 'done' ? <p className="fw-dql-note">{t('floor.demo', { pin: DEMO_PIN })}</p> : null}
    </div>
  )
}
