'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Check, CircleCheck, MapPin, Package, PackageCheck } from 'lucide-react'
import { FloorList, FloorListRow, ScanInput, type CameraScanner, type FloorActions } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import type { useDsWords } from '../../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../../lib/i18n/messages'
import { HeldLine, ListFooter, TaskLine, Ticks } from '../../../shared/view/TaskParts'
import { KIT_TONE, kitHeldNow, kitState, type KitLast, type KitView } from '../model'

/**
 * B-W2b-310 — Kit staging on Pick & issue (design floor.pick sec:kit "Kit location per work order and a 'kit complete' check
 * (SCM-213)": "Location, the list with ticks, 'Kit complete' (main)"; follow-up FT2:01; review route SCR-385): the work order's kit
 * card — where it waits, how many lines are picked, when it was checked (never who) — the scan of a place's label puts the kit there,
 * the lines with their ticks, and "Kit complete" as the main action, held while a line is short (with why). Online only: offline the
 * scan and the button wait and say so. No money, no person.
 */

export interface KitStepModel {
  readonly kit: KitView
  readonly busy: boolean
  readonly last: KitLast | null
  /** The kit is this tablet's copy: as of when. */
  readonly asOf: string | null
}

export type KitAction = { type: 'kitScan'; code: string } | { type: 'kitComplete' } | { type: 'kitBack' }

export function kitStep({
  model,
  online,
  held,
  t,
  shared,
  floor,
  locale,
  ds,
  time,
  send,
  camera,
}: {
  model: KitStepModel
  online: boolean
  held: boolean
  t: Translate
  shared: Translate
  floor: Translate
  locale: string
  ds: ReturnType<typeof useDsWords>
  time: (value: string) => string
  send: (action: KitAction) => void
  camera?: CameraScanner
}): { body: ReactNode; actions: FloorActions } {
  const { kit } = model
  const state = kitState(kit)
  const picked = kit.lines.filter((line) => line.covered).length
  const complete = kitHeldNow(kit, 'complete', { online, busy: model.busy })
  const stage = kitHeldNow(kit, 'stage', { online, busy: model.busy })
  const heldWords = (now: ReturnType<typeof kitHeldNow>) => (now.held ? t(`kit.held.${now.held}`, { count: now.count ?? 0, number: kit.workOrder.number }) : null)
  const camProps = camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined
  const place = kit.location ? `${kit.location.code} · ${kit.location.name}` : t('kit.noPlace')
  const actions: FloorActions = [
    { label: t('kit.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'kitBack' }) },
    { label: t('kit.complete'), icon: <PackageCheck />, heldReason: heldWords(complete), onPress: () => send({ type: 'kitComplete' }) },
  ]
  const body = (
    <div className="fw-floor-stack">
      {!online ? <HeldLine text={t('kit.offline')} /> : null}
      {model.asOf ? <p className="fw-floor-muted">{shared('asOf', { time: time(model.asOf) })}</p> : null}
      <FloorCard
        icon={<PackageCheck />}
        kind={t('kit.kind')}
        code={kit.workOrder.number}
        title={kit.style ?? undefined}
        status={{ label: t(`kit.state.${state}`), tone: KIT_TONE[state] }}
        facts={[
          { id: 'place', label: t('kit.fact.place'), value: place, tone: kit.location ? undefined : 'warning' },
          { id: 'lines', label: t('kit.fact.lines'), value: t('kit.picked', { picked, total: kit.lines.length }) },
          { id: 'checked', label: t('kit.fact.checked'), value: kit.checkedAt ? time(kit.checkedAt) : null },
        ]}
        asOf={model.asOf}
        formatTime={time}
        labels={ds.floorCard}
      >
        <ReadAloudButton text={[t('kit.kind'), kit.workOrder.number, t(`kit.state.${state}`), t('kit.readPlace', { place }), t('kit.picked', { picked, total: kit.lines.length })].join('. ')} lang={locale === 'it' ? 'it-IT' : 'en-GB'} labels={ds.readAloud} size="md" />
      </FloorCard>
      {model.last ? (
        <div className="fw-pick-result" role="status">
          <TaskLine tone="success" icon={model.last.kind === 'checked' ? <CircleCheck /> : <MapPin />}>
            {model.last.kind === 'checked' ? t('kit.last.checked', { number: kit.workOrder.number }) : t('kit.last.staged', { place: model.last.place })}
          </TaskLine>
          <Ticks state="recorded" />
        </div>
      ) : null}
      <ScanInput
        label={t('kit.scan.label')}
        hint={held ? floor('tile.held.notice') : (heldWords(stage) ?? (kit.location ? t('kit.scan.move', { place: kit.location.code }) : t('kit.scan.hint')))}
        scannedLabel={(code) => floor('scan.read', { code })}
        keyboardLabel={floor('scan.type')}
        disabled={held || stage.held !== null}
        camera={camProps}
        onScan={(code) => send({ type: 'kitScan', code })}
      />
      <section className="fw-floor-stack" aria-labelledby="fw-pick-kit-lines">
        <h2 id="fw-pick-kit-lines" className="fw-floor-subtitle">
          {t('kit.lines')}
        </h2>
        {kit.lines.length === 0 ? (
          <p className="fw-floor-muted">{t('kit.noLines')}</p>
        ) : (
          <>
            <FloorList label={t('kit.lines')}>
              {kit.lines.map((line) => (
                <FloorListRow key={line.key} icon={line.covered ? <Check /> : <Package />} tone={line.covered ? 'success' : 'neutral'} title={line.name} status={line.covered ? t('kit.line.picked') : t('kit.line.short')} />
              ))}
            </FloorList>
            <ListFooter count={t('kit.picked', { picked, total: kit.lines.length })} keys={[{ key: 'Enter', does: t('kit.keys.complete') }, { key: 'Esc', does: t('kit.keys.back') }]} />
          </>
        )}
      </section>
    </div>
  )
  return { body, actions }
}
