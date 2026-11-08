'use client'

import type { ReactNode } from 'react'
import {
  ArrowLeft,
  Check,
  CircleAlert,
  CircleCheckBig,
  CircleHelp,
  ClipboardCheck,
  CloudOff,
  Component,
  FileSignature,
  Gauge,
  House,
  Layers,
  ListChecks,
  Lock,
  Map as MapIcon,
  Minus,
  PackageSearch,
  Plus,
  RotateCcw,
  Ruler,
  ScanLine,
  ShieldCheck,
  ShieldX,
  Undo2,
} from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorChecklist, type FloorChecklistAnswer, type FloorChecklistGroup } from '@nexus/ui/floor/FloorChecklist/index'
import { PinSignBlock } from '@nexus/ui/components/PinSignBlock/index'
import { ProgressBar } from '@nexus/ui/components'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { checkWords, wayOf } from '../../shared/plan-checks'
import type { TaskProblem } from '../../shared/task-api'
import { MeasureStep } from '../../shared/view/MeasureStep'
import { ListFooter, ProblemState, TaskLine, Ticks, type PinProblem, type TickState } from '../../shared/view/TaskParts'
import type { IncomingRecord, OpenRow, ScanChoice } from '../api'
import {
  answerOf,
  areaDifference,
  checksLeft,
  COMPONENT_KINDS,
  componentHeld,
  componentSuggestion,
  decisionHeld,
  inspectedLines,
  isKnownRefusal,
  nextCandidates,
  numberOf,
  per100Of,
  pointsOf,
  PROTECTOR_TYPES,
  rollHeld,
  sampleOf,
  sampleProgress,
  sectionsOf,
  sectionState,
  tapHeld,
  wholeUnits,
  type ComponentDraft,
  type DecisionDraft,
  type DecisionHeld,
  type HideDraft,
  type MapTool,
  type RollDraft,
  type Section,
  type UnitDecision,
} from '../model'
import { HideMap, type MapMark } from './HideMap'
import '../incoming.css'

/**
 * SCR-175 — Incoming inspection on the floor (design floor.incoming; QHS-025, QHS-028, QHS-032 … QHS-034, QHS-036, QHS-065,
 * MES-054). Tablet first, one job per screen, glove-sized; words from codes and numbers, never the API's.
 *
 *   Scan the lot     a lot's label (our code, the supplier's lot, the dye batch), a hide tag or an inspection number opens the
 *                    inspection with its plan (or the open one); the site's open inspections below, a row opens it
 *   Sample           "Inspect 5 of 12 hides · 2 done" with its bar, the plan and how the sample was drawn
 *   Hide by hide     scan the next hide → shade tile → Accept (2 taps; Enter = Accept); grade, the area against the tannery's
 *                    (the difference in % big, in its tone), defect marks and grade zones on the HideMap; Reject in the body
 *   Fabric rolls     the tag or the supplier's number → 1- to 4-point counters, width and length → points per 100 sq yd against
 *                    the limit, accept or reject the roll
 *   Components       kind, a protector's type A or B and its EN 1621 certificate, the marking read, pieces looked at and not
 *                    right → the suggestion with its reasons → accept or reject the line
 *   Counter          a lot counted by the piece: units with a critical, major or minor defect against the plan's numbers
 *   Checks           the plan's checks: taps on the DS FloorChecklist, values on the shared measure step
 *   Decision         three pads that add up to the lot (a workshop: its bundles decide), held with every reason in words;
 *                    Sign → the PIN (DS PinSignBlock), online only
 * The view fetches nothing: the container (Incoming.tsx) reads and maps.
 */

export type ScanWrong = 'notFound' | 'otherFactory' | 'typo' | 'notOnTablet' | 'otherBench' | 'nothing' | 'label' | 'notOfLot' | 'notWhole' | 'sampleFull' | 'rollFull' | 'notRollLot'

export type PadKey = 'accepted' | 'rejected' | 'toSort'

interface PadWords {
  readonly decrementLabel: string
  readonly incrementLabel: string
  readonly clearLabel: string
  readonly backLabel: string
  readonly emptyLabel: string
  readonly rangeLabel: (min: number | undefined, max: number | undefined) => string
}

export type IncomingStep =
  | { readonly kind: 'noPermission' }
  | { readonly kind: 'scan'; readonly open: readonly OpenRow[] | null; readonly openFailed?: boolean; readonly wrong?: { readonly why: ScanWrong; readonly code: string } | null }
  | { readonly kind: 'loading'; readonly code: string }
  | { readonly kind: 'choose'; readonly code: string; readonly choices: readonly ScanChoice[] }
  | {
      readonly kind: 'record'
      readonly record: IncomingRecord
      readonly section: Section
      /** Read from this tablet's memory (offline): as of when. */
      readonly asOf: string | null
      readonly wrong?: { readonly why: ScanWrong; readonly code: string } | null
      readonly decision: DecisionDraft
      /** The pad whose digit keys are open (one at a time). */
      readonly pad?: PadKey | null
      readonly busy?: boolean
    }
  | { readonly kind: 'hide'; readonly record: IncomingRecord; readonly draft: HideDraft; readonly sub: 'main' | 'area' | 'map'; readonly tool: MapTool; readonly zoom: number; readonly cross: { readonly x: number; readonly y: number }; readonly busy?: boolean }
  | { readonly kind: 'roll'; readonly record: IncomingRecord; readonly draft: RollDraft; readonly sub: 'main' | 'width' | 'length'; readonly busy?: boolean }
  | { readonly kind: 'component'; readonly record: IncomingRecord; readonly draft: ComponentDraft; readonly busy?: boolean }
  | { readonly kind: 'measure'; readonly record: IncomingRecord; readonly checkId: string; readonly value: number | null; readonly choice: string | null; readonly busy?: boolean }
  | { readonly kind: 'sign'; readonly record: IncomingRecord; readonly draft: DecisionDraft; readonly busy?: boolean; readonly pin?: PinProblem }
  | { readonly kind: 'done'; readonly record: IncomingRecord }
  | { readonly kind: 'problem'; readonly problem: TaskProblem; readonly code: string | null }

/** What was just recorded, on top of the next step, with its ticks (saved here → recorded by the office). */
export interface DoneLine {
  readonly kind: 'hide' | 'hideRemoved' | 'roll' | 'component' | 'checks' | 'counter'
  readonly code: string
  readonly decision?: UnitDecision | null
  readonly ticks: TickState | null
}

export interface IncomingViewModel {
  readonly frame: FrameModel
  readonly online: boolean
  readonly step: IncomingStep
  readonly done?: DoneLine | null
  /** A write that did not go, under the step (a refusal, the network). */
  readonly notice?: TaskProblem | null
  /** The signer's name (the person signed in on the tablet). */
  readonly signer?: string
  /** Writes of the inspection on screen still kept on this tablet (the signature waits for them). */
  readonly waiting?: number
  readonly timeZone?: string
}

export type IncomingAction =
  | { type: 'scan'; code: string }
  | { type: 'openRow'; id: string }
  | { type: 'choose'; id: string }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'retry' }
  | { type: 'section'; section: Section }
  | { type: 'openHide'; hideId: string }
  | { type: 'shade'; id: string }
  | { type: 'grade'; id: string }
  | { type: 'hideSub'; sub: 'main' | 'area' | 'map' }
  | { type: 'area'; value: number | null }
  | { type: 'hideDecide'; decision: UnitDecision }
  | { type: 'hideRemove' }
  | { type: 'mapTool'; tool: 'defect' | 'zone' }
  | { type: 'mapDefect'; code: string }
  | { type: 'mapZone'; zone: string }
  | { type: 'mapTap'; x: number; y: number }
  | { type: 'mapCross'; x: number; y: number }
  | { type: 'mapZoom'; delta: 1 | -1 }
  | { type: 'mapClose' }
  | { type: 'mapRemove'; index: number }
  | { type: 'mapUndo' }
  | { type: 'openRoll'; code: string }
  | { type: 'rollCount'; index: 0 | 1 | 2 | 3; value: number }
  | { type: 'rollSub'; sub: 'main' | 'width' | 'length' }
  | { type: 'rollWidth'; value: number | null }
  | { type: 'rollLength'; value: number | null }
  | { type: 'rollDecide'; decision: UnitDecision }
  | { type: 'openComponent'; seq: number | null }
  | { type: 'componentKind'; kind: (typeof COMPONENT_KINDS)[number] }
  | { type: 'componentType'; value: (typeof PROTECTOR_TYPES)[number] }
  | { type: 'componentCertificate'; id: string | null }
  | { type: 'componentMarking'; ok: boolean }
  | { type: 'componentChecked'; value: number | null }
  | { type: 'componentDefective'; value: number | null }
  | { type: 'componentDecide'; decision: UnitDecision }
  | { type: 'counter'; klass: 'critical' | 'major' | 'minor'; value: number }
  | { type: 'checkPass'; id: string }
  | { type: 'checkFail'; id: string }
  | { type: 'checkPassGroup'; ids: readonly string[] }
  | { type: 'measure'; id: string }
  | { type: 'measureValue'; value: number | null }
  | { type: 'measureChoice'; value: string }
  | { type: 'measureSave'; outcome: 'PASS' | 'FAIL' }
  | { type: 'pad'; pad: PadKey; value: number | null }
  | { type: 'padOpen'; pad: PadKey | null }
  | { type: 'line'; id: string }
  | { type: 'decisionReset' }
  | { type: 'sign' }
  | { type: 'pin'; pin: string }
  | { type: 'next' }

