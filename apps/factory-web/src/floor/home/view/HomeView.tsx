'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, CircleAlert, ClipboardList, Clock, CloudOff, Factory, GraduationCap, Hash, Layers, LayoutGrid, LifeBuoy, ListTodo, Package, PackageOpen, PackageSearch, Pause, Play, ScanLine, Scissors, ScrollText, ShieldCheck, Shirt, Siren, Tag, TrafficCone, Undo2, UserRound, UserRoundCheck, Users, Wrench } from 'lucide-react'
import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import { FloorButton, FloorTile, FloorTileGrid, ScanInput, type CameraScanner } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { OpenItem } from '../../tasks/scans/timing'
import type { FloorMode, HomeTile, TileKey } from '../../model'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorState } from '../../frame/view/FloorState'

/**
 * SCR-022 — the floor home inside the floor frame (design floor.home; PLT-035, PLT-036): a scan strip on top (a scan
 * here opens the right card at once: Scan anything, SCR-024), then at most six tiles — the station's mode AND the
 * person's floor permissions, fail closed; more than six: a More tile opens the next page of tiles. Only a tile whose page exists opens; every other one says "Coming soon" on
 * the tile (never a dead tile). While the worker notice blocks scans, every scan tile says "Read the notice first" and
 * a card opens the notice. Offline (B-W0-30): one line says what goes on (every queued action is saved on this tablet)
 * and what waits for the network at this station (receipts, inspections and releases take their number from the office
 * at once), and, when the tablet runs low on its own label numbers, how many are left.
 */

export interface HomeViewModel {
  frame: FrameModel
  mode: FloorMode | null
  tiles: readonly HomeTile[]
  /** B-W2b-73: the tiles on the next page (0: this is the last, More goes back); null: one page, no More tile. */
  more?: number | null
  notice: { due: boolean; blocksScans: boolean }
  /** Right after a badge switched the person: who left, who is on. */
  switched?: { from: string; to: string } | null
  /** A badge scanned here did not open this tablet (the person on it stays). */
  badgeRefused?: boolean
  /** Offline: what waits for the network at this station (null: all its work is saved on the tablet). */
  offline?: { held: 'receive' | 'inspect' | 'serials' | null } | null
  /** Label kinds this tablet is running low on, with the numbers left (said while offline: online it tops up itself). */
  lowNumbers?: readonly { kind: ScanIdKind; left: number }[]
  /** Unfinished on this tablet (design floor.home "resume"); hidden when nothing is open. `asOf`: read earlier, offline now. */
  resume?: { items: readonly OpenItem[]; asOf: string | null } | null
  /** B-W2b-68: answers to the person's disputes not opened yet (the My day tile's badge). */
  mydayAnswers?: number
  timeZone?: string
}

export type HomeAction = { type: 'tile'; key: TileKey } | { type: 'more' } | { type: 'scan'; code: string } | { type: 'notice' } | { type: 'continue'; code: string }

