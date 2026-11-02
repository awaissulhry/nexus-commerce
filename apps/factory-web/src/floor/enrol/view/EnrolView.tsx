'use client'

import type { ReactNode } from 'react'
import { ArrowRight, Camera, Check, CircleAlert, CircleCheck, CircleHelp, Download, HardDrive, LogIn, Maximize, MonitorSmartphone, Pin, RotateCcw, ScanLine, Settings, ShieldCheck, Smartphone, Vibrate, Volume2, X } from 'lucide-react'
import { KIOSK_STEPS, type KioskHomeTest, type KioskRow, type KioskStepId } from '@nexus/factory-domain/auth/floor/kiosk'
import type { DeviceMode } from '@nexus/factory-domain/auth/floor/modes'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, ScanInput, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { LOCALE_NAMES, type Locale } from '../../../lib/i18n/locales'
import { useT } from '../../../lib/i18n/provider'
import type { FloorMode } from '../../model'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorFacts } from '../../frame/view/FloorFacts'
import { FloorState } from '../../frame/view/FloorState'

/**
 * SCR-020 — set up this tablet (design floor.enrol; PLT-056, PLT-227, PLT-236, MES-175, MES-183, MES-181, MES-186): scan the
 * one-time set-up code the office shows (camera or scanner; typing it is the other way), see what the tablet now is
 * (B-W2b-67: the mode the office chose), install it as an app and check its parts, lock it to the app (a station tablet,
 * a line tablet or a line board; never a person's own phone), then go to sign-in; a line board goes straight to its board.
 * A tablet that is set up already asks "Replace?" first.
 *
 * The office's code is traded for the device token in one call (POST /floor/device/enrol), so what the tablet becomes
 * is shown right after the trade, not before (the API has no preview of a code). The kiosk lock (B-W2b-67, PLT-227) is
 * four illustrated steps with an honest check: full screen and installed are ticks the tablet can give; Android does not
 * tell a web app whether it is pinned, so that row is what the person says after pressing Home, never a tick of the
 * tablet's. Skipping it is fine: Continue stays the main action. The DS has no FloorMediaSteps: `KioskSteps` composes it.
 */

export interface Binding {
  device: string
  site: string
  station: string | null
  mode: FloorMode | null
  language: Locale
  /** B-W2b-67: what the office chose it for (an older answer: a station tablet), and the line it shows. */
  deviceMode: DeviceMode
  line: string | null
  /** The kiosk lock step applies (never a person's own phone). */
  kiosk: boolean
}

export type EnrolProblem = 'codeInvalid' | 'offline' | 'unavailable' | 'rateLimited'

export interface InstallState {
  /** `available`: the browser offers the install; `installed`: running as the app; `manual`: the browser's menu. */
  app: 'available' | 'installed' | 'manual'
  /** Persistent storage (PLT-242): kept, refused, or not asked yet. */
  storage: 'kept' | 'notKept' | 'unknown'
}

export interface Checks {
  camera: 'ok' | 'missing'
  /** A label was scanned on this step. */
  scanner: 'ok' | 'waiting'
  sound: 'ok' | 'untested'
  vibration: 'ok' | 'missing'
}

export type EnrolStep =
  | { kind: 'scan'; problem?: EnrolProblem | null; busy?: boolean }
  | { kind: 'replace'; current: { device: string; station: string | null; site: string } }
  | { kind: 'binding'; binding: Binding }
  | { kind: 'install'; binding: Binding; install: InstallState; checks: Checks }
  | { kind: 'kiosk'; binding: Binding; check: KioskCheckView }
  | { kind: 'done'; binding: Binding }

/** The honest check on screen: the rows, and what the person said after pressing Home. */
export interface KioskCheckView {
  rows: readonly Pick<KioskRow, 'id' | 'state' | 'source'>[]
  homeTest: KioskHomeTest
}

export interface EnrolViewModel {
  step: EnrolStep
  frame: FrameModel
}

export type EnrolAction =
  | { type: 'code'; code: string }
  | { type: 'replace' }
  | { type: 'keep' }
  | { type: 'retry' }
  | { type: 'continue' }
  | { type: 'install' }
  | { type: 'keep-data' }
  | { type: 'test-sound' }
  | { type: 'sign-in' }
  | { type: 'home-test'; result: 'STAYED' | 'LEFT' }

