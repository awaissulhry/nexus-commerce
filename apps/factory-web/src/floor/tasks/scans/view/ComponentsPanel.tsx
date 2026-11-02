'use client'

import { Check, Minus, PackageSearch, Plus, ScanLine, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import { FloorButton, FloorList, FloorListRow, ScanInput, type CameraScanner } from '@nexus/ui/floor'
import { useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { TaskLine } from '../../shared/view/TaskParts'
import type { ComponentRow } from '../checks'

/**
 * SCR-090 "Scan what you used" (MES-114; EN 1621 protectors traced per garment): the components the operation asks, as rows with
 * a tick once a lot of it covers every garment that goes on; a wrong item is refused at the scan. One lot takes all the garments
 * by itself; with a second lot the one before says how many it covers, by − and +, without typing (the last takes the rest).
 */
export function ComponentsPanel({
  rows,
  garments,
  refusal,
  unchecked,
  t,
  camera,
  onLot,
  onStep,
  onDrop,
}: {
  rows: readonly ComponentRow[]
  garments: number
  refusal: { readonly message: string; readonly fix: string | null } | null
  /** A lot read offline: the office checks it when the report arrives. */
  unchecked: boolean
  t: Translate
  camera?: CameraScanner
  onLot: (code: string) => void
  onStep: (code: string, delta: 1 | -1) => void
  onDrop: (code: string) => void
}) {
  const floor = useT('floor')
  if (rows.length === 0) return null
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-scans-components">
      <h3 id="fw-scans-components" className="fw-floor-subtitle fw-scans-panel-title">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <ShieldCheck />
        </span>
        {t('components.title')}
      </h3>
      <FloorList label={t('components.title')}>
        {rows.map((row) => {
          const done = garments > 0 && row.covered === garments
          return (
            <FloorListRow
              key={row.component.itemId}
              icon={done ? <Check /> : <ScanLine />}
              tone={done ? 'success' : 'warning'}
              title={`${row.component.code} · ${row.component.name}`}
              meta={row.lots.length > 0 ? row.lots.map((line) => line.code).join(' · ') : t('components.scanIt')}
              status={done ? t('components.done') : undefined}
              count={row.covered}
              countLabel={t('components.of', { count: garments })}
            />
          )
        })}
      </FloorList>
      {rows
        .filter((row) => row.lots.length > 1)
        .flatMap((row) => row.lots.map((line, index) => ({ line, last: index === row.lots.length - 1 })))
        .map(({ line, last }) => (
          <div key={line.code} className="fw-scans-lot">
            <span className="fw-floor-code fw-scans-lot-code">{line.code}</span>
            <span className="fw-scans-lot-count">{last ? t('components.rest', { count: line.covers }) : line.covers === 0 ? t('components.saySo') : t('components.covers', { count: line.covers })}</span>
            {last ? null : (
              <span className="fw-scans-lot-steps">
                <FloorButton size="md" variant="secondary" icon={<Minus />} aria-label={t('components.less', { code: line.code })} heldReason={line.covers <= 1 ? t('components.least') : null} onClick={() => onStep(line.code, -1)} />
                <FloorButton size="md" variant="secondary" icon={<Plus />} aria-label={t('components.more', { code: line.code })} heldReason={line.covers >= garments - 1 ? t('components.most', { count: garments - 1 }) : null} onClick={() => onStep(line.code, 1)} />
              </span>
            )}
            <FloorButton size="md" variant="secondary" icon={<X />} aria-label={t('components.drop', { code: line.code })} onClick={() => onDrop(line.code)} />
          </div>
        ))}
      {refusal ? (
        <TaskLine tone="danger" icon={<TriangleAlert />} alert>
          {refusal.message} {refusal.fix}
        </TaskLine>
      ) : null}
      {unchecked ? (
        <TaskLine tone="info" icon={<PackageSearch />}>
          {t('components.unchecked')}
        </TaskLine>
      ) : null}
      <ScanInput
        label={t('components.scan')}
        hint={t('components.hint')}
        scannedLabel={(code) => floor('scan.read', { code })}
        keyboardLabel={floor('scan.type')}
        keepFocus={false}
        listenGlobally={false}
        camera={camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined}
        onScan={(code) => onLot(code)}
      />
    </section>
  )
}