export interface IncomingViewProps {
  model: IncomingViewModel
  onAction?: (action: IncomingAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const SECTION_ICON: Readonly<Record<Section, ReactNode>> = {
  hides: <MapIcon />,
  rolls: <Layers />,
  components: <Component />,
  counter: <Gauge />,
  checks: <ListChecks />,
  decision: <FileSignature />,
}

const STATE_TONE = { todo: 'neutral', partly: 'warning', done: 'success', failed: 'danger' } as const
const DECISION_TONE: Readonly<Record<UnitDecision, FloorTone>> = { ACCEPTED: 'success', REJECTED: 'danger', TO_SORT: 'warning' }
const CLASS_TONE = { CRITICAL: 'danger', MAJOR: 'warning', MINOR: 'info' } as const
const AREA_TONE = { WITHIN: 'success', SHORT: 'danger', OVER: 'warning' } as const

export function IncomingView({ model, onAction, onFrame, camera }: IncomingViewProps) {
  const t = useT('floor-incoming')
  const shared = useT('floor-tasks')
  const locale = useLocale()
  const ds = useDsWords()
  const send = (action: IncomingAction) => onAction?.(action)
  const { step, online } = model
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })
  const number: Num = (value, decimals = 4, fixed = false) => formatNumber(value, locale, fixed ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : { maximumFractionDigits: decimals })
  const refusal = (code: string) => (isKnownRefusal(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : { message: t('refusal.other.message'), fix: t('refusal.other.fix') })
  const label = (entry: { readonly labelIt: string; readonly labelEn: string }) => (locale === 'it' ? entry.labelIt || entry.labelEn : entry.labelEn || entry.labelIt)
  const unitWord = (uom: string, count: number) => (uom === 'HIDE' ? t('unit.hide', { count }) : uom === 'PCS' || uom === 'PC' || uom === 'PZ' ? t('unit.piece', { count }) : uom.toLowerCase())

  const home: FloorAction = { label: shared('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }
  const back: FloorAction = { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }
  const padWords: PadWords = {
    decrementLabel: t('pad.less'),
    incrementLabel: t('pad.more'),
    clearLabel: t('pad.clear'),
    backLabel: t('pad.back'),
    emptyLabel: t('pad.empty'),
    rangeLabel: (min: number | undefined, max: number | undefined) => t('pad.range', { min: min ?? 0, max: max ?? '' }),
  }

  const scanField = (labelText: string, hint: string) => (
    <ScanInput
      label={labelText}
      hint={hint}
      scannedLabel={(code) => t('scan.read', { code })}
      keyboardLabel={t('scan.type')}
      camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )

  const wrongLine = (wrong: { readonly why: ScanWrong; readonly code: string } | null | undefined) =>
    wrong ? (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {t(`scan.wrong.${wrong.why}`, { code: wrong.code })}
      </TaskLine>
    ) : null

  let actions: FloorActions | null = null
  let body: ReactNode = null

  switch (step.kind) {
    case 'noPermission':
      actions = [home]
      body = <FloorState tone="warning" icon={<Lock />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      break

    case 'problem':
      actions = [back, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }]
      body = <ProblemState problem={step.problem} code={step.code} words={refusal} />
      break

    case 'loading':
      actions = [back]
      body = (
        <p className="fw-floor-muted" aria-busy="true">
          {t('loading', { code: step.code })}
        </p>
      )
      break

    case 'scan': {
      actions = [home]
      const rows = step.open
      body = (
        <>
          {scanField(t('scan.lot.label'), t('scan.lot.hint'))}
          {wrongLine(step.wrong)}
          {!online ? (
            <TaskLine tone="warning" icon={<CloudOff />}>
              {t('scan.offline')}
            </TaskLine>
          ) : null}
          <section className="fw-floor-stack" aria-labelledby="fw-ii-open">
            <h2 id="fw-ii-open" className="fw-floor-section-title">
              {t('open.title')}
            </h2>
            {rows === null ? (
              <p className="fw-floor-muted" aria-busy="true">
                {t('open.loading')}
              </p>
            ) : step.openFailed ? (
              <TaskLine tone="warning" icon={<CloudOff />}>
                {t('open.failed')}
              </TaskLine>
            ) : rows.length === 0 ? (
              <p className="fw-floor-muted">{t('open.none')}</p>
            ) : (
              <>
                <FloorList label={t('open.title')}>
                  {rows.map((row) => (
                    <FloorListRow
                      key={row.id}
                      icon={<PackageSearch />}
                      tone={row.done > 0 ? 'warning' : 'neutral'}
                      title={
                        <>
                          <span className="fw-floor-code">{row.lot?.code ?? row.number}</span>
                          {row.item ? ` · ${row.item.name}` : row.receipt ? ` · ${t('open.workshop')}` : ''}
                        </>
                      }
                      meta={[row.number, t('open.since', { time: time(row.createdAt) })].join(' · ')}
                      status={row.done > 0 ? t('open.underWay') : t('open.toStart')}
                      count={`${row.done}/${row.sampleSize}`}
                      countLabel={t('open.countLabel', { done: row.done, sample: row.sampleSize })}
                      onPress={() => send({ type: 'openRow', id: row.id })}
                    />
                  ))}
                </FloorList>
                <ListFooter count={t('open.count', { count: rows.length })} keys={[{ key: t('keys.scan'), does: t('keys.scanDoes') }, { key: 'Esc', does: t('keys.home') }]} />
              </>
            )}
          </section>
        </>
      )
      break
    }

    case 'choose':
      actions = [back]
      body = (
        <section className="fw-floor-stack" aria-labelledby="fw-ii-choose">
          <h2 id="fw-ii-choose" className="fw-floor-section-title">
            {t('choose.title', { code: step.code })}
          </h2>
          <FloorList label={t('choose.title', { code: step.code })}>
            {step.choices.map((choice, index) => (
              <FloorListRow
                key={choice.id ?? index}
                icon={<PackageSearch />}
                title={choice.number ?? step.code}
                meta={t(choice.target === 'INCOMING' ? 'choose.incoming' : 'choose.otherBench')}
                heldReason={choice.target !== 'INCOMING' || !choice.id ? t('choose.held') : null}
                onPress={() => choice.id && send({ type: 'choose', id: choice.id })}
              />
            ))}
          </FloorList>
        </section>
      )
      break

    case 'record': {
      const { record } = step
      const sections = sectionsOf(record)
      const open = record.inspection.status === 'OPEN'
      const decisionReasons = decisionHeld(record, step.decision, { online, waiting: model.waiting ?? 0 })
      const signHeld = step.busy ? t('busy') : decisionReasons.length > 0 ? heldWords(decisionReasons[0]!, t, number, record) : null
      actions =
        step.section === 'decision'
          ? [back, { label: t('decision.sign'), icon: <FileSignature />, onPress: () => send({ type: 'sign' }), heldReason: signHeld, id: 'sign' }]
          : [back, { label: t('decision.go'), icon: <FileSignature />, onPress: () => send({ type: 'section', section: 'decision' }), variant: 'secondary' }]
      body = (
        <>
          <RecordCard record={record} asOf={step.asOf} t={t} number={number} unitWord={unitWord} time={time} locale={locale} />
          {!record.may.record && open ? (
            <TaskLine tone="warning" icon={<Lock />}>
              {t('notYours')}
            </TaskLine>
          ) : null}
          <div className="fw-ii-strip" role="group" aria-label={t('sections.label')}>
            {sections.map((section) => {
              const state = section === 'decision' ? null : sectionState(record, section)
              const current = section === step.section
              return (
                <FloorButton
                  key={section}
                  size="lg"
                  variant={current ? 'primary' : 'secondary'}
                  aria-pressed={current}
                  icon={SECTION_ICON[section]}
                  onClick={() => send({ type: 'section', section })}
                >
                  <span className="fw-ii-strip-name">{t(`section.${section}`)}</span>
                  {state ? (
                    <span className="fw-ii-strip-state" data-tone={STATE_TONE[state.state]}>
                      {state.of !== null && state.done !== null ? t('sections.of', { done: state.done, of: state.of }) : t(`sections.state.${state.state}`)}
                    </span>
                  ) : null}
                </FloorButton>
              )
            })}
          </div>
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
          <DoneStrip done={model.done ?? null} t={t} />
          {step.section === 'hides' ? <HidesSection record={record} wrong={wrongLine(step.wrong)} scan={scanField(t('hides.scan'), t('hides.scanHint'))} online={online} t={t} number={number} send={send} /> : null}
          {step.section === 'rolls' ? <RollsSection record={record} wrong={wrongLine(step.wrong)} scan={scanField(t('rolls.scan'), t('rolls.scanHint'))} online={online} t={t} number={number} send={send} /> : null}
          {step.section === 'components' ? <ComponentsSection record={record} online={online} t={t} send={send} /> : null}
          {step.section === 'counter' ? <CounterSection record={record} online={online} busy={step.busy ?? false} t={t} send={send} /> : null}
          {step.section === 'checks' ? <ChecksSection record={record} busy={step.busy ?? false} t={t} locale={locale} send={send} /> : null}
          {step.section === 'decision' ? <DecisionSection record={record} draft={step.decision} pad={step.pad ?? null} reasons={decisionReasons} t={t} number={number} unitWord={unitWord} locale={locale} padWords={padWords} send={send} /> : null}
        </>
      )
      break
    }

    case 'hide': {
      const { record, draft } = step
      const inSample = record.hides.some((hide) => hide.hideId === draft.hideId)
      const held = !record.may.record ? t('notYours') : step.busy ? t('busy') : null
      if (step.sub === 'area') {
        const tolerance = numberOf(record.areaCheck?.tolerancePercent ?? '2')
        const difference = areaDifference(draft, tolerance)
        actions = [{ label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'hideSub', sub: 'main' }), variant: 'secondary' }, { label: t('hide.area.use'), icon: <Check />, onPress: () => send({ type: 'hideSub', sub: 'main' }) }]
        body = (
          <section className="fw-floor-stack" aria-labelledby="fw-ii-area">
            <h2 id="fw-ii-area" className="fw-floor-section-title">
              {t('hide.area.title', { code: draft.code })}
            </h2>
            <p className="fw-floor-muted">{t('hide.area.declared', { area: number(draft.declaredArea, 2), uom: t(`areaUom.${draft.areaUom}`) })}</p>
            <QuantityPad label={t('hide.area.title', { code: draft.code })} hideLabel unit={t(`areaUom.${draft.areaUom}`)} value={draft.measuredArea} onChange={(value) => send({ type: 'area', value })} min={0} max={9_999} decimals={2} decimalSeparator={locale === 'it' ? ',' : '.'} {...padWords} />
            <AreaBig difference={difference} t={t} number={number} />
          </section>
        )
        break
      }
      if (step.sub === 'map') {
        actions = [{ label: t('map.done'), icon: <Check />, onPress: () => send({ type: 'hideSub', sub: 'main' }) }]
        body = <MapStep record={record} draft={draft} tool={step.tool} zoom={step.zoom} cross={step.cross} t={t} label={label} locale={locale} send={send} />
        break
      }
      const tolerance = numberOf(record.areaCheck?.tolerancePercent ?? '2')
      const difference = areaDifference(draft, tolerance)
      const defects = draft.marks.filter((mark) => mark.kind === 'DEFECT').length
      const zones = draft.marks.length - defects
      actions = [back, { label: t('hide.accept'), icon: <Check />, onPress: () => send({ type: 'hideDecide', decision: 'ACCEPTED' }), heldReason: held, variant: 'success', id: 'accept' }]
      body = (
        <>
          <FloorCard
            icon={<MapIcon />}
            kind={t('hide.kind')}
            code={draft.code}
            title={record.lot ? `${record.lot.code} · ${record.lot.item.name}` : undefined}
            status={{ label: inSample ? t('hide.inSample') : t('hide.newInSample'), tone: inSample ? 'info' : 'neutral' }}
            facts={[
              { id: 'area', label: t('hide.fact.area'), value: `${number(draft.declaredArea, 2)} ${t(`areaUom.${draft.areaUom}`)}` },
              { id: 'sample', label: t('hide.fact.sample'), value: t('sections.of', { done: record.hides.length, of: record.inspection.sampleSize }) },
            ]}
            headingLevel={2}
            labels={ds.floorCard}
          />
          <ChoiceRow
            label={t('hide.shade')}
            choices={record.choices.shadeGroups.map((group) => ({ id: group.id, label: group.outOfShade ? t('hide.outOfShade') : group.label, hint: group.swatchRef ?? undefined, tone: group.outOfShade ? 'warning' : undefined }))}
            value={draft.shadeGroupId}
            onPick={(id) => send({ type: 'shade', id })}
          />
          {record.choices.grades.length > 0 ? (
            <ChoiceRow label={t('hide.grade')} choices={record.choices.grades.map((grade) => ({ id: grade.id, label: grade.code, hint: label(grade) }))} value={draft.gradeId} onPick={(id) => send({ type: 'grade', id })} />
          ) : null}
          <FloorList label={t('hide.more')}>
            <FloorListRow
              icon={<Ruler />}
              tone={difference ? AREA_TONE[difference.outcome] : 'neutral'}
              title={t('hide.areaRow')}
              meta={draft.measuredArea === null ? t('hide.area.notMeasured') : t('hide.area.measured', { area: number(draft.measuredArea, 2), uom: t(`areaUom.${draft.areaUom}`) })}
              status={difference ? t(`area.${difference.outcome}`) : undefined}
              count={difference ? signed(difference.percent, number) : undefined}
              countLabel={difference ? t('area.percentLabel') : undefined}
              onPress={() => send({ type: 'hideSub', sub: 'area' })}
            />
            <FloorListRow
              icon={<MapIcon />}
              tone={defects > 0 ? 'warning' : 'neutral'}
              title={t('hide.mapRow')}
              meta={t('hide.mapMeta', { defects, zones })}
              count={draft.marks.length}
              countLabel={t('hide.mapCount', { count: draft.marks.length })}
              onPress={() => send({ type: 'hideSub', sub: 'map' })}
            />
          </FloorList>
          <div className="fw-ii-body-actions">
            <FloorButton size="lg" block variant="danger" icon={<ShieldX />} heldReason={held} onClick={() => send({ type: 'hideDecide', decision: 'REJECTED' })}>
              {t('hide.reject')}
            </FloorButton>
            {inSample ? (
              <FloorButton variant="quiet" icon={<Undo2 />} heldReason={held} onClick={() => send({ type: 'hideRemove' })}>
                {t('hide.remove')}
              </FloorButton>
            ) : null}
          </div>
          {!online ? (
            <TaskLine tone="info" icon={<CloudOff />}>
              {t('hide.offline')}
            </TaskLine>
          ) : null}
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
        </>
      )
      break
    }

    case 'roll': {
      const { record, draft } = step
      const held = !online ? t('online') : !record.may.record ? t('notYours') : step.busy ? t('busy') : rollHeld(draft) ? t(`roll.held.${rollHeld(draft)}`) : null
      if (step.sub === 'width' || step.sub === 'length') {
        const width = step.sub === 'width'
        actions = [{ label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'rollSub', sub: 'main' }), variant: 'secondary' }, { label: t('roll.use'), icon: <Check />, onPress: () => send({ type: 'rollSub', sub: 'main' }) }]
        body = (
          <section className="fw-floor-stack" aria-labelledby="fw-ii-roll-pad">
            <h2 id="fw-ii-roll-pad" className="fw-floor-section-title">
              {t(width ? 'roll.width' : 'roll.length')}
            </h2>
            <QuantityPad
              label={t(width ? 'roll.width' : 'roll.length')}
              hideLabel
              unit={width ? 'cm' : 'm'}
              value={width ? draft.widthCm : draft.lengthM}
              onChange={(value) => send(width ? { type: 'rollWidth', value } : { type: 'rollLength', value })}
              min={0}
              max={width ? 1_000 : 100_000}
              decimals={2}
              decimalSeparator={locale === 'it' ? ',' : '.'}
              {...padWords}
            />
          </section>
        )
        break
      }
      const per100 = per100Of(draft)
      const limit = numberOf(record.choices.fourPointLimit) || 40
      const over = per100 !== null && per100 > limit
      // The suggestion is the main action (Enter): accept within the limit, reject over it; the other one sits in the body.
      const suggested: UnitDecision = over ? 'REJECTED' : 'ACCEPTED'
      actions = [
        back,
        { label: t(over ? 'roll.reject' : 'roll.accept'), icon: over ? <ShieldX /> : <Check />, onPress: () => send({ type: 'rollDecide', decision: suggested }), heldReason: held, variant: over ? 'danger' : 'success', id: 'accept' },
      ]
      body = (
        <>
          <FloorCard
            icon={<Layers />}
            kind={draft.rollId ? t('roll.kindTag') : t('roll.kindSupplier')}
            code={draft.label}
            title={record.lot ? `${record.lot.code} · ${record.lot.item.name}` : undefined}
            facts={[
              { id: 'width', label: t('roll.width'), value: draft.widthCm ? `${number(draft.widthCm, 2)} cm` : t('roll.unknown') },
              { id: 'length', label: t('roll.length'), value: draft.lengthM ? `${number(draft.lengthM, 2)} m` : t('roll.unknown') },
              { id: 'points', label: t('roll.points'), value: number(pointsOf(draft.counts)) },
            ]}
            headingLevel={2}
            labels={ds.floorCard}
          />
          <div className="fw-ii-big" data-tone={per100 === null ? 'neutral' : over ? 'danger' : 'success'} role="status">
            <span className="fw-ii-big-value">{per100 === null ? '—' : number(per100, 2)}</span>
            <span className="fw-ii-big-label">{per100 === null ? t('roll.per100Unknown') : t(over ? 'roll.per100Over' : 'roll.per100Within', { limit: number(limit) })}</span>
          </div>
          <section className="fw-floor-stack" aria-labelledby="fw-ii-points">
            <h2 id="fw-ii-points" className="fw-floor-section-title">
              {t('roll.counters')}
            </h2>
            {([0, 1, 2, 3] as const).map((index) => (
              <CounterRow
                key={index}
                label={t(`roll.class.${index + 1}`)}
                hint={t(`roll.classHint.${index + 1}`)}
                value={draft.counts[index]}
                tone="neutral"
                held={!record.may.record ? t('notYours') : null}
                less={t('counter.less', { what: t(`roll.class.${index + 1}`) })}
                more={t('counter.more', { what: t(`roll.class.${index + 1}`) })}
                zero={t('counter.zero')}
                onChange={(value) => send({ type: 'rollCount', index, value })}
              />
            ))}
          </section>
          {draft.fromTag ? null : (
            <FloorList label={t('roll.size')}>
              <FloorListRow icon={<Ruler />} title={t('roll.width')} meta={draft.widthCm ? `${number(draft.widthCm, 2)} cm` : t('roll.unknown')} tone={draft.widthCm ? 'neutral' : 'warning'} onPress={() => send({ type: 'rollSub', sub: 'width' })} />
              <FloorListRow icon={<Ruler />} title={t('roll.length')} meta={draft.lengthM ? `${number(draft.lengthM, 2)} m` : t('roll.unknown')} tone={draft.lengthM ? 'neutral' : 'warning'} onPress={() => send({ type: 'rollSub', sub: 'length' })} />
            </FloorList>
          )}
          <FloorButton size="lg" block variant={over ? 'secondary' : 'danger'} icon={over ? <Check /> : <ShieldX />} heldReason={held} onClick={() => send({ type: 'rollDecide', decision: over ? 'ACCEPTED' : 'REJECTED' })}>
            {t(over ? 'roll.acceptAnyway' : 'roll.reject')}
          </FloorButton>
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
        </>
      )
      break
    }