export interface EnrolViewProps {
  model: EnrolViewModel
  onAction?: (action: EnrolAction) => void
  onFrame?: (action: FrameAction) => void
  /** The camera fallback (ZXing in the live page; none in the design index). */
  camera?: CameraScanner
}

const STEP_NO: Record<EnrolStep['kind'], number> = { scan: 1, replace: 1, binding: 2, install: 3, kiosk: 4, done: 5 }

/** Where the step sits: a phone has no kiosk step, so it is one step shorter. */
function stepOf(step: EnrolStep): { n: number; total: number } {
  const noKiosk = 'binding' in step && !step.binding.kiosk
  return { n: noKiosk && step.kind === 'done' ? 4 : STEP_NO[step.kind], total: noKiosk ? 4 : 5 }
}

export function EnrolView({ model, onAction, onFrame, camera }: EnrolViewProps) {
  const t = useT('floor')
  const { step } = model
  const send = (action: EnrolAction) => onAction?.(action)

  let body: ReactNode
  let actions: FloorActions | null = null
  switch (step.kind) {
    case 'scan':
      body = <ScanStep step={step} camera={camera} onCode={(code) => send({ type: 'code', code })} />
      if (step.problem) actions = [{ label: t('enrol.scanAgain'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }]
      break
    case 'replace':
      body = (
        <Section title={t('enrol.replace.title')} icon={<CircleAlert />}>
          <FloorFacts
            facts={[
              { label: t('enrol.replace.now'), value: [step.current.device, step.current.station, step.current.site].filter(Boolean).join(' · ') },
              { label: t('enrol.replace.after'), value: t('enrol.replace.afterValue') },
            ]}
          />
        </Section>
      )
      // The safe default is the main action (last, under the thumb, Enter): keep the set-up.
      actions = [
        { label: t('enrol.replace.confirm'), icon: <RotateCcw />, onPress: () => send({ type: 'replace' }), variant: 'warning' },
        { label: t('enrol.replace.keep'), icon: <X />, onPress: () => send({ type: 'keep' }) },
      ]
      break
    case 'binding':
      body = (
        <Section title={t('enrol.binding.title')} icon={<MonitorSmartphone />}>
          <BindingFacts binding={step.binding} />
          <p className="fw-floor-muted">{t('enrol.binding.office')}</p>
        </Section>
      )
      actions = [{ label: t('enrol.continue'), icon: <ArrowRight />, onPress: () => send({ type: 'continue' }) }]
      break
    case 'install':
      body = <InstallStep step={step} send={send} />
      actions = [{ label: t('enrol.continue'), icon: <ArrowRight />, onPress: () => send({ type: 'continue' }) }]
      break
    case 'kiosk':
      body = <KioskStep step={step} send={send} />
      actions = [{ label: t('enrol.continue'), icon: <ArrowRight />, onPress: () => send({ type: 'continue' }) }]
      break
    case 'done': {
      const { binding } = step
      const words =
        binding.deviceMode === 'DISPLAY'
          ? t('enrol.done.display', { line: binding.line ?? binding.site })
          : binding.deviceMode === 'PHONE'
            ? t('enrol.done.phone')
            : binding.deviceMode === 'LINE'
              ? t('enrol.done.line', { line: binding.line ?? binding.site })
              : binding.station
                ? t('enrol.done.body', { station: binding.station, site: binding.site })
                : t('enrol.done.bodyNoStation', { site: binding.site })
      body = (
        <FloorState tone="success" icon={<CircleCheck />} title={t('enrol.done.title')} text={words}>
          <BindingFacts binding={binding} />
        </FloorState>
      )
      actions = [{ label: binding.deviceMode === 'DISPLAY' ? t('enrol.done.board') : t('enrol.done.signIn'), icon: <LogIn />, onPress: () => send({ type: 'sign-in' }) }]
      break
    }
  }

  return (
    <FloorFrameView
      frame={model.frame}
      onFrame={onFrame}
      actions={actions ? <FloorActionBar label={t('enrol.title')} start={<span className="fw-floor-step">{t('enrol.step', stepOf(step))}</span>} actions={actions} /> : undefined}
    >
      {body}
    </FloorFrameView>
  )
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="fw-floor-section" aria-labelledby="fw-floor-section-title">
      <h1 id="fw-floor-section-title" className="fw-floor-section-title">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h1>
      {children}
    </section>
  )
}

