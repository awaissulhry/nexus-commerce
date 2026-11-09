'use client'

import type { ReactNode } from 'react'
import { Camera, Check, CircleAlert, CircleCheckBig, CircleDashed, CircleHelp, CircleMinus, ClipboardCheck, CloudOff, Hash, ImageOff, Minus, Plus, Ruler, ScanBarcode, ShieldAlert, Undo2, X } from 'lucide-react'
import { AqlCounter, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, QuantityPad, ScanInput, type CameraScanner } from '@nexus/ui/floor'
import { FloorChecklist, type FloorChecklistAnswer, type FloorChecklistGroup } from '@nexus/ui/floor/FloorChecklist/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { LimitMeter } from '@nexus/ui/components/LimitMeter/index'
import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { PHOTO_KIT_NAMESPACE, usePhotoWords } from '../../../../../lib/ds-words/photo-capture'
import { verdictLine } from '../../count'
import { useReasonWords } from '../../../../../lib/ds-words/reason-grid'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatNumber, formatTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { TaskCard, TaskLine, Ticks, type TickState } from '../../../shared/view/TaskParts'
import type { ChartPoint, FinalDefect, Sheet, SheetCheck } from '../api'
import {
  defectsOfClass,
  defectWords,
  failWords,
  firstResult,
  identityLine,
  instructions,
  measureHeld,
  measureVerdict,
  officeChecks,
  photoTargets,
  pointAsks,
  sectionsOf,
  specOf,
  tapAnswer,
  tapGroups,
  valueChecks,
  type BenchSection,
  type DefectLine,
  type MeasureDraft,
  type SectionState,
} from '../model'
import '../plan.css'

/**
 * SCR-097's W2b sections (B-W2b-109; design floor.final "aql", "checklist" W2b marker, "measure", "serial", "photos"; QHS-067:
 * big targets, a plus and a minus per defect, one hand, gloves on). The bench on its plan, one section at a time from a strip of
 * big buttons (each with its state icon and word): the AQL counter (DS AqlCounter: "+ one piece" is the main tap; a defect per
 * class with + and −, which defect asked on the + from the FINAL vocabulary), the plan's checks (DS FloorChecklist; a fail asks
 * what is wrong and, where the plan asks, a photo with markup), the points of measure one per step (DS QuantityPad with decimals
 * and DS LimitMeter, in or out in words), the serial or batch check (DS ScanInput, a tick per garment) and the photo set (DS
 * PhotoCapture in its slots). Every number of the sample comes from the sheet (B-W2b-97 on B-W2b-93's AQL engine): never
 * computed here. A write kept on the tablet says so with its ticks. No money, never a person.
 */

export interface BenchModel {
  sheet: Sheet
  section: BenchSection
  /** The defects found, as W1's defect lines. */
  lines: readonly DefectLine[]
  /** The FINAL vocabulary in the worker's language. */
  defects: { readonly list: readonly FinalDefect[]; readonly state: 'ready' | 'loading' | 'offline' | 'error' }
  /** A class's + (which defect?) or − with several lines (which one goes?). */
  pick: { readonly kind: 'add' | 'remove'; readonly defectClass: 'CRITICAL' | 'MAJOR' | 'MINOR' } | null
  /** A count or a choice check open. */
  value: { readonly code: string; readonly value: number | null; readonly choice: string | null } | null
  measure: MeasureDraft | null
  /** The photo step open (a target's key). */
  photo: string | null
  /** The work order's sizes (a point names its size when there are several). */
  sizes: readonly string[]
  /** The last write kept on this tablet, with its ticks (or refused when sent). */
  kept: { readonly ticks: TickState; readonly refusal?: string | null } | null
  /** A photo just added (said once). */
  photoAdded?: string | null
  busy: boolean
  /** The sheet comes from this tablet: as of when. */
  asOf: string | null
  /** Bench writes of this inspection still waiting on the tablet (the signature waits for them). */
  waiting: number
}

export type BenchAction =
  | { type: 'section'; section: BenchSection }
  | { type: 'count'; add: number }
  | { type: 'classAdd'; defectClass: 'CRITICAL' | 'MAJOR' | 'MINOR' }
  | { type: 'classRemove'; defectClass: 'CRITICAL' | 'MAJOR' | 'MINOR' }
  | { type: 'pick'; code: string }
  | { type: 'pickClose' }
  | { type: 'line'; defectClass: 'CRITICAL' | 'MAJOR' | 'MINOR'; code: string; delta: 1 | -1 }
  | { type: 'pass'; codes: string[] }
  | { type: 'fail'; code: string; reasonId?: string; photo?: unknown }
  | { type: 'valueOpen'; code: string }
  | { type: 'valueNumber'; value: number | null }
  | { type: 'valueChoice'; value: string }
  | { type: 'valueSave'; outcome: 'PASS' | 'FAIL' }
  | { type: 'measureOpen'; pointCode: string }
  | { type: 'measureField'; field: MeasureDraft['field'] }
  | { type: 'measureNumber'; value: number | null }
  | { type: 'measureSize'; size: string }
  | { type: 'measureSave' }
  | { type: 'measureTakeBack'; pointCode: string; size: string; sampleIndex: number }
  | { type: 'serial'; code: string | null }
  | { type: 'serialRemove'; code: string }
  | { type: 'photoOpen'; key: string }
  | { type: 'photoTaken'; photo: CapturedPhoto }
  | { type: 'retryDefects' }
  | { type: 'close' }