    case 'component': {
      const { record, draft } = step
      const suggestion = componentSuggestion(draft)
      const why = componentHeld(draft)
      const held = !online ? t('online') : !record.may.record ? t('notYours') : step.busy ? t('busy') : why ? t(`component.held.${why}`) : null
      const main: UnitDecision = suggestion.suggested
      actions = [
        back,
        { label: t(main === 'ACCEPTED' ? 'component.accept' : 'component.rejectMain'), icon: main === 'ACCEPTED' ? <Check /> : <ShieldX />, onPress: () => send({ type: 'componentDecide', decision: main }), heldReason: held, variant: main === 'ACCEPTED' ? 'success' : 'danger', id: 'accept' },
      ]
      body = (
        <>
          <h2 className="fw-floor-section-title">{t('component.title', { seq: draft.seq })}</h2>
          <ChoiceRow label={t('component.kind')} choices={COMPONENT_KINDS.map((kind) => ({ id: kind, label: t(`componentKind.${kind}`) }))} value={draft.kind} onPick={(id) => send({ type: 'componentKind', kind: id as (typeof COMPONENT_KINDS)[number] })} />
          {draft.kind === 'PROTECTOR' ? (
            <>
              <ChoiceRow label={t('component.type')} choices={PROTECTOR_TYPES.map((type) => ({ id: type, label: t('component.typeName', { type }) }))} value={draft.protectorType} onPick={(id) => send({ type: 'componentType', value: id as (typeof PROTECTOR_TYPES)[number] })} />
              <ChoiceRow
                label={t('component.certificate')}
                wide
                choices={[
                  ...record.choices.certificates.map((certificate) => ({ id: certificate.id, label: certificate.number, hint: `${certificate.standard}${record.choices.coveringCertificate?.id === certificate.id ? ` · ${t('component.covers')}` : ''}` })),
                  { id: 'NONE', label: t('component.noCertificate'), tone: 'danger' as const },
                ]}
                value={draft.certificateId ?? 'NONE'}
                onPick={(id) => send({ type: 'componentCertificate', id: id === 'NONE' ? null : id })}
              />
              <ChoiceRow
                label={t('component.marking')}
                choices={[
                  { id: 'ok', label: t('component.markingOk'), held: draft.certificateId ? null : t('component.markingHeld') },
                  { id: 'no', label: t('component.markingNo'), tone: 'danger' as const },
                ]}
                value={draft.markingOk === true ? 'ok' : draft.markingOk === false ? 'no' : null}
                onPick={(id) => send({ type: 'componentMarking', ok: id === 'ok' })}
              />
            </>
          ) : null}
          <div className="fw-ii-pads">
            <QuantityPad label={t('component.checked')} value={draft.checked} onChange={(value) => send({ type: 'componentChecked', value })} min={1} max={100_000} quickValues={[record.inspection.sampleSize]} showPad={false} {...padWords} />
            <QuantityPad label={t('component.defective')} value={draft.defective} onChange={(value) => send({ type: 'componentDefective', value })} min={0} max={Math.max(1, draft.checked)} quickValues={[0, 1]} showPad={false} {...padWords} />
          </div>
          <TaskLine tone={suggestion.suggested === 'ACCEPTED' ? 'success' : 'danger'} icon={suggestion.suggested === 'ACCEPTED' ? <ShieldCheck /> : <ShieldX />}>
            {t(`component.suggested.${suggestion.suggested}`)}
            {suggestion.reasons.length > 0 ? ` ${suggestion.reasons.map((reason) => t(`component.reason.${reason}`, { defective: draft.defective, checked: draft.checked })).join(' ')}` : ''}
          </TaskLine>
          {main === 'ACCEPTED' ? (
            <FloorButton size="lg" block variant="danger" icon={<ShieldX />} heldReason={held} onClick={() => send({ type: 'componentDecide', decision: 'REJECTED' })}>
              {t('component.reject')}
            </FloorButton>
          ) : (
            <FloorButton size="lg" block variant="secondary" icon={<Check />} heldReason={held} onClick={() => send({ type: 'componentDecide', decision: 'ACCEPTED' })}>
              {t('component.acceptAnyway')}
            </FloorButton>
          )}
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
        </>
      )
      break
    }