function ScanStep({ step, camera, onCode }: { step: Extract<EnrolStep, { kind: 'scan' }>; camera?: CameraScanner; onCode: (code: string) => void }) {
  const t = useT('floor')
  if (step.busy) {
    return <FloorState tone="info" icon={<ScanLine />} title={t('enrol.checking')} busy />
  }
  if (step.problem) {
    return <FloorState tone={step.problem === 'offline' ? 'warning' : 'danger'} icon={<CircleAlert />} title={t(`enrol.problem.${step.problem}.title`)} text={t(`enrol.problem.${step.problem}.body`)} alert />
  }
  return (
    <Section title={t('enrol.scan.title')} icon={<ScanLine />}>
      <p className="fw-floor-lead">{t('enrol.scan.where')}</p>
      <ScanInput
        label={t('enrol.scan.label')}
        hint={t('enrol.scan.hint')}
        // The code is a secret for 15 minutes: a screen reader hears that it was read, never the code.
        scannedLabel={() => t('enrol.scan.read')}
        keyboardLabel={t('enrol.scan.type')}
        camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
        onScan={(code) => onCode(code)}
      />
      <p className="fw-floor-muted">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <Camera />
        </span>
        {t('enrol.scan.cameraHelp')}
      </p>
    </Section>
  )
}

function BindingFacts({ binding }: { binding: Binding }) {
  const t = useT('floor')
  return (
    <FloorFacts
      facts={[
        { label: t('enrol.binding.device'), value: binding.device },
        { label: t('enrol.binding.site'), value: binding.site },
        { label: t('enrol.binding.station'), value: binding.station ?? t('frame.noStation') },
        // B-W2b-67: what the office chose; a station's tablet also says what its station does.
        { label: t('enrol.binding.mode'), value: binding.deviceMode === 'STATION' ? `${t('deviceMode.STATION')} · ${t(`mode.${binding.mode ?? 'none'}`)}` : t(`deviceMode.${binding.deviceMode}`) },
        ...(binding.line ? [{ label: t('enrol.binding.line'), value: binding.line }] : []),
        { label: t('enrol.binding.language'), value: <span lang={binding.language}>{LOCALE_NAMES[binding.language]}</span> },
      ]}
    />
  )
}

const tone = (ok: boolean): FloorTone => (ok ? 'success' : 'warning')

function InstallStep({ step, send }: { step: Extract<EnrolStep, { kind: 'install' }>; send: (action: EnrolAction) => void }) {
  const t = useT('floor')
  const { install, checks } = step
  const action = (label: string, onPress: () => void, icon: ReactNode): FloorAction => ({ label, onPress, icon })
  const appAction = install.app === 'available' ? action(t('enrol.install.app.button'), () => send({ type: 'install' }), <Download />) : null
  return (
    <div className="fw-floor-stack">
      <Section title={t('enrol.install.title')} icon={<Smartphone />}>
        <FloorList label={t('enrol.install.title')}>
          <FloorListRow
            icon={<Download />}
            tone={install.app === 'installed' ? 'success' : 'info'}
            title={t('enrol.install.app.title')}
            meta={install.app === 'manual' ? t('enrol.install.app.manualSteps') : undefined}
            status={t(`enrol.install.app.${install.app}`)}
          />
          <FloorListRow
            icon={<HardDrive />}
            tone={install.storage === 'kept' ? 'success' : install.storage === 'notKept' ? 'warning' : 'info'}
            title={t('enrol.install.storage.title')}
            meta={install.storage === 'notKept' ? t('enrol.install.storage.notKeptWhy') : undefined}
            status={t(`enrol.install.storage.${install.storage}`)}
          />
        </FloorList>
        <div className="fw-floor-row-actions">
          {appAction ? (
            <FloorButton size="md" variant="primary" icon={appAction.icon} onClick={appAction.onPress}>
              {appAction.label}
            </FloorButton>
          ) : null}
          {install.storage !== 'kept' ? (
            <FloorButton size="md" variant="secondary" icon={<HardDrive />} onClick={() => send({ type: 'keep-data' })}>
              {t('enrol.install.storage.button')}
            </FloorButton>
          ) : null}
        </div>
      </Section>
      <Section title={t('enrol.checks.title')} icon={<Check />}>
        <FloorList label={t('enrol.checks.title')}>
          <FloorListRow icon={<Camera />} tone={tone(checks.camera === 'ok')} title={t('enrol.checks.camera')} status={t(`enrol.checks.status.${checks.camera}`)} />
          <FloorListRow
            icon={<ScanLine />}
            tone={tone(checks.scanner === 'ok')}
            title={t('enrol.checks.scanner')}
            meta={checks.scanner === 'waiting' ? t('enrol.checks.scannerHint') : undefined}
            status={t(`enrol.checks.status.${checks.scanner}`)}
          />
          <FloorListRow
            icon={<Volume2 />}
            tone={tone(checks.sound === 'ok')}
            title={t('enrol.checks.sound')}
            status={t(`enrol.checks.status.${checks.sound}`)}
            onPress={() => send({ type: 'test-sound' })}
          />
          <FloorListRow icon={<Vibrate />} tone={tone(checks.vibration === 'ok')} title={t('enrol.checks.vibration')} status={t(`enrol.checks.status.${checks.vibration}`)} />
        </FloorList>
        <p className="fw-floor-muted">{t('enrol.checks.printer')}</p>
      </Section>
    </div>
  )
}

