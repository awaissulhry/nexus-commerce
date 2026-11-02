'use client'

import { CircleAlert, CircleCheckBig, Layers, Minus, Plus, SquareArrowOutUpRight, TriangleAlert, UserRoundCheck, X } from 'lucide-react'
import { FloorButton, FloorList, FloorListRow, ScanInput, SizeButtons, type CameraScanner } from '@nexus/ui/floor'
import { formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { HeldLine, TaskLine } from '../../shared/view/TaskParts'
import { isOverridable } from '../checks'
import { goodOf } from '../model'
import { ALL_SIZES, expectedOf, MAX_STACK, rowsOfSize, sizesOf, stackTotals, type StackRow } from '../stack'

/**
 * SCR-090 "Several bundles at once" (MES-100, MES-107): scan several, finish once. A stack of the bundles scanned, each with its
 * pieces and − and + (no typing, MES-106), a total, and "Finish 3 bundles · 60 good". With more than one size on the stack the DS
 * size buttons count by size: each says its pieces, a tap shows that size's bundles. A bundle refused at Finish stays here with
 * its words; a held one goes to the team leader's override alone; anything else about one bundle is reported alone.
 */

export interface StackLine {
  /** Its words: `stack.<key>` with these params. */
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly tone: 'warning' | 'danger' | 'success'
}

export type StackAction =
  | { type: 'scan'; code: string }
  | { type: 'stackSize'; size: string }
  | { type: 'stackStep'; id: string; delta: 1 | -1 }
  | { type: 'stackDrop'; id: string }
  | { type: 'stackAlone'; id: string }
  | { type: 'stackOverride'; id: string }

export function StackBody({ rows, size, line, online, refusalText, t, camera, send }: { rows: readonly StackRow[]; size: string | null; line: StackLine | null; online: boolean; refusalText: (refusal: NonNullable<StackRow['refusal']>) => string; t: Translate; camera?: CameraScanner; send: (action: StackAction) => void }) {
  const floor = useT('floor')
  const locale = useLocale()
  const totals = stackTotals(rows)
  const sizes = sizesOf(rows)
  const shown = rowsOfSize(rows, size)
  const buttons = sizes.map((entry) => ({ id: entry.id, label: entry.label, remaining: entry.pieces, hint: t('stack.bundles', { count: entry.bundles }) }))
  const picked = size !== null && size !== ALL_SIZES
  return (
    <div className="fw-floor-stack">
      <ScanInput
        label={t('stack.scan')}
        hint={t('stack.hint', { count: MAX_STACK })}
        scannedLabel={(code) => floor('scan.read', { code })}
        keyboardLabel={floor('scan.type')}
        camera={camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined}
        onScan={(code) => send({ type: 'scan', code })}
      />
      {!online ? <HeldLine text={t('stack.offline')} /> : null}
      {line ? (
        <TaskLine tone={line.tone} icon={line.tone === 'success' ? <CircleCheckBig /> : line.tone === 'danger' ? <CircleAlert /> : <TriangleAlert />} alert={line.tone !== 'success'}>
          {t(`stack.${line.key}`, line.params)}
        </TaskLine>
      ) : null}
      {sizes.length > 1 ? (
        <div className="fw-scans-stack-sizes">
          <SizeButtons label={t('stack.bySize')} sizes={buttons} value={picked ? size : null} onChange={(id) => send({ type: 'stackSize', size: id })} remainingLabel={(count) => t('stack.pieces', { count })} doneLabel={t('stack.none')} />
          {picked ? (
            <FloorButton size="lg" variant="secondary" icon={<Layers />} onClick={() => send({ type: 'stackSize', size: ALL_SIZES })}>
              {t('stack.allSizes')}
            </FloorButton>
          ) : null}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="fw-scans-invite">
          <span className="fw-floor-hero" aria-hidden="true">
            <Layers />
          </span>
          <p className="fw-floor-lead">{t('stack.empty')}</p>
        </div>
      ) : (
        <>
          <p className="fw-scans-stack-total" aria-live="polite">
            {t('stack.total', { count: totals.bundles, good: formatNumber(totals.good, locale) })}
          </p>
          {shown.map((row) => {
            const good = goodOf(row.counts, expectedOf(row))
            const held = row.refusal !== null
            return (
              <div key={row.clientScanId} className="fw-scans-stack-row">
                <FloorList label={row.card.bundle.code}>
                  <FloorListRow
                    icon={held ? <CircleAlert /> : <Layers />}
                    tone={held ? 'danger' : 'neutral'}
                    title={
                      <span>
                        <span className="fw-floor-code">{row.card.bundle.code}</span> · {t('opShort', { seq: row.operation.seq })} · {t('stack.size', { size: row.card.bundle.size })}
                      </span>
                    }
                    meta={row.refusal ? refusalText(row.refusal) : `${row.card.workOrder.style.name} · ${row.card.bundle.colourwayName || row.card.bundle.colourwayCode}`}
                    count={good}
                    countLabel={t('stack.of', { count: expectedOf(row) })}
                  />
                </FloorList>
                <span className="fw-scans-stack-actions">
                  <FloorButton size="md" variant="secondary" icon={<Minus />} aria-label={t('stack.less', { code: row.card.bundle.code })} heldReason={good <= 0 ? t('stack.least') : null} onClick={() => send({ type: 'stackStep', id: row.clientScanId, delta: -1 })} />
                  <FloorButton size="md" variant="secondary" icon={<Plus />} aria-label={t('stack.more', { code: row.card.bundle.code })} heldReason={good >= row.card.bundle.quantity ? t('counts.atMost', { count: row.card.bundle.quantity }) : null} onClick={() => send({ type: 'stackStep', id: row.clientScanId, delta: 1 })} />
                  <FloorButton size="md" variant="secondary" icon={<SquareArrowOutUpRight />} onClick={() => send({ type: 'stackAlone', id: row.clientScanId })}>
                    {t('stack.alone')}
                  </FloorButton>
                  {row.refusal && isOverridable(row.refusal.code) ? (
                    <FloorButton size="md" variant="primary" icon={<UserRoundCheck />} heldReason={online ? null : t('override.offline')} onClick={() => send({ type: 'stackOverride', id: row.clientScanId })}>
                      {t('guard.override')}
                    </FloorButton>
                  ) : null}
                  <FloorButton size="md" variant="secondary" icon={<X />} aria-label={t('stack.drop', { code: row.card.bundle.code })} onClick={() => send({ type: 'stackDrop', id: row.clientScanId })} />
                </span>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