    case 'measure': {
      const check = step.record.checks.find((entry) => entry.id === step.checkId)
      actions = [{ label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }]
      body = check ? (
        <MeasureStep
          id="fw-ii-measure"
          check={check}
          title={checkWords(check, locale)}
          value={step.value}
          choice={step.choice}
          busy={step.busy ?? false}
          locale={locale}
          words={{ savePass: t('measure.savePass'), saveFail: t('measure.saveFail'), pass: t('measure.pass'), fail: t('measure.fail'), held: t('measure.held'), busy: t('busy'), pad: padWords }}
          onValue={(value) => send({ type: 'measureValue', value })}
          onChoice={(value) => send({ type: 'measureChoice', value })}
          onSave={(outcome) => send({ type: 'measureSave', outcome })}
        />
      ) : null
      break
    }

    case 'sign': {
      const { record, draft } = step
      actions = null
      const lot = record.lot?.code ?? record.receipt?.order.number ?? record.inspection.number
      const quantities = { accepted: number(draft.accepted ?? 0), rejected: number(draft.rejected ?? 0), toSort: number(draft.toSort ?? 0), unit: unitWord(record.inspection.uom, 2) }
      body = (
        <div className="fw-ii-sign">
          <section className="fw-floor-stack" aria-labelledby="fw-ii-sign-title">
            <h2 id="fw-ii-sign-title" className="fw-floor-section-title">
              {t('sign.title')}
            </h2>
            <RecordCard record={record} asOf={null} t={t} number={number} unitWord={unitWord} time={time} locale={locale} />
            <p className="fw-floor-lead">{t(record.inspection.subject === 'WORKSHOP' ? 'sign.summaryWorkshop' : 'sign.summary', quantities)}</p>
            <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
          </section>
          <div className="fw-ii-sign-pin">
            <PinSignBlock
              meaning={t('sign.meaning', { number: record.inspection.number, lot, ...quantities })}
              signer={{ name: model.signer ?? '', detail: t('sign.detail') }}
              onSign={(pin) => send({ type: 'pin', pin })}
              onCancel={() => send({ type: 'back' })}
              state={step.busy ? 'busy' : 'idle'}
              heldReason={online ? null : t('online')}
              message={step.pin ? shared(`pin.problem.${step.pin}`) : undefined}
              messageTone={step.pin === 'wrong' || step.pin === 'locked' ? 'danger' : 'warning'}
              autoFocus
              labels={ds.pinSignBlock}
            />
          </div>
        </div>
      )
      break
    }