const STATE_ICON: Readonly<Record<SectionState, ReactNode>> = { open: <CircleDashed />, partly: <CircleMinus />, done: <CircleCheckBig />, failed: <X /> }
const SECTION_ICON: Readonly<Record<BenchSection, ReactNode>> = { aql: <Hash />, checks: <ClipboardCheck />, measure: <Ruler />, serial: <ScanBarcode />, photos: <Camera /> }

/** The bench's head: the plan, the sample of the lot, the result as it stands (in words). */
export function BenchHead({ sheet }: { sheet: Sheet }) {
  const t = useT('floor-final-plan')
  const fail = sheet.result.resultNow === 'FAIL'
  const why = fail ? failWords(sheet) : []
  return (
    <div className="fw-fp-head">
      <TaskLine tone="info" icon={<ClipboardCheck />}>
        {[
          t('head.plan', { code: sheet.plan.code, number: sheet.plan.number, name: sheet.plan.name }),
          sheet.inspection.codeLetter ? t('head.sampleLetter', { sample: sheet.counter.sampleSize, lot: sheet.inspection.lotSize, letter: sheet.inspection.codeLetter }) : t('head.sample', { sample: sheet.counter.sampleSize, lot: sheet.inspection.lotSize }),
        ].join(' · ')}
      </TaskLine>
      <TaskLine tone={fail ? 'danger' : 'success'} icon={fail ? <CircleAlert /> : <CircleCheckBig />}>
        {fail ? `${t('result.fail')} ${why.map((word) => t(word.key, word.params)).join(' · ')}`.trim() : t('result.pass')}
      </TaskLine>
    </div>
  )
}

/** One big button per section, its state as icon AND word (never colour alone). */
export function SectionStrip({ sheet, section, onSection }: { sheet: Sheet; section: BenchSection; onSection: (section: BenchSection) => void }) {
  const t = useT('floor-final-plan')
  return (
    <div className="fw-fp-sections" role="group" aria-label={t('sections')}>
      {sectionsOf(sheet).map((entry) => (
        <FloorButton
          key={entry.id}
          size="md"
          variant={entry.id === section ? 'primary' : entry.state === 'failed' ? 'danger' : entry.state === 'done' ? 'success' : 'secondary'}
          icon={entry.id === section ? SECTION_ICON[entry.id] : STATE_ICON[entry.state]}
          aria-pressed={entry.id === section}
          onClick={() => onSection(entry.id)}
        >
          <span className="fw-fp-section">
            <span>{t(`section.${entry.id}`)}</span>
            <span className="fw-fp-section-state">{t(`state.${entry.state}`)}</span>
          </span>
        </FloorButton>
      ))}
    </div>
  )
}

export interface BenchBodyProps {
  bench: BenchModel
  online: boolean
  send: (action: BenchAction) => void
  camera?: CameraScanner
  timeZone?: string
}

/** The open section's body. */
export function BenchBody({ bench, online, send, camera, timeZone }: BenchBodyProps) {
  const t = useT('floor-final-plan')
  const locale = useLocale()
  const time = (value: string) => formatTime(value, { locale, timeZone })
  const record = bench.sheet.may.record
  const held = !record ? t('held.noRecord') : bench.busy ? t('busy') : null
  let body: ReactNode
  switch (bench.section) {
    case 'aql':
      body = <AqlSection bench={bench} held={held} send={send} t={t} locale={locale} />
      break
    case 'checks':
      body = <ChecksSection bench={bench} held={held} online={online} send={send} t={t} locale={locale} />
      break
    case 'measure':
      body = <MeasureSection bench={bench} held={held} send={send} t={t} locale={locale} />
      break
    case 'serial':
      body = <SerialSection bench={bench} held={held} send={send} t={t} camera={camera} />
      break
    case 'photos':
      body = <PhotoSection bench={bench} held={held} online={online} send={send} t={t} locale={locale} />
      break
  }
  return (
    <>
      {bench.asOf ? (
        <TaskLine tone="warning" icon={<CloudOff />}>
          {t('asOf', { time: time(bench.asOf) })}
        </TaskLine>
      ) : null}
      {bench.kept ? <KeptLine kept={bench.kept} t={t} /> : null}
      {body}
    </>
  )
}

function KeptLine({ kept, t }: { kept: NonNullable<BenchModel['kept']>; t: Translate }) {
  const refused = kept.ticks === 'refused'
  return (
    <TaskLine tone={refused ? 'danger' : 'info'} icon={refused ? <CircleAlert /> : <CloudOff />} alert={refused}>
      {refused ? t('kept.refused') : t(kept.ticks === 'recorded' ? 'kept.recorded' : 'kept.saved')} <Ticks state={kept.ticks} />
    </TaskLine>
  )
}

// ---- the AQL counter ----------------------------------------------------------------------------------------------------------

const CLASS_ID = { CRITICAL: 'CRITICAL', MAJOR: 'MAJOR', MINOR: 'MINOR' } as const