const KIOSK_ICON: Readonly<Record<KioskStepId, ReactNode>> = { install: <Download />, 'pinning-on': <Settings />, 'open-app': <Maximize />, 'pin-app': <Pin /> }
const ROW_ICON: Readonly<Record<'ok' | 'no' | 'unknown', ReactNode>> = { ok: <Check />, no: <X />, unknown: <CircleHelp /> }
const ROW_TONE: Readonly<Record<'ok' | 'no' | 'unknown', FloorTone>> = { ok: 'success', no: 'warning', unknown: 'info' }

/** The kiosk lock guide (PLT-227): four pictures, then the check: never "locked", Android does not say. */
function KioskStep({ step, send }: { step: Extract<EnrolStep, { kind: 'kiosk' }>; send: (action: EnrolAction) => void }) {
  const t = useT('floor')
  const { check } = step
  return (
    <div className="fw-floor-stack">
      <Section title={t('enrol.kiosk.title')} icon={<ShieldCheck />}>
        <ol className="fw-floor-media-steps">
          {KIOSK_STEPS.map((item, index) => (
            <li key={item.id} className="fw-floor-media-step" data-tone={item.look.tone}>
              <span className="fw-floor-media-step-picture" aria-hidden="true">
                {KIOSK_ICON[item.id]}
              </span>
              <span className="fw-floor-media-step-no">{index + 1}</span>
              <span>{t(`enrol.kiosk.step.${item.id}`)}</span>
            </li>
          ))}
        </ol>
      </Section>
      <Section title={t('enrol.kiosk.check')} icon={<Check />}>
        <FloorList label={t('enrol.kiosk.check')}>
          {check.rows.map((row) => (
            <FloorListRow
              key={row.id}
              icon={ROW_ICON[row.state]}
              tone={ROW_TONE[row.state]}
              title={t(`enrol.kiosk.row.${row.id}`)}
              meta={row.id === 'pinned' ? t(`enrol.kiosk.source.${row.source}`) : undefined}
              status={t(`enrol.kiosk.state.${row.id === 'pinned' ? 'pinned.' : ''}${row.state}`)}
            />
          ))}
        </FloorList>
        <p className="fw-floor-muted">{t('enrol.kiosk.honest')}</p>
        <div role="group" aria-label={t('enrol.kiosk.ask')} className="fw-floor-row-actions">
          <span className="fw-floor-locales-label">{t('enrol.kiosk.ask')}</span>
          <FloorButton size="md" variant={check.homeTest === 'STAYED' ? 'primary' : 'secondary'} aria-pressed={check.homeTest === 'STAYED'} icon={<Check />} onClick={() => send({ type: 'home-test', result: 'STAYED' })}>
            {t('enrol.kiosk.stayed')}
          </FloorButton>
          <FloorButton size="md" variant={check.homeTest === 'LEFT' ? 'primary' : 'secondary'} aria-pressed={check.homeTest === 'LEFT'} icon={<X />} onClick={() => send({ type: 'home-test', result: 'LEFT' })}>
            {t('enrol.kiosk.left')}
          </FloorButton>
        </div>
        <p className="fw-floor-muted">{t('enrol.kiosk.skip')}</p>
      </Section>
    </div>
  )
}