    case 'done': {
      const { record } = step
      const decision = record.inspection.decision
      actions = [home, { label: t('done.again'), icon: <ScanLine />, onPress: () => send({ type: 'next' }) }]
      const quantities = decision ? { accepted: number(numberOf(decision.accepted)), rejected: number(numberOf(decision.rejected)), toSort: number(numberOf(decision.toSort)), unit: unitWord(record.inspection.uom, 2) } : null
      const nextStep = record.next?.step ?? null
      body = (
        <FloorState tone={nextStep === 'RELEASE' ? 'success' : nextStep === 'REJECT' ? 'danger' : 'warning'} icon={nextStep === 'RELEASE' ? <CircleCheckBig /> : <ClipboardCheck />} title={t('done.title', { number: record.inspection.number })} text={quantities ? t('done.quantities', quantities) : undefined} alert>
          {record.inspection.subject === 'WORKSHOP' ? (
            <p className="fw-floor-state-text">{(record.next?.rejectedLines.length ?? 0) === 0 ? t('done.workshopAll') : t('done.workshop', { count: record.next!.rejectedLines.length, bundles: record.next!.rejectedLines.map((line) => line.bundleCode ?? t('decision.line', { seq: line.seq })).join(', ') })}</p>
          ) : nextStep ? (
            <p className="fw-floor-state-text">{t(`done.next.${nextStep}`, { lot: record.lot?.code ?? '' })}</p>
          ) : null}
          {(record.next?.rejectedHides.length ?? 0) > 0 ? <p className="fw-floor-muted">{t('done.rejectedHides', { codes: record.next!.rejectedHides.map((hide) => hide.code).join(', ') })}</p> : null}
          {(record.next?.rejectedRolls.length ?? 0) > 0 ? <p className="fw-floor-muted">{t('done.rejectedRolls', { codes: record.next!.rejectedRolls.map((roll) => roll.rollRef).join(', ') })}</p> : null}
          {record.inspection.signatureSha256 ? <p className="fw-floor-muted">{t('done.signed', { fingerprint: record.inspection.signatureSha256.slice(0, 12) })}</p> : null}
        </FloorState>
      )
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      <div className="fw-floor-stack fw-ii" id="fw-ii-flash">
        {step.kind === 'scan' ? <DoneStrip done={model.done ?? null} t={t} /> : null}
        {body}
      </div>
    </FloorFrameView>
  )
}

// ---- parts ------------------------------------------------------------------------------------------------------------------------

/** A number as written in the page's language: up to `decimals` decimals, exactly that many when `fixed`. */
type Num = (value: number, decimals?: number, fixed?: boolean) => string

const signed = (value: number, number: Num): string => `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value), 2, true)} %`

/** The lot, its sample and how far: the head of every step of an inspection (design sec:sample: FloorCard + ProgressBar). */
function RecordCard({ record, asOf, t, number, unitWord, time, locale }: { record: IncomingRecord; asOf: string | null; t: Translate; number: Num; unitWord: (uom: string, count: number) => string; time: (value: string) => string; locale: Locale }) {
  const ds = useDsWords()
  const sample = sampleOf(record)
  const progress = sampleProgress(sample)
  const decided = record.inspection.status === 'DECIDED'
  const resultTone: FloorTone = decided ? 'info' : record.result.resultNow === 'PASS' ? 'success' : 'danger'
  const sampleText =
    sample.kind === 'rolls'
      ? t('sample.rollsShort', { count: sample.sample, lot: number(sample.lot), uom: sample.uom.toLowerCase() })
      : sample.all
        ? t('sample.allShort', { lot: number(sample.lot), unit: unitWord(sample.uom, sample.lot) })
        : t('sample.short', { sample: number(sample.sample), lot: number(sample.lot), unit: unitWord(sample.uom, sample.lot) })
  const how = record.sampling.method === 'AQL' && record.sampling.plan ? t('sample.aqlShort', { level: record.sampling.plan.levelText, letter: record.sampling.plan.codeLetter ?? '—' }) : t(`sample.method.${record.sampling.method}`)
  const code = record.lot?.code ?? record.receipt?.order.number ?? record.inspection.number
  const what = record.lot ? [record.lot.item.name, record.lot.colour?.name, record.lot.dyeBatch ? t('head.dye', { dye: record.lot.dyeBatch }) : null] : record.receipt ? [t('head.workshop', { workOrder: record.receipt.workOrder.number })] : []
  return (
    <FloorCard
      icon={<PackageSearch />}
      kind={record.lot ? t('head.lot') : t('head.goodsBack')}
      code={code}
      title={[record.inspection.number, ...what].filter(Boolean).join(' · ')}
      status={{ label: decided ? t('head.decided') : record.inspection.status === 'CANCELLED' ? t('head.cancelled') : t(`result.${record.result.resultNow}`), tone: resultTone }}
      facts={[
        { id: 'sample', label: t('head.sample'), value: sampleText },
        ...(sample.done !== null ? [{ id: 'done', label: t('head.done'), value: t('sections.of', { done: sample.done, of: sample.sample }) }] : []),
        { id: 'plan', label: t('head.plan'), value: record.plan ? `${record.plan.code} v${record.plan.number}` : t('head.noPlan') },
        { id: 'how', label: t('head.how'), value: how },
      ]}
      asOf={asOf}
      formatTime={time}
      locale={INTL_LOCALE[locale]}
      headingLevel={2}
      labels={ds.floorCard}
    >
      {progress !== null ? (
        <div className="fw-ii-progress">
          <ProgressBar ariaLabel={t('head.progress', { done: sample.done ?? 0, of: sample.sample })} value={progress} tone={progress >= 100 ? 'complete' : progress > 0 ? 'partial' : 'missing'} height={10} />
        </div>
      ) : null}
      <ResultLine record={record} t={t} />
    </FloorCard>
  )
}

/** The result as it stands, in words from the counts (a critical defect never passes; a class over its accept number fails). */
function ResultLine({ record, t }: { record: IncomingRecord; t: Translate }) {
  if (record.inspection.status !== 'OPEN') return null
  const over = record.result.classes.filter((entry) => entry.state === 'reject')
  if (over.length === 0) return <p className="fw-floor-muted">{t('result.passing', { major: record.inspection.acceptMajor ?? record.inspection.sampleSize, minor: record.inspection.acceptMinor ?? record.inspection.sampleSize })}</p>
  return (
    <TaskLine tone="danger" icon={<ShieldX />}>
      {over.map((entry) => t(`result.over.${entry.defectClass}`, { count: entry.found, accept: entry.accept })).join(' ')}
    </TaskLine>
  )
}

function AreaBig({ difference, t, number }: { difference: { readonly percent: number; readonly outcome: 'WITHIN' | 'SHORT' | 'OVER' } | null; t: Translate; number: Num }) {
  return (
    <div className="fw-ii-big" data-tone={difference ? AREA_TONE[difference.outcome] : 'neutral'} role="status">
      <span className="fw-ii-big-value">{difference ? signed(difference.percent, number) : '—'}</span>
      <span className="fw-ii-big-label">{difference ? t(`area.${difference.outcome}`) : t('hide.area.typeIt')}</span>
    </div>
  )
}