function AqlSection({ bench, held, send, t, locale }: { bench: BenchModel; held: string | null; send: (action: BenchAction) => void; t: Translate; locale: Locale }) {
  const reasonWords = useReasonWords()
  const { counter } = bench.sheet
  const number = (value: number) => formatNumber(value, locale)
  if (bench.pick) {
    const { defectClass } = bench.pick
    const tiles: ReasonTile[] =
      bench.pick.kind === 'add'
        ? defectsOfClass(bench.defects.list, defectClass).map((defect) => ({ id: defect.code, label: defect.label ?? t('defect.otherOf', { klass: t(`class.${defectClass}`) }), tone: defectClass === 'CRITICAL' ? 'danger' : defectClass === 'MAJOR' ? 'warning' : 'neutral' }))
        : bench.lines.filter((line) => line.defectClass === defectClass).map((line) => ({ id: line.code, label: defectWords(bench.defects.list, line.code), hint: t('defect.count', { count: line.quantity }) }))
    return (
      <section className="fw-floor-stack" aria-labelledby="fw-fp-pick">
        <h2 id="fw-fp-pick" className="fw-floor-section-title">
          {t(bench.pick.kind === 'add' ? 'defect.which' : 'defect.whichBack', { klass: t(`class.${defectClass}`) })}
        </h2>
        {bench.pick.kind === 'add' && bench.defects.state !== 'ready' ? (
          <TaskLine tone="warning" icon={<CircleHelp />}>
            {t(`defect.list.${bench.defects.state}`)}
          </TaskLine>
        ) : null}
        <ReasonGrid label={t('defect.which', { klass: t(`class.${defectClass}`) })} hideLabel reasons={tiles.map((tile) => ({ ...tile, heldReason: held }))} value={null} onChange={(id) => send({ type: 'pick', code: id })} words={reasonWords} locale={INTL_LOCALE[locale]} />
        <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => send({ type: 'pickClose' })}>
          {t('defect.cancel')}
        </FloorButton>
      </section>
    )
  }
  const classes = counter.classes.map((entry) => ({ id: CLASS_ID[entry.defectClass], label: t(`class.${entry.defectClass}`), accept: entry.accept, defects: entry.found }))
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fp-aql">
      <h2 id="fw-fp-aql" className="fw-floor-section-title">
        {t('section.aql')}
      </h2>
      <AqlCounter
        label={t('aql.label', { major: bench.sheet.inspection.aqlMajor, minor: bench.sheet.inspection.aqlMinor, sample: counter.sampleSize })}
        sampleSize={counter.sampleSize}
        inspected={counter.inspected}
        onInspectedChange={(value) => (held ? undefined : send({ type: 'count', add: value - counter.inspected }))}
        classes={classes}
        onDefectsChange={(id, value) => {
          if (held) return
          const defectClass = id as 'CRITICAL' | 'MAJOR' | 'MINOR'
          const now = counter.classes.find((entry) => entry.defectClass === defectClass)?.found ?? 0
          send(value > now ? { type: 'classAdd', defectClass } : { type: 'classRemove', defectClass })
        }}
        inspectedLabel={t('aql.inspected')}
        sampleLabel={(inspected, sample) => t('aql.of', { inspected: number(inspected), sample: number(sample) })}
        thresholdLabel={(accept, reject) => t('aql.threshold', { accept, reject })}
        verdictLabels={{ open: t('aql.verdict.open'), accept: t('aql.verdict.accept'), reject: t('aql.verdict.reject') }}
        classStateLabels={{ ok: t('aql.classState.ok'), limit: t('aql.classState.limit'), reject: t('aql.classState.reject') }}
        addInspectedLabel={t('aql.add')}
        removeInspectedLabel={t('aql.remove')}
        addDefectLabel={(klass) => t('aql.addDefect', { klass })}
        removeDefectLabel={(klass) => t('aql.removeDefect', { klass })}
        sampleDoneLabel={t('aql.sampleDone')}
        nothingToRemoveLabel={t('aql.nothing')}
      />
      {held ? <p className="fw-floor-muted">{held}</p> : null}
      {counter.verdict === 'reject' && !counter.classes.some((entry) => entry.found >= entry.reject) ? (
        <TaskLine tone="danger" icon={<ShieldAlert />}>
          {t('aql.criticalCheck')}
        </TaskLine>
      ) : null}
      <TaskLine tone="info" icon={<CircleHelp />}>
        {counter.stop.stop ? t('aql.stop.on') : t('aql.stop.off')} {t(`aql.stop.source.${counter.stop.source}`)}
      </TaskLine>
      {bench.lines.length > 0 ? (
        <section className="fw-floor-stack" aria-labelledby="fw-fp-lines">
          <h3 id="fw-fp-lines" className="fw-floor-subtitle">
            {t('defect.found')}
          </h3>
          <ul className="fw-fp-lines">
            {bench.lines.map((line) => (
              <li key={`${line.defectClass}:${line.code}`} className="fw-fp-line" data-class={line.defectClass}>
                <span className="fw-fp-line-text">
                  <strong>{defectWords(bench.defects.list, line.code)}</strong>
                  <span className="fw-floor-muted">
                    {t(`class.${line.defectClass}`)} · <span className="fw-floor-code">{line.code}</span>
                  </span>
                </span>
                <span className="fw-fp-line-count">
                  <FloorButton size="lg" icon={<Minus />} aria-label={t('defect.less', { defect: defectWords(bench.defects.list, line.code) })} heldReason={held} onClick={() => send({ type: 'line', defectClass: line.defectClass, code: line.code, delta: -1 })} />
                  <span className="fw-fp-line-number" aria-label={t('defect.count', { count: line.quantity })}>
                    {number(line.quantity)}
                  </span>
                  <FloorButton size="lg" icon={<Plus />} aria-label={t('defect.more', { defect: defectWords(bench.defects.list, line.code) })} heldReason={held} onClick={() => send({ type: 'line', defectClass: line.defectClass, code: line.code, delta: 1 })} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="fw-floor-muted">{t('aql.keys')}</p>
    </section>
  )
}

// ---- the plan's checks ---------------------------------------------------------------------------------------------------------

function ChecksSection({ bench, held, online, send, t, locale }: { bench: BenchModel; held: string | null; online: boolean; send: (action: BenchAction) => void; t: Translate; locale: Locale }) {
  const ds = useDsWords()
  const reasonWords = useReasonWords()
  const { sheet } = bench
  if (bench.value) {
    const check = sheet.checks.find((entry) => entry.code === bench.value!.code)
    if (check) return <ValueStep check={check} draft={bench.value} held={held} send={send} t={t} locale={locale} />
  }
  const reasons: ReasonTile[] = bench.defects.list.map((defect) => ({ id: defect.code, label: defect.label, tone: defect.severity === 'CRITICAL' ? 'danger' : defect.severity === 'MAJOR' ? 'warning' : 'neutral' }))
  const groups: FloorChecklistGroup[] = tapGroups(sheet).map((group) => ({
    id: group.id,
    label: t(`class.${group.id}`),
    items: group.checks.map((check) => ({
      id: check.code,
      label: check.label,
      hint: [check.mandatory ? null : t('checks.optional'), check.photoRequired ? (online ? t('checks.photoNeeded') : t('checks.photoLater')) : null].filter(Boolean).join(' · ') || undefined,
      required: check.mandatory,
      // The plan asks a photo with this check: a fail takes it at once (online; offline it waits in Photos).
      ...(check.photoRequired && online ? { reasons: reasons.map((reason) => ({ ...reason, photoNeeded: true })) } : {}),
    })),
  }))
  const answers: Record<string, FloorChecklistAnswer> = {}
  for (const group of tapGroups(sheet)) {
    for (const check of group.checks) {
      const answer = tapAnswer(check)
      if (answer) answers[check.code] = { result: answer, ...(answer === 'fail' && firstResult(check)?.note ? { reasonLabel: firstResult(check)!.note! } : {}), ...(firstResult(check)?.photos.length ? { photo: true } : {}) }
    }
  }
  const values = valueChecks(sheet)
  return (
    <>
      {groups.length > 0 ? (
        <FloorChecklist
          groups={groups}
          answers={answers}
          reasons={reasons}
          onPass={(code) => send({ type: 'pass', codes: [code] })}
          onFail={(code, fail) => send({ type: 'fail', code, ...(fail.reasonId ? { reasonId: fail.reasonId } : {}), ...(fail.photo ? { photo: fail.photo } : {}) })}
          onPassGroup={(_group, codes) => send({ type: 'pass', codes })}
          photo={online ? 'optional' : 'off'}
          renderPhoto={online ? (step) => <BenchPhoto label={t('photo.ofFail', { check: step.item.label })} markup onCapture={(photo) => step.done(photo)} onCancel={step.cancel} /> : undefined}
          heldReason={held}
          title={t('checks.title')}
          labels={ds.floorChecklist}
          reasonWords={reasonWords}
          locale={INTL_LOCALE[locale]}
        />
      ) : null}
      {values.length > 0 ? (
        <section className="fw-floor-stack" aria-labelledby="fw-fp-values">
          <h2 id="fw-fp-values" className="fw-floor-section-title">
            {t('checks.values')}
          </h2>
          <FloorList label={t('checks.values')}>
            {values.map((check) => {
              const result = firstResult(check)
              return (
                <FloorListRow
                  key={check.code}
                  icon={<Hash />}
                  tone={result ? (result.outcome === 'PASS' ? 'success' : result.outcome === 'FAIL' ? 'danger' : 'neutral') : check.mandatory ? 'warning' : 'neutral'}
                  title={check.label}
                  meta={[t(`class.${check.checkClass ?? 'OTHER'}`), result ? t(`checks.answer.${result.outcome}`, { value: result.value ?? '' }) : check.mandatory ? t('checks.toAnswer') : t('checks.optional')].join(' · ')}
                  status={result ? t(`checks.outcome.${result.outcome}`) : t('checks.notYet')}
                  onPress={held ? undefined : () => send({ type: 'valueOpen', code: check.code })}
                />
              )
            })}
          </FloorList>
        </section>
      ) : null}
      {officeChecks(sheet).map((check) => (
        <TaskLine key={check.code} tone="info" icon={<CircleHelp />}>
          {t('checks.office', { check: check.label })}
        </TaskLine>
      ))}
      {instructions(sheet).map((check) => (
        <TaskLine key={check.code} tone="info" icon={<ClipboardCheck />}>
          {check.label}
        </TaskLine>
      ))}
    </>
  )
}

/** A count or a choice: the number on the pad or a choice button, then the inspector's pass or fail. */
function ValueStep({ check, draft, held, send, t, locale }: { check: SheetCheck; draft: NonNullable<BenchModel['value']>; held: string | null; send: (action: BenchAction) => void; t: Translate; locale: Locale }) {
  const missing = check.type === 'CHOICE' ? draft.choice === null : draft.value === null
  const why = held ?? (missing ? t('value.held') : null)
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fp-value">
      <h2 id="fw-fp-value" className="fw-floor-section-title">
        {check.label}
      </h2>
      {check.type === 'CHOICE' ? (
        <div className="fw-fp-choices" role="group" aria-label={check.label}>
          {check.choices.map((option) => (
            <FloorButton key={option} size="lg" block variant={option === draft.choice ? 'primary' : 'secondary'} aria-pressed={option === draft.choice} onClick={() => send({ type: 'valueChoice', value: option })}>
              {option}
            </FloorButton>
          ))}
        </div>
      ) : (
        <QuantityPad label={check.label} hideLabel value={draft.value} onChange={(value) => send({ type: 'valueNumber', value })} min={0} max={999_999} {...padWords(t, locale)} />
      )}
      <div className="fw-fp-verdict">
        <FloorButton size="lg" block variant="danger" icon={<X />} heldReason={why} onClick={() => send({ type: 'valueSave', outcome: 'FAIL' })}>
          {t('value.fail')}
        </FloorButton>
        <FloorButton size="lg" block variant="success" icon={<Check />} heldReason={why} onClick={() => send({ type: 'valueSave', outcome: 'PASS' })}>
          {t('value.pass')}
        </FloorButton>
      </div>
    </section>
  )
}

// ---- measurements --------------------------------------------------------------------------------------------------------------

/** A unit of measure in words: the catalogue's, else its code in small letters (never a key on screen). */
function unitWord(t: Translate, uom: string | null): string {
  if (!uom) return ''
  const key = `uom.${uom}`
  const word = t(key)
  return word === key ? uom.toLowerCase() : word
}

/** "58 ± 1 cm", "from the rider's profile: 61 cm · type the tolerance", "from the size chart: type both". */
function specWords(point: ChartPoint, t: Translate, locale: Locale): string {
  const n = (value: string) => formatNumber(Number(value), locale)
  const unit = unitWord(t, point.uom)
  if (point.source === 'PLAN' && point.nominal !== null && point.tolerance !== null) return t('measure.spec.plan', { nominal: n(point.nominal), tolerance: n(point.tolerance), unit })
  if (point.source === 'PROFILE' && point.nominal !== null) return t('measure.spec.profile', { nominal: n(point.nominal), unit })
  return t('measure.spec.chart')
}

function MeasureSection({ bench, held, send, t, locale }: { bench: BenchModel; held: string | null; send: (action: BenchAction) => void; t: Translate; locale: Locale }) {
  const { chart, counter } = bench.sheet
  if (bench.measure) {
    const point = chart.points.find((entry) => entry.pointCode === bench.measure!.pointCode)
    if (point) return <MeasureStep point={point} draft={bench.measure} sizes={bench.sizes} sample={counter.sampleSize} held={held} send={send} t={t} locale={locale} />
  }
  const mtm = chart.madeToMeasure
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fp-measure">
      <h2 id="fw-fp-measure" className="fw-floor-section-title">
        {t('section.measure')}
      </h2>
      {mtm ? (
        <TaskLine tone="info" icon={<Ruler />}>
          {t('measure.mtm', { revision: mtm.revision, size: mtm.size })}
          {mtm.pointsWithout.length > 0 ? ` ${t('measure.mtmWithout', { count: mtm.pointsWithout.length })}` : ''}
        </TaskLine>
      ) : null}
      <FloorList label={t('section.measure')}>
        {chart.points.map((point) => {
          const out = point.values.filter((value) => !value.pass).length
          return (
            <FloorListRow
              key={`${point.pointCode}:${point.size ?? ''}`}
              icon={<Ruler />}
              tone={out > 0 ? 'danger' : point.values.length > 0 ? 'success' : point.checkCode ? 'warning' : 'neutral'}
              title={point.label}
              meta={[specWords(point, t, locale), point.size ? t('measure.size', { size: point.size }) : null].filter(Boolean).join(' · ')}
              status={out > 0 ? t('measure.out', { count: out }) : point.values.length > 0 ? t('measure.in') : t('measure.notYet')}
              count={formatNumber(point.values.length, locale)}
              countLabel={t('measure.measured', { count: point.values.length, sample: counter.sampleSize })}
              onPress={held ? undefined : () => send({ type: 'measureOpen', pointCode: point.pointCode })}
            />
          )
        })}
      </FloorList>
      <TaskLine tone={chart.outOfTolerance > 0 ? 'danger' : 'info'} icon={<Ruler />}>
        {t('measure.summary', { out: chart.outOfTolerance, count: chart.values })}
      </TaskLine>
    </section>
  )
}

/** One point of measure per step (design floor.final "measure"): target ± tolerance, the pad with decimals, in or out in its tone. */
function MeasureStep({ point, draft, sizes, sample, send, t, locale }: { point: ChartPoint; draft: MeasureDraft; sizes: readonly string[]; sample: number; held: string | null; send: (action: BenchAction) => void; t: Translate; locale: Locale }) {
  const ds = useDsWords()
  const asks = pointAsks(point)
  const spec = specOf(point, draft)
  const waits = measureHeld(point, draft)
  const unit = unitWord(t, point.uom)
  const fieldValue = draft.field === 'nominal' ? draft.nominal : draft.field === 'tolerance' ? draft.tolerance : draft.value
  const values = point.values.filter((value) => draft.size === null || value.size === draft.size)
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fp-point">
      <h2 id="fw-fp-point" className="fw-floor-section-title">
        {point.label}
      </h2>
      <p className="fw-floor-lead">{[specWords(point, t, locale), t('measure.unit', { unit: draft.unit, sample })].join(' · ')}</p>
      {point.size === null && sizes.length > 1 ? (
        <div className="fw-fp-choices" role="group" aria-label={t('measure.whichSize')}>
          {sizes.map((size) => (
            <FloorButton key={size} size="md" variant={size === draft.size ? 'primary' : 'secondary'} aria-pressed={size === draft.size} onClick={() => send({ type: 'measureSize', size })}>
              {size}
            </FloorButton>
          ))}
        </div>
      ) : null}
      {asks.nominal || asks.tolerance ? (
        <div className="fw-fp-choices" role="group" aria-label={t('measure.fields')}>
          {(['nominal', 'tolerance', 'value'] as const)
            .filter((field) => field === 'value' || asks[field])
            .map((field) => {
              const value = field === 'nominal' ? draft.nominal : field === 'tolerance' ? draft.tolerance : draft.value
              return (
                <FloorButton key={field} size="md" variant={draft.field === field ? 'primary' : 'secondary'} aria-pressed={draft.field === field} onClick={() => send({ type: 'measureField', field })}>
                  {t(`measure.field.${field}`, { value: value === null ? '—' : formatNumber(value, locale) })}
                </FloorButton>
              )
            })}
        </div>
      ) : null}
      {/* The verdict first (in or out, in words), then the pad; Save is the action bar's main action (always in view). */}
      {spec.nominal !== null ? <LimitMeter label={point.label} value={draft.value} unit={unit || undefined} nominal={spec.nominal} tolerance={spec.tolerance ?? 0} locale={INTL_LOCALE[locale]} labels={ds.limitMeter} /> : null}
      {waits && waits !== 'value' ? <p className="fw-floor-muted">{t(`measure.held.${waits}`)}</p> : null}
      <QuantityPad label={t(`measure.field.${draft.field}`, { value: '' })} hideLabel unit={unit || undefined} value={fieldValue} onChange={(value) => send({ type: 'measureNumber', value })} min={0} max={99_999} decimals={3} decimalSeparator={locale === 'it' ? ',' : '.'} {...padWords(t, locale)} />
      {values.length > 0 ? (
        <ul className="fw-fp-values" aria-label={t('measure.values')}>
          {values.map((value) => (
            <li key={value.id} className="fw-fp-value" data-pass={String(value.pass)}>
              <span className="fw-floor-inline-icon" data-tone={value.pass ? 'success' : 'danger'} aria-hidden="true">
                {value.pass ? <CircleCheckBig /> : <CircleAlert />}
              </span>
              <span className="fw-fp-value-text">
                {t(value.pass ? 'measure.valueIn' : 'measure.valueOut', { unit: value.sampleIndex, size: value.size, measured: formatNumber(Number(value.measured), locale), nominal: formatNumber(Number(value.nominal), locale), tolerance: formatNumber(Number(value.tolerance), locale), uom: unit })}
              </span>
              <FloorButton size="md" variant="quiet" icon={<Undo2 />} onClick={() => send({ type: 'measureTakeBack', pointCode: point.pointCode, size: value.size, sampleIndex: value.sampleIndex })}>
                {t('measure.takeBack')}
              </FloorButton>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** The measure step's Save for the action bar: its words (within / out / save) and why it waits, or null when no point is open. */
export function measureSave(bench: BenchModel): { readonly verdict: 'PASS' | 'FAIL' | null; readonly waits: 'size' | 'nominal' | 'tolerance' | 'value' | null } | null {
  const draft = bench.measure
  const point = draft ? bench.sheet.chart.points.find((entry) => entry.pointCode === draft.pointCode) : null
  return draft && point ? { verdict: measureVerdict(point, draft), waits: measureHeld(point, draft) } : null
}

// ---- the serial or batch check -----------------------------------------------------------------------------------------------------

function SerialSection({ bench, held, send, t, camera }: { bench: BenchModel; held: string | null; send: (action: BenchAction) => void; t: Translate; camera?: CameraScanner }) {
  const { identity } = bench.sheet
  const line = identityLine(identity)
  const floor = useT('floor')
  const serial = identity.mode === 'SERIAL'
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fp-serial">
      <h2 id="fw-fp-serial" className="fw-floor-section-title">
        {t('section.serial')}
      </h2>
      <ScanInput
        label={serial ? t('serial.scanSerial') : t('serial.scanBatch', { batch: identity.batchNumber ?? '' })}
        hint={serial ? t('serial.hintSerial') : t('serial.hintBatch')}
        scannedLabel={(code) => t('serial.read', { code })}
        keyboardLabel={floor('scan.type')}
        disabled={Boolean(held)}
        camera={camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined}
        onScan={(code) => send({ type: 'serial', code })}
      />
      <TaskLine tone={line.tone} icon={line.tone === 'danger' ? <CircleAlert /> : line.tone === 'success' ? <CircleCheckBig /> : <ScanBarcode />}>
        {t(line.key, line.params)}
      </TaskLine>
      {serial ? (
        <div className="fw-fp-ticks" role="img" aria-label={t('serial.ticks', { matched: identity.matched, target: identity.target })}>
          {Array.from({ length: Math.min(identity.target, 60) }, (_, index) => (
            <span key={index} className="fw-fp-tick" data-done={String(index < identity.matched)} aria-hidden="true">
              {index < identity.matched ? <Check /> : null}
            </span>
          ))}
        </div>
      ) : null}
      <FloorButton size="lg" variant="secondary" icon={<ImageOff />} heldReason={held} onClick={() => send({ type: 'serial', code: null })}>
        {t('serial.noNumber')}
      </FloorButton>
      {identity.unknown.length > 0 ? (
        <section className="fw-floor-stack" aria-labelledby="fw-fp-unknown">
          <h3 id="fw-fp-unknown" className="fw-floor-subtitle">
            {t('serial.unknown', { count: identity.unknown.length })}
          </h3>
          <ul className="fw-fp-codes">
            {identity.unknown.map((code) => (
              <li key={code} className="fw-fp-code">
                <span className="fw-floor-code">{code}</span>
                <FloorButton size="md" variant="quiet" icon={<Undo2 />} heldReason={held} onClick={() => send({ type: 'serialRemove', code })}>
                  {t('serial.takeBack')}
                </FloorButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {identity.noNumber > 0 ? (
        <div className="fw-fp-code">
          <span>{t('serial.noNumberCount', { count: identity.noNumber })}</span>
          <FloorButton size="md" variant="quiet" icon={<Undo2 />} heldReason={held} onClick={() => send({ type: 'serialRemove', code: 'NO_NUMBER' })}>
            {t('serial.takeBack')}
          </FloorButton>
        </div>
      ) : null}
      {serial && identity.missing.length > 0 ? (
        <p className="fw-floor-muted">
          {t('serial.missing', { count: identity.missingCount })} <span className="fw-floor-code">{identity.missing.slice(0, 12).join(', ')}</span>
          {identity.missingCount > 12 ? ` ${t('serial.andMore', { count: identity.missingCount - 12 })}` : ''}
        </p>
      ) : null}
    </section>
  )
}

// ---- the photo set ---------------------------------------------------------------------------------------------------------------

function PhotoSection({ bench, held, online, send, t, locale }: { bench: BenchModel; held: string | null; online: boolean; send: (action: BenchAction) => void; t: Translate; locale: Locale }) {
  const targets = photoTargets(bench.sheet, locale)
  const why = held ?? (online ? null : t('photo.offline'))
  const open = bench.photo ? targets.find((target) => target.key === bench.photo) : null
  if (open) {
    return (
      <section className="fw-floor-stack" aria-labelledby="fw-fp-photo">
        <h2 id="fw-fp-photo" className="fw-floor-section-title">
          {open.label}
        </h2>
        <BenchPhoto label={open.label} markup={open.kind === 'result'} onCapture={(photo) => send({ type: 'photoTaken', photo })} onCancel={() => send({ type: 'close' })} heldReason={why} />
      </section>
    )
  }
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fp-photos">
      <h2 id="fw-fp-photos" className="fw-floor-section-title">
        {t('section.photos')}
      </h2>
      {bench.photoAdded ? (
        <TaskLine tone="success" icon={<CircleCheckBig />}>
          {t('photo.added', { slot: bench.photoAdded })}
        </TaskLine>
      ) : null}
      {why ? (
        <TaskLine tone="warning" icon={<CloudOff />}>
          {why}
        </TaskLine>
      ) : null}
      <FloorTileGrid label={t('section.photos')} columns={2}>
        {targets.map((target) => (
          <FloorTile
            key={target.key}
            icon={target.state === 'TAKEN' ? <CircleCheckBig /> : target.state === 'NOT_APPLICABLE' ? <CircleMinus /> : <Camera />}
            label={target.label}
            hint={target.kind === 'result' ? t('photo.forResult') : t(`photo.state.${target.state}`, { count: target.photos })}
            count={target.photos > 0 ? formatNumber(target.photos, locale) : undefined}
            countLabel={target.photos > 0 ? t('photo.count', { count: target.photos }) : undefined}
            tone={target.state === 'TAKEN' ? 'success' : target.state === 'MISSING' ? 'warning' : 'neutral'}
            heldReason={why ?? (target.state === 'NOT_APPLICABLE' ? t('photo.notApplicable') : null)}
            onPress={() => send({ type: 'photoOpen', key: target.key })}
          />
        ))}
      </FloorTileGrid>
    </section>
  )
}

/** The DS PhotoCapture with its words (`photo-kit`, which the floor layout does not load), faces kept out of the picture. */
export function BenchPhoto({ label, markup, onCapture, onCancel, heldReason }: { label: string; markup: boolean; onCapture: (photo: CapturedPhoto) => void | Promise<void>; onCancel: () => void; heldReason?: string | null }) {
  return (
    <WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}>
      <Capture label={label} markup={markup} onCapture={onCapture} onCancel={onCancel} heldReason={heldReason ?? null} />
    </WithMessages>
  )
}

function Capture({ label, markup, onCapture, onCancel, heldReason }: { label: string; markup: boolean; onCapture: (photo: CapturedPhoto) => void | Promise<void>; onCancel: () => void; heldReason: string | null }) {
  const words = usePhotoWords()
  return <PhotoCapture label={label} markup={markup} guide="frame" facesHint onCapture={onCapture} onCancel={onCancel} heldReason={heldReason} words={words} />
}

function padWords(t: Translate, locale: Locale) {
  return {
    decrementLabel: t('pad.less'),
    incrementLabel: t('pad.more'),
    clearLabel: t('pad.clear'),
    backLabel: t('pad.back'),
    emptyLabel: t('pad.empty'),
    rangeLabel: (min: number | undefined, max: number | undefined) => t('pad.range', { min: formatNumber(min ?? 0, locale), max: formatNumber(max ?? 0, locale) }),
  }
}

// ---- opening on the plan ----------------------------------------------------------------------------------------------------------

export interface PlanOpenModel {
  /** The plan that applies: code, version, name. */
  plan: { readonly code: string; readonly number: number; readonly name: string }
  lotSize: number
  /** The most the lot may be: the garments finished and not released. */
  maxLot: number
  /** The sample of the lot from the API (fixed, or B-W2b-93's AQL chain); null while it is read again. */
  sample: { readonly size: number; readonly letter: string | null; readonly level: string | null; readonly classes: readonly { defectClass: 'CRITICAL' | 'MAJOR' | 'MINOR'; aql: string; accept: number; reject: number }[] } | null
  /** The lot's pad is open. */
  editing: boolean
}

/** "FIN-JACKET v1 · Final jacket": the lot, its sample and the accept / reject numbers as the API gives them. */
export function PlanOpenBody({ open, onLot, onEdit }: { open: PlanOpenModel; onLot: (value: number) => void; onEdit: (editing: boolean) => void }) {
  const t = useT('floor-final-plan')
  const locale = useLocale()
  const number = (value: number) => formatNumber(value, locale)
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fp-open">
      <h2 id="fw-fp-open" className="fw-floor-section-title">
        {t('open.title')}
      </h2>
      <TaskCard
        icon={<ClipboardCheck />}
        type={t('open.plan')}
        code={`${open.plan.code} v${open.plan.number}`}
        big={open.sample ? { value: number(open.sample.size), label: t('open.sample') } : undefined}
        facts={[
          { label: t('open.name'), value: open.plan.name },
          { label: t('open.lot'), value: number(open.lotSize) },
          { label: t('open.letter'), value: open.sample?.letter ?? '—' },
          { label: t('open.level'), value: open.sample?.level ?? '—' },
        ]}
      />
      {open.sample ? (
        <ul className="fw-final-summary">
          {open.sample.classes.map((entry) => (
            <li key={entry.defectClass}>{t('open.class', { klass: t(`class.${entry.defectClass}`), aql: entry.aql, accept: entry.accept, reject: entry.reject })}</li>
          ))}
        </ul>
      ) : (
        <p className="fw-floor-muted">{t('open.reading')}</p>
      )}
      <p className="fw-floor-lead">{t('open.lead')}</p>
      <FloorButton size="lg" variant={open.editing ? 'primary' : 'secondary'} icon={<Hash />} aria-pressed={open.editing} onClick={() => onEdit(!open.editing)}>
        {t('open.lotButton', { count: open.lotSize })}
      </FloorButton>
      {open.editing ? <QuantityPad label={t('open.lot')} value={open.lotSize} onChange={(value) => (value === null ? undefined : onLot(value))} min={1} max={Math.max(1, open.maxLot)} onConfirm={() => onEdit(false)} confirmLabel={t('open.done')} autoFocus {...padWords(t, locale)} /> : null}
    </section>
  )
}

// ---- the signature on a plan -------------------------------------------------------------------------------------------------------

/** What the PIN signs: the plan, the sample counted, the checks, the defects per class, the values out, the serial check, the photos. */
export function BenchSummary({ sheet }: { sheet: Sheet }) {
  const t = useT('floor-final-plan')
  const line = identityLine(sheet.identity)
  const answered = sheet.checks.filter((check) => check.takesResult && !check.onChart && check.results.length > 0).length
  const asked = sheet.checks.filter((check) => check.takesResult && !check.onChart).length
  const verdict = verdictLine(sheet.counter)
  return (
    <ul className="fw-final-summary">
      <li>{t('head.plan', { code: sheet.plan.code, number: sheet.plan.number, name: sheet.plan.name })}</li>
      <li>{t('aql.of', { inspected: sheet.counter.inspected, sample: sheet.counter.sampleSize })}</li>
      {/* B-W2b-213: the counter's verdict before the decision, in words (the count is the inspection's own column). */}
      <li>
        <strong>{t(verdict.key, { ...verdict.params, ...(verdict.key === 'verdict.reject' ? { klass: t(`class.${verdict.params.klass}`) } : {}) })}</strong>
      </li>
      {asked > 0 ? <li>{t('sign.checks', { answered, asked })}</li> : null}
      <li>{sheet.counter.classes.map((entry) => t('sign.class', { klass: t(`class.${entry.defectClass}`), found: entry.found, accept: entry.accept })).join(' · ')}</li>
      {sheet.chart.points.length > 0 ? <li>{t('measure.summary', { out: sheet.chart.outOfTolerance, count: sheet.chart.values })}</li> : null}
      <li>{t(line.key, line.params)}</li>
      {sheet.photos.slots.length > 0 ? <li>{t('sign.photos', { taken: sheet.photos.slots.filter((slot) => slot.state === 'TAKEN').length, slots: sheet.photos.slots.length })}</li> : null}
    </ul>
  )
}

// ---- a code that leads to several open inspections ---------------------------------------------------------------------------------

export interface ChoiceModel {
  readonly id: string
  readonly number: string | null
  readonly words: string
}

export function ChooseBody({ code, choices, onPick }: { code: string; choices: readonly ChoiceModel[]; onPick: (id: string) => void }) {
  const t = useT('floor-final-plan')
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fp-choose">
      <h2 id="fw-fp-choose" className="fw-floor-section-title">
        {t('choose.title', { code })}
      </h2>
      <FloorList label={t('choose.title', { code })}>
        {choices.map((choice) => (
          <FloorListRow key={choice.id} icon={<ClipboardCheck />} tone="info" title={<span className="fw-floor-code">{choice.number ?? code}</span>} meta={choice.words} status={t('choose.open')} onPress={() => onPick(choice.id)} />
        ))}
      </FloorList>
    </section>
  )
}