export interface HomeViewProps {
  model: HomeViewModel
  onAction?: (action: HomeAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

export const TILE_ICON: Readonly<Record<TileKey, ReactNode>> = {
  mywork: <ListTodo />,
  operation: <Shirt />,
  cut: <Scissors />,
  bundles: <Layers />,
  receive: <PackageOpen />,
  pick: <ClipboardList />,
  // B-W2a-76
  returnsin: <Undo2 />,
  kits: <Factory />,
  labels: <Tag />,
  pack: <Package />,
  // B-W2b-115
  incoming: <PackageSearch />,
  final: <ShieldCheck />,
  // B-W2b-105
  inline: <TrafficCone />,
  machine: <Wrench />,
  // B-W2b-67
  clock: <Clock />,
  // B-W2b-68
  myday: <UserRound />,
  // B-W2b-145
  training: <GraduationCap />,
  // B-W2b-70
  help: <LifeBuoy />,
  // B-W2b-137
  incident: <Siren />,
  lineview: <Users />,
  scan: <ScanLine />,
}

export function HomeView({ model, onAction, onFrame, camera }: HomeViewProps) {
  const t = useT('floor')
  const locale = useLocale()
  const cardWords = useDsWords().floorCard
  const send = (action: HomeAction) => onAction?.(action)
  const held = model.notice.blocksScans
  const time = (value: string | null) => (value ? formatTime(value, { locale, timeZone: model.timeZone }) : '')
  const resume = model.resume?.items ?? []
  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame}>
      <div className="fw-floor-stack">
        {model.switched ? (
          <p role="status" className="fw-floor-notice" data-tone="success">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <UserRoundCheck />
            </span>
            {t('home.switched', model.switched)}
          </p>
        ) : null}
        {model.badgeRefused ? (
          <p role="alert" className="fw-floor-notice" data-tone="danger">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CircleAlert />
            </span>
            {t('home.badgeRefused')}
          </p>
        ) : null}
        {model.offline ? (
          <p role="status" className="fw-floor-notice" data-tone="warning">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CloudOff />
            </span>
            {model.offline.held ? t(`home.offline.held.${model.offline.held}`) : t('home.offline.queues')}
          </p>
        ) : null}
        {model.offline
          ? (model.lowNumbers ?? []).map((entry) => (
              <p key={entry.kind} className="fw-floor-notice" data-tone="warning">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Hash />
                </span>
                {t('sync.numbers.lowOffline', { count: entry.left, what: t(`sync.numbers.kind.${entry.kind}`) })}
              </p>
            ))
          : null}
        {model.notice.due ? (
          <div className="fw-floor-notice fw-floor-notice-card" data-tone={held ? 'warning' : 'info'}>
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <ScrollText />
            </span>
            <span className="fw-floor-notice-card-text">
              <strong>{t('home.notice.title')}</strong>
              <span>{held ? t('home.notice.blocks') : t('home.notice.body')}</span>
            </span>
            <FloorButton size="md" variant="primary" icon={<ScrollText />} onClick={() => send({ type: 'notice' })}>
              {t('home.notice.open')}
            </FloorButton>
          </div>
        ) : null}
        {model.tiles.length > 0 ? (
          <ScanInput
            label={t('home.scan.label')}
            hint={held ? t('tile.held.notice') : t(`home.scan.hint.${model.mode ?? 'none'}`)}
            scannedLabel={(code) => t('scan.read', { code })}
            keyboardLabel={t('scan.type')}
            disabled={held}
            camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
            onScan={(code) => send({ type: 'scan', code })}
          />
        ) : null}
        {resume.length > 0 ? (
          <section className="fw-floor-stack" aria-labelledby="fw-home-resume">
            <h2 id="fw-home-resume" className="fw-floor-section-title">
              {t('home.resume.title')}
            </h2>
            {resume.map((item) => {
              const paused = item.state === 'PAUSED'
              return (
                <FloorCard
                  key={`${item.bundleId}:${item.operation.id}`}
                  icon={paused ? <Pause /> : <Play />}
                  kind={t(paused ? 'home.resume.paused' : 'home.resume.running')}
                  code={item.bundleCode}
                  title={t(`home.resume.line.${paused ? (item.pausedAtClockOut ? 'clockOut' : 'paused') : 'running'}`, { seq: item.operation.seq, name: item.operation.name, time: time(item.pausedAt ?? item.runningSince) })}
                  tone={paused ? 'warning' : 'info'}
                  asOf={model.resume?.asOf ?? null}
                  formatTime={(iso) => time(iso)}
                  labels={cardWords}
                >
                  <FloorButton size="lg" variant="primary" icon={<Play />} heldReason={held ? t('tile.held.notice') : null} onClick={() => send({ type: 'continue', code: item.bundleCode })}>
                    {t('home.resume.continue')}
                  </FloorButton>
                </FloorCard>
              )
            })}
          </section>
        ) : null}
        {model.tiles.length === 0 ? (
          <FloorState tone="info" icon={<ShieldCheck />} title={t('home.empty.title')} text={t('home.empty.body')} />
        ) : (
          <FloorTileGrid label={t('home.tiles')}>
            {model.tiles.map((tile) => (
              <FloorTile
                key={tile.key}
                icon={TILE_ICON[tile.key]}
                label={t(`tile.${tile.key}`)}
                hint={tile.held ? t(`tile.held.${tile.held}`) : t(`tile.hint.${tile.key}`)}
                tone={tile.held ? 'neutral' : 'primary'}
                heldReason={tile.held ? t(`tile.held.${tile.held}`) : null}
                onPress={() => send({ type: 'tile', key: tile.key })}
                {...(tile.key === 'myday' && model.mydayAnswers ? { count: model.mydayAnswers, countLabel: t('tile.mydayAnswers', { count: model.mydayAnswers }) } : {})}
              />
            ))}
            {model.more === undefined || model.more === null ? null : <FloorTile key="more" icon={model.more > 0 ? <LayoutGrid /> : <ArrowLeft />} label={t(model.more > 0 ? 'tile.more' : 'tile.back')} hint={model.more > 0 ? t('tile.hint.more', { count: model.more }) : t('tile.hint.back')} tone="neutral" onPress={() => send({ type: 'more' })} />}
          </FloorTileGrid>
        )}
      </div>
    </FloorFrameView>
  )
}