function HidesSection({ record, wrong, scan, online, t, number, send }: { record: IncomingRecord; wrong: ReactNode; scan: ReactNode; online: boolean; t: Translate; number: Num; send: (action: IncomingAction) => void }) {
  const candidates = nextCandidates(record)
  const open = record.inspection.status === 'OPEN'
  const area = record.areaCheck
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-ii-hides">
      <h2 id="fw-ii-hides" className="fw-floor-section-title">
        {t('section.hides')}
      </h2>
      {open && record.may.record ? scan : null}
      {wrong}
      {area && area.outcome && area.differencePercent !== null ? (
        <TaskLine tone={AREA_TONE[area.outcome]} icon={<Ruler />}>
          {t('hides.lotArea', { count: area.hides, percent: signed(numberOf(area.differencePercent), number), tolerance: number(numberOf(area.tolerancePercent), 2) })} {t(`area.${area.outcome}`)}
          {area.opensClaim ? ` ${t('hides.claim')}` : ''}
        </TaskLine>
      ) : null}
      {record.hides.length === 0 ? (
        <p className="fw-floor-muted">{t('hides.none')}</p>
      ) : (
        <>
          <FloorList label={t('hides.sample')}>
            {record.hides.map((hide) => (
              <FloorListRow
                key={hide.hideId}
                icon={hide.decision === 'REJECTED' ? <ShieldX /> : hide.decision === 'ACCEPTED' ? <Check /> : <MapIcon />}
                tone={hide.decision ? DECISION_TONE[hide.decision] : 'warning'}
                title={<span className="fw-floor-code">{hide.code}</span>}
                meta={[
                  hide.shadeGroup ? (hide.shadeGroup.outOfShade ? t('hide.outOfShade') : t('hides.shade', { shade: hide.shadeGroup.label })) : t('hides.noShade'),
                  hide.grade ? t('hides.grade', { grade: hide.grade.code }) : null,
                  hide.areaCheck ? signed(numberOf(hide.areaCheck.differencePercent), number) : null,
                  hide.marks.length > 0 ? t('hides.marks', { count: hide.marks.length }) : null,
                  hide.worstClass ? t(`klass.${hide.worstClass}`) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                status={hide.decision ? t(`decision.word.${hide.decision}`) : t('decision.word.none')}
                onPress={open && record.may.record ? () => send({ type: 'openHide', hideId: hide.hideId }) : undefined}
              />
            ))}
          </FloorList>
          <ListFooter count={t('hides.count', { count: record.hides.length, sample: record.inspection.sampleSize })} keys={[{ key: t('keys.scan'), does: t('keys.hideDoes') }, { key: 'Enter', does: t('keys.accept') }, { key: 'Esc', does: t('keys.back') }]} />
        </>
      )}
      {open && record.may.record && candidates.length > 0 ? (
        <section className="fw-floor-stack" aria-labelledby="fw-ii-candidates">
          <h3 id="fw-ii-candidates" className="fw-floor-subtitle">
            {t('hides.candidates', { count: candidates.length })}
          </h3>
          <FloorList label={t('hides.candidates', { count: candidates.length })}>
            {candidates.slice(0, 8).map((candidate) => (
              <FloorListRow key={candidate.hideId} icon={<MapIcon />} title={<span className="fw-floor-code">{candidate.code}</span>} meta={`${number(numberOf(candidate.area), 2)} ${t(`areaUom.${candidate.areaUom}`)}`} onPress={() => send({ type: 'openHide', hideId: candidate.hideId })} />
            ))}
          </FloorList>
        </section>
      ) : null}
      {!online ? (
        <TaskLine tone="info" icon={<CloudOff />}>
          {t('hide.offline')}
        </TaskLine>
      ) : null}
    </section>
  )
}

function RollsSection({ record, wrong, scan, online, t, number, send }: { record: IncomingRecord; wrong: ReactNode; scan: ReactNode; online: boolean; t: Translate; number: Num; send: (action: IncomingAction) => void }) {
  const open = record.inspection.status === 'OPEN'
  const summary = record.rollSummary
  const limit = numberOf(record.choices.fourPointLimit) || 40
  const free = record.rollCandidates.filter((candidate) => !record.rolls.some((roll) => roll.roll?.id === candidate.rollId))
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-ii-rolls">
      <h2 id="fw-ii-rolls" className="fw-floor-section-title">
        {t('section.rolls')}
      </h2>
      {open && record.may.record ? (online ? scan : <TaskLine tone="warning" icon={<CloudOff />}>{t('online')}</TaskLine>) : null}
      {wrong}
      {summary.rolls > 0 && summary.pointsPer100SqYd !== null ? (
        <TaskLine tone={summary.over > 0 ? 'warning' : 'success'} icon={<Gauge />}>
          {t('rolls.summary', { count: summary.rolls, length: number(numberOf(summary.lengthM), 2), per100: number(numberOf(summary.pointsPer100SqYd), 2), limit: number(limit) })}
          {summary.over > 0 ? ` ${t('rolls.over', { count: summary.over })}` : ''}
        </TaskLine>
      ) : (
        <p className="fw-floor-muted">{t('rolls.none')}</p>
      )}
      {record.rolls.length > 0 ? (
        <FloorList label={t('rolls.sample')}>
          {record.rolls.map((roll) => (
            <FloorListRow
              key={roll.id}
              icon={<Layers />}
              tone={roll.decision ? DECISION_TONE[roll.decision] : roll.verdict.over ? 'danger' : 'warning'}
              title={<span className="fw-floor-code">{roll.roll?.code ?? roll.rollRef}</span>}
              meta={t('rolls.meta', { width: number(numberOf(roll.widthCm), 2), length: number(numberOf(roll.lengthM), 2), points: roll.points, per100: number(numberOf(roll.pointsPer100SqYd), 2) })}
              status={roll.decision ? t(`decision.word.${roll.decision}`) : t(roll.verdict.over ? 'rolls.suggestReject' : 'rolls.suggestAccept')}
              onPress={open && record.may.record && online ? () => send({ type: 'openRoll', code: roll.roll?.code ?? roll.rollRef }) : undefined}
            />
          ))}
        </FloorList>
      ) : null}
      {open && record.may.record && online && free.length > 0 && record.rolls.length < record.inspection.sampleSize ? (
        <section className="fw-floor-stack" aria-labelledby="fw-ii-roll-tags">
          <h3 id="fw-ii-roll-tags" className="fw-floor-subtitle">
            {t('rolls.candidates', { count: free.length })}
          </h3>
          <FloorList label={t('rolls.candidates', { count: free.length })}>
            {free.slice(0, 8).map((candidate) => (
              <FloorListRow key={candidate.rollId} icon={<Layers />} title={<span className="fw-floor-code">{candidate.code}</span>} meta={`${number(numberOf(candidate.length), 2)} ${candidate.uom.toLowerCase()}${candidate.widthCm ? ` · ${number(numberOf(candidate.widthCm), 2)} cm` : ''}`} onPress={() => send({ type: 'openRoll', code: candidate.code })} />
            ))}
          </FloorList>
        </section>
      ) : null}
    </section>
  )
}

function ComponentsSection({ record, online, t, send }: { record: IncomingRecord; online: boolean; t: Translate; send: (action: IncomingAction) => void }) {
  const open = record.inspection.status === 'OPEN'
  const held = !online ? t('online') : !record.may.record ? t('notYours') : null
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-ii-components">
      <h2 id="fw-ii-components" className="fw-floor-section-title">
        {t('section.components')}
      </h2>
      <p className="fw-floor-muted">{t('components.hint')}</p>
      {record.components.length === 0 ? (
        <p className="fw-floor-muted">{t('components.none')}</p>
      ) : (
        <FloorList label={t('section.components')}>
          {record.components.map((line) => (
            <FloorListRow
              key={line.seq}
              icon={<Component />}
              tone={line.decision ? DECISION_TONE[line.decision] : line.suggested === 'REJECTED' ? 'danger' : 'warning'}
              title={t('components.line', { seq: line.seq, kind: t(`componentKind.${line.kind}`) })}
              meta={[
                line.protectorType ? t('component.typeName', { type: line.protectorType }) : null,
                line.certificate ? `${line.certificate.number} · ${t(`certificate.${line.certificateCheck.state}`)}` : line.kind === 'PROTECTOR' ? t('certificate.MISSING') : null,
                t('components.pieces', { checked: line.checkedQuantity, defective: line.defectiveQuantity }),
              ]
                .filter(Boolean)
                .join(' · ')}
              status={line.decision ? t(`decision.word.${line.decision}`) : t(`component.suggested.${line.suggested}`)}
              onPress={open && !held ? () => send({ type: 'openComponent', seq: line.seq }) : undefined}
            />
          ))}
        </FloorList>
      )}
      {open ? (
        <FloorButton size="lg" variant="secondary" icon={<Plus />} heldReason={held} onClick={() => send({ type: 'openComponent', seq: null })}>
          {t('components.add')}
        </FloorButton>
      ) : null}
    </section>
  )
}

function CounterRow({ label, hint, value, tone, held, less, more, zero, onChange }: { label: string; hint: string; value: number; tone: FloorTone; held: string | null; less: string; more: string; zero: string; onChange: (value: number) => void }) {
  return (
    <div className="fw-ii-counter" data-tone={tone}>
      <span className="fw-ii-counter-text">
        <span className="fw-ii-counter-label">{label}</span>
        <span className="fw-floor-muted">{hint}</span>
      </span>
      <FloorButton size="lg" variant="secondary" icon={<Minus />} aria-label={less} heldReason={held ?? (value <= 0 ? zero : null)} onClick={() => onChange(Math.max(0, value - 1))} />
      <span className="fw-ii-counter-value" aria-live="polite" aria-label={`${label}: ${value}`}>
        {value}
      </span>
      <FloorButton size="lg" variant="secondary" icon={<Plus />} aria-label={more} heldReason={held} onClick={() => onChange(value + 1)} />
    </div>
  )
}

function CounterSection({ record, online, busy, t, send }: { record: IncomingRecord; online: boolean; busy: boolean; t: Translate; send: (action: IncomingAction) => void }) {
  const open = record.inspection.status === 'OPEN'
  const held = !open ? t('notOpen') : !online ? t('online') : !record.may.record ? t('notYours') : busy ? t('busy') : null
  const found = record.inspection.found
  const accept = { critical: 0, major: record.inspection.acceptMajor ?? record.inspection.sampleSize, minor: record.inspection.acceptMinor ?? record.inspection.sampleSize }
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-ii-counter">
      <h2 id="fw-ii-counter" className="fw-floor-section-title">
        {t('section.counter')}
      </h2>
      <p className="fw-floor-muted">{t('counter.hint', { sample: record.inspection.sampleSize })}</p>
      {(['critical', 'major', 'minor'] as const).map((klass) => (
        <CounterRow
          key={klass}
          label={t(`klass.${klass.toUpperCase()}`)}
          hint={klass === 'critical' ? t('counter.criticalHint') : t('counter.acceptHint', { accept: accept[klass], reject: accept[klass] + 1 })}
          value={found[klass]}
          tone={found[klass] > accept[klass] ? 'danger' : found[klass] === accept[klass] && found[klass] > 0 ? 'warning' : 'neutral'}
          held={held}
          less={t('counter.less', { what: t(`klass.${klass.toUpperCase()}`) })}
          more={t('counter.more', { what: t(`klass.${klass.toUpperCase()}`) })}
          zero={t('counter.zero')}
          onChange={(value) => send({ type: 'counter', klass, value: Math.min(value, record.inspection.sampleSize) })}
        />
      ))}
    </section>
  )
}

