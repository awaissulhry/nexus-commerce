'use client'

import type { ReactNode } from 'react'
import { CircleAlert, ClipboardList, CloudOff, Factory, Hash, Layers, ListTodo, Package, PackageOpen, ScanLine, ScrollText, Scissors, ShieldCheck, Shirt, Tag, Undo2, UserRoundCheck, Wrench } from 'lucide-react'
import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import { FloorButton, FloorTile, FloorTileGrid, ScanInput, type CameraScanner } from '@nexus/ui/floor'
import { useT } from '../../../lib/i18n/provider'
import type { FloorMode, HomeTile, TileKey } from '../../model'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorState } from '../../frame/view/FloorState'

/**
 * SCR-022 — the floor home inside the floor frame (design floor.home; PLT-035, PLT-036): a scan strip on top (a scan
 * here opens the right card at once: Scan anything, SCR-024), then at most six tiles — the station's mode AND the
 * person's floor permissions, fail closed. Only a tile whose page exists opens; every other one says "Coming soon" on
 * the tile (never a dead tile). While the worker notice blocks scans, every scan tile says "Read the notice first" and
 * a card opens the notice. Offline (B-W0-30): one line says what goes on (every queued action is saved on this tablet)
 * and what waits for the network at this station (receipts, inspections and releases take their number from the office
 * at once), and, when the tablet runs low on its own label numbers, how many are left.
 */

export interface HomeViewModel {
  frame: FrameModel
  mode: FloorMode | null
  tiles: readonly HomeTile[]
  notice: { due: boolean; blocksScans: boolean }
  /** Right after a badge switched the person: who left, who is on. */
  switched?: { from: string; to: string } | null
  /** A badge scanned here did not open this tablet (the person on it stays). */
  badgeRefused?: boolean
  /** Offline: what waits for the network at this station (null: all its work is saved on the tablet). */
  offline?: { held: 'receive' | 'inspect' | 'serials' | null } | null
  /** Label kinds this tablet is running low on, with the numbers left (said while offline: online it tops up itself). */
  lowNumbers?: readonly { kind: ScanIdKind; left: number }[]
}

export type HomeAction = { type: 'tile'; key: TileKey } | { type: 'scan'; code: string } | { type: 'notice' }

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
  final: <ShieldCheck />,
  machine: <Wrench />,
  scan: <ScanLine />,
}

export function HomeView({ model, onAction, onFrame, camera }: HomeViewProps) {
  const t = useT('floor')
  const send = (action: HomeAction) => onAction?.(action)
  const held = model.notice.blocksScans
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
              />
            ))}
          </FloorTileGrid>
        )}
      </div>
    </FloorFrameView>
  )
}