function ChecksSection({ record, busy, t, locale, send }: { record: IncomingRecord; busy: boolean; t: Translate; locale: Locale; send: (action: IncomingAction) => void }) {
  const ds = useDsWords()
  const reasonWords = useReasonWords()
  const open = record.inspection.status === 'OPEN'
  const taps = record.checks.filter((check) => wayOf(check) === 'tap')
  const values = record.checks.filter((check) => wayOf(check) === 'value')
  const reads = record.checks.filter((check) => wayOf(check) === 'read')
  const office = record.checks.filter((check) => wayOf(check) === 'office')
  const classes = [...new Set(taps.map((check) => check.checkClass ?? 'OTHER'))]
  const groups: FloorChecklistGroup[] = classes.map((klass) => ({
    id: klass,
    label: t(`checkClass.${klass}`),
    items: taps.filter((check) => (check.checkClass ?? 'OTHER') === klass).map((check) => ({ id: check.id, label: checkWords(check, locale), hint: check.mandatory ? undefined : t('checks.optional'), required: check.mandatory })),
  }))
  const answers: Record<string, FloorChecklistAnswer> = {}
  for (const check of taps) {
    const answer = answerOf(check)
    if (answer && answer.outcome !== 'NOT_APPLICABLE') answers[check.id] = { result: answer.outcome === 'PASS' ? 'pass' : 'fail' }
  }
  const held = !open ? t('notOpen') : !record.may.record ? t('notYours') : busy ? t('busy') : null
  const left = checksLeft(record.checks).length
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-ii-checks">
      <h2 id="fw-ii-checks" className="fw-floor-section-title">
        {t('section.checks')}
      </h2>
      {left > 0 ? (
        <TaskLine tone="warning" icon={<CircleAlert />}>
          {t('checks.left', { count: left })}
        </TaskLine>
      ) : null}
      {groups.length > 0 ? (
        <FloorChecklist
          groups={groups}
          answers={answers}
          onPass={(id) => send({ type: 'checkPass', id })}
          onFail={(id) => send({ type: 'checkFail', id })}
          onPassGroup={(_group, ids) => send({ type: 'checkPassGroup', ids })}
          heldReason={held}
          title={t('checks.taps')}
          labels={ds.floorChecklist}
          reasonWords={reasonWords}
          locale={INTL_LOCALE[locale]}
        />
      ) : null}
      {values.length > 0 ? (
        <FloorList label={t('checks.values')}>
          {values.map((check) => {
            const answer = answerOf(check)
            return (
              <FloorListRow
                key={check.id}
                icon={<Ruler />}
                tone={answer ? (answer.outcome === 'PASS' ? 'success' : answer.outcome === 'FAIL' ? 'danger' : 'neutral') : check.mandatory ? 'warning' : 'neutral'}
                title={checkWords(check, locale)}
                meta={[
                  check.nominal !== null ? t('checks.nominal', { nominal: check.nominal, tolerance: check.tolerance ?? '0', uom: check.uom ?? '' }) : check.type === 'CHOICE' ? t('checks.choice', { count: check.choices.length }) : null,
                  answer ? t(`checks.result.${answer.outcome}`, { value: answer.value ?? '' }) : check.mandatory ? t('checks.toDo') : t('checks.optional'),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onPress={held ? undefined : () => send({ type: 'measure', id: check.id })}
              />
            )
          })}
        </FloorList>
      ) : null}
      {office.map((check) => (
        <TaskLine key={check.id} tone="info" icon={<CircleHelp />}>
          {t('checks.office', { check: checkWords(check, locale) })}
        </TaskLine>
      ))}
      {reads.map((check) => (
        <TaskLine key={check.id} tone="info" icon={<ClipboardCheck />}>
          {checkWords(check, locale)}
        </TaskLine>
      ))}
    </section>
  )
}

/** The words of one reason that holds Sign (the first is the button's; all are listed above the pads). */
function heldWords(reason: DecisionHeld, t: Translate, number: Num, record: IncomingRecord): string {
  switch (reason.key) {
    case 'sum':
      return t('held.sum', { lot: number(reason.lot), sum: number(reason.sum) })
    case 'hidesUndecided':
      return t('held.hidesUndecided', { count: reason.codes.length, codes: reason.codes.slice(0, 4).join(', ') })
    case 'rollsUndecided':
    case 'componentsUndecided':
    case 'waiting':
    case 'mandatory':
      return t(`held.${reason.key}`, { count: reason.count })
    case 'below':
      return t(`held.below.${reason.pad}`, { min: number(reason.min) })
    case 'outsideBeforeWhole':
      return t(record.inspection.byRoll ? 'held.outsideBeforeWholeRolls' : 'held.outsideBeforeWhole', { done: reason.done, sample: reason.sample })
    case 'failedSplit':
      return t('held.failedSplit', { accepted: reason.accepted })
    case 'override':
      return t(`held.override.${reason.result}`)
    default:
      return t(`held.${reason.key}`)
  }
}

function DecisionSection({
  record,
  draft,
  pad,
  reasons,
  t,
  number,
  unitWord,
  locale,
  padWords,
  send,
}: {
  record: IncomingRecord
  draft: DecisionDraft
  pad: PadKey | null
  reasons: readonly DecisionHeld[]
  t: Translate
  number: Num
  unitWord: (uom: string, count: number) => string
  locale: Locale
  padWords: PadWords
  send: (action: IncomingAction) => void
}) {
  const lot = numberOf(record.inspection.lotSize)
  const open = record.inspection.status === 'OPEN'
  const workshop = record.inspection.subject === 'WORKSHOP'
  const decimals = wholeUnits(record.inspection.uom) ? 0 : 2
  const unit = unitWord(record.inspection.uom, 2)
  const sum = (draft.accepted ?? 0) + (draft.rejected ?? 0) + (draft.toSort ?? 0)
  const words = padWords
  const padOf = (key: PadKey) => (
    <div key={key} className="fw-ii-pad" data-open={pad === key ? 'true' : 'false'}>
      <QuantityPad
        label={t(`decision.${key}`)}
        unit={unit}
        value={draft[key]}
        onChange={(value) => send({ type: 'pad', pad: key, value })}
        min={0}
        max={lot}
        decimals={decimals}
        decimalSeparator={locale === 'it' ? ',' : '.'}
        quickValues={[{ value: Math.max(0, Math.round((lot - sum + (draft[key] ?? 0)) * 10_000) / 10_000), label: t('decision.rest') }]}
        showPad={pad === key}
        {...words}
      />
      <FloorButton variant="quiet" icon={<ListChecks />} aria-pressed={pad === key} onClick={() => send({ type: 'padOpen', pad: pad === key ? null : key })}>
        {pad === key ? t('decision.closeDigits') : t('decision.digits')}
      </FloorButton>
    </div>
  )
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-ii-decision">
      <h2 id="fw-ii-decision" className="fw-floor-section-title">
        {t('section.decision')}
      </h2>
      {!open ? <p className="fw-floor-muted">{t('notOpen')}</p> : null}
      {workshop && record.receipt ? (
        <>
          <p className="fw-floor-muted">{t('decision.workshopHint')}</p>
          <FloorTileGrid label={t('decision.bundles')}>
            {inspectedLines(record.receipt.lines).map((line) => {
              const rejected = draft.rejectedLines.includes(line.id)
              return (
                <FloorTile
                  key={line.id}
                  icon={rejected ? <ShieldX /> : <Check />}
                  label={line.bundle?.code ?? t('decision.line', { seq: line.seq })}
                  hint={`${rejected ? t('decision.lineRejected') : t('decision.lineKept')} · ${t('decision.lineHint', { op: line.operation.code, good: line.good, defective: line.defective })}`}
                  tone={rejected ? 'danger' : 'success'}
                  count={line.good + line.defective}
                  countLabel={t('unit.piece', { count: line.good + line.defective })}
                  current={rejected}
                  heldReason={open ? null : t('notOpen')}
                  onPress={() => send({ type: 'line', id: line.id })}
                />
              )
            })}
          </FloorTileGrid>
          <p className="fw-floor-lead">{t('sign.summaryWorkshop', { accepted: number(draft.accepted ?? 0), rejected: number(draft.rejected ?? 0), toSort: '0', unit })}</p>
        </>
      ) : (
        <>
          <p className="fw-floor-muted">{t('decision.hint', { lot: number(lot), unit })}</p>
          <div className="fw-ii-pads">{(['accepted', 'rejected', 'toSort'] as const).map(padOf)}</div>
          <div className="fw-ii-sum" data-tone={Math.abs(sum - lot) < 0.00005 ? 'success' : 'warning'} role="status">
            {t('decision.sum', { sum: number(sum, decimals), lot: number(lot, decimals), unit })}
          </div>
          <FloorButton variant="quiet" icon={<RotateCcw />} onClick={() => send({ type: 'decisionReset' })}>
            {t('decision.reset')}
          </FloorButton>
        </>
      )}
      {open && reasons.length > 0 ? (
        <ul className="fw-ii-held" aria-label={t('decision.heldTitle')}>
          {reasons.map((reason, index) => (
            <li key={`${reason.key}-${index}`}>
              <TaskLine tone="warning" icon={<CircleAlert />}>
                {heldWords(reason, t, number, record)}
              </TaskLine>
            </li>
          ))}
        </ul>
      ) : open ? (
        <TaskLine tone="success" icon={<FileSignature />}>
          {t('decision.ready')}
        </TaskLine>
      ) : null}
    </section>
  )
}

/** The HideMap with what a tap places: a defect of the library (by class), or a grade zone drawn point by point. */
function MapStep({
  record,
  draft,
  tool,
  zoom,
  cross,
  t,
  label,
  locale,
  send,
}: {
  record: IncomingRecord
  draft: HideDraft
  tool: MapTool
  zoom: number
  cross: { readonly x: number; readonly y: number }
  t: Translate
  label: (entry: { readonly labelIt: string; readonly labelEn: string }) => string
  locale: Locale
  send: (action: IncomingAction) => void
}) {
  const defects = new Map(record.choices.hideDefects.map((defect) => [defect.code, defect]))
  const grades = record.choices.grades
  const gradeTone = (zone: string | null | undefined): FloorTone => {
    const index = grades.findIndex((grade) => grade.code === zone)
    return index <= 0 ? 'success' : index === 1 ? 'warning' : 'danger'
  }
  let defectNo = 0
  const marks: MapMark[] = draft.marks.map((mark) => {
    if (mark.kind === 'DEFECT') {
      defectNo += 1
      const defect = mark.code ? defects.get(mark.code) : undefined
      return { kind: 'DEFECT', x: mark.x, y: mark.y, outline: [], label: defect ? label(defect) : (mark.code ?? ''), short: String(defectNo), tone: defect ? CLASS_TONE[defect.defectClass] : 'warning', detail: defect ? t(`klass.${defect.defectClass}`) : null }
    }
    const grade = grades.find((entry) => entry.code === mark.zone)
    return { kind: 'ZONE', x: mark.x, y: mark.y, outline: mark.outline ?? [], label: t('map.zoneName', { zone: mark.zone ?? '' }), short: mark.zone ?? '', tone: gradeTone(mark.zone), detail: grade ? t('map.usable', { share: formatNumber(numberOf(grade.usableShare), locale, { maximumFractionDigits: 2 }) }) : null }
  })
  const held = tapHeld(tool, draft.marks)
  const status = tool.kind === 'defect' ? (tool.code ? t('map.tapDefect', { defect: defects.get(tool.code) ? label(defects.get(tool.code)!) : tool.code }) : '') : tool.zone ? t('map.tapZone', { zone: tool.zone, count: tool.points.length }) : ''
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-ii-map-title">
      <h2 id="fw-ii-map-title" className="fw-floor-section-title">
        {t('map.title', { code: draft.code })}
      </h2>
      <div className="fw-ii-map-split">
        <div className="fw-ii-map-tools-col">
          <ChoiceRow
            label={t('map.tool')}
            choices={[
              { id: 'defect', label: t('map.defects'), icon: <CircleAlert /> },
              { id: 'zone', label: t('map.zones'), icon: <Layers />, held: grades.length === 0 ? t('map.noGrades') : null },
            ]}
            value={tool.kind}
            onPick={(id) => send({ type: 'mapTool', tool: id === 'zone' ? 'zone' : 'defect' })}
          />
          {tool.kind === 'defect' ? (
            record.choices.hideDefects.length === 0 ? (
              <TaskLine tone="info" icon={<CircleHelp />}>
                {t('map.noDefects')}
              </TaskLine>
            ) : (
              <ChoiceRow label={t('map.whichDefect')} choices={record.choices.hideDefects.map((defect) => ({ id: defect.code, label: label(defect), hint: t(`klass.${defect.defectClass}`), tone: defect.defectClass === 'CRITICAL' ? ('danger' as const) : undefined }))} value={tool.code} onPick={(code) => send({ type: 'mapDefect', code })} />
            )
          ) : (
            <>
              <ChoiceRow label={t('map.whichZone')} choices={grades.map((grade) => ({ id: grade.code, label: t('map.zoneName', { zone: grade.code }), hint: label(grade) }))} value={tool.zone} onPick={(zone) => send({ type: 'mapZone', zone })} />
              <FloorButton size="lg" block variant="success" icon={<Check />} heldReason={tool.points.length < 3 ? t('map.closeHeld', { count: tool.points.length }) : null} onClick={() => send({ type: 'mapClose' })}>
                {t('map.close')}
              </FloorButton>
            </>
          )}
        </div>
      <HideMap
        marks={marks}
        tool={tool}
        zoom={zoom}
        cross={cross}
        heldReason={held ? t(`map.held.${held}`) : null}
        words={{
          title: t('map.title', { code: draft.code }),
          status,
          zoomIn: t('map.zoomIn'),
          zoomOut: t('map.zoomOut'),
          zoomTop: t('map.zoomTop'),
          zoomBottom: t('map.zoomBottom'),
          zoom: (percent) => t('map.zoom', { percent }),
          undo: t('map.undo'),
          nothingToUndo: t('map.nothingToUndo'),
          remove: (what) => t('map.remove', { what }),
          removeShort: t('map.removeShort'),
          marks: t('map.marks'),
          noMarks: t('map.noMarks'),
          where: (across, down) => t('map.where', { across, down }),
          keysTitle: t('map.keysTitle'),
          keysTrigger: t('map.keysTrigger'),
          keys: [
            { key: '← ↑ → ↓', does: t('map.key.arrows') },
            { key: 'Enter', does: t('map.key.enter') },
            { key: '+ −', does: t('map.key.zoom') },
            { key: '⌫', does: t('map.key.undo') },
          ],
        }}
        onTap={(x, y) => send({ type: 'mapTap', x, y })}
        onCross={(x, y) => send({ type: 'mapCross', x, y })}
        onZoom={(delta) => send({ type: 'mapZoom', delta })}
        onRemove={(index) => send({ type: 'mapRemove', index })}
        onUndo={() => send({ type: 'mapUndo' })}
      />
      </div>
    </section>
  )
}

interface Choice {
  readonly id: string
  readonly label: string
  /** A second, smaller line (a swatch, a class, a standard). */
  readonly hint?: string
  readonly tone?: 'danger' | 'warning'
  readonly icon?: ReactNode
  readonly held?: string | null
}

/**
 * One choice as a row of pressed glove-sized buttons (shade, grade, kind, type, certificate, marking, defect, zone): composed of the
 * DS FloorButton (`aria-pressed`), the label above the row. The DS FloorReasonGrid's big tiles pushed the hide map and Accept below
 * the fold at 1024 × 768 (B-W2b-105 decided the same for its cause row).
 */
function ChoiceRow({ label, choices, value, onPick, wide }: { label: string; choices: readonly Choice[]; value: string | null; onPick: (id: string) => void; wide?: boolean }) {
  return (
    <div className="fw-ii-choice" role="group" aria-label={label}>
      <span className="fw-floor-subtitle">{label}</span>
      <div className="fw-ii-choice-grid" data-wide={wide ? 'true' : 'false'}>
        {choices.map((choice) => {
          const picked = value === choice.id
          return (
            <FloorButton
              key={choice.id}
              size="lg"
              block
              variant={picked ? (choice.tone === 'danger' ? 'danger' : choice.tone === 'warning' ? 'warning' : 'primary') : 'secondary'}
              aria-pressed={picked}
              icon={choice.icon ?? (picked ? <Check /> : undefined)}
              heldReason={choice.held ?? null}
              onClick={() => onPick(choice.id)}
            >
              <span className="fw-ii-choice-label">{choice.label}</span>
              {choice.hint ? <span className="fw-ii-choice-hint">{choice.hint}</span> : null}
            </FloorButton>
          )
        })}
      </div>
    </div>
  )
}

/** What was just recorded, with its ticks (saved here → recorded by the office). */
function DoneStrip({ done, t }: { done: DoneLine | null; t: Translate }) {
  if (!done) return null
  return (
    <div className="fw-floor-notice fw-ii-done" role="status" data-tone={done.decision === 'REJECTED' ? 'warning' : 'success'}>
      <span className="fw-floor-inline-icon" aria-hidden="true">
        {done.decision === 'REJECTED' ? <ShieldX /> : <CircleCheckBig />}
      </span>
      <span className="fw-ii-done-text">{t(`doneLine.${done.kind}`, { code: done.code, decision: done.decision ? t(`decision.word.${done.decision}`) : '' })}</span>
      {done.ticks ? <Ticks state={done.ticks} /> : null}
    </div>
  )
}

function Notice({ notice, refusal, t }: { notice: TaskProblem | null; refusal: (code: string) => { message: string; fix: string } | null; t: Translate }) {
  if (!notice) return null
  if (notice.kind === 'refused') {
    const own = refusal(notice.code)
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {own ? `${own.message} ${own.fix}` : ''}
      </TaskLine>
    )
  }
  const kind = notice.kind === 'stepUp' ? 'forbidden' : notice.kind
  return (
    <TaskLine tone={kind === 'offline' || kind === 'unavailable' ? 'warning' : 'danger'} icon={<CircleAlert />} alert>
      {t(`problem.${kind}.title`)}
    </TaskLine>
  )
}
