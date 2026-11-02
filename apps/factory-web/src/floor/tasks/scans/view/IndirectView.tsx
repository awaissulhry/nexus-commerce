'use client'

import { Check, Coffee, ScanLine } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { FloorState } from '../../../frame/view/FloorState'
import { HeldLine } from '../../shared/view/TaskParts'
import { glyphOf } from '../../reasons/view/ReasonPicker'
import { tilesOf, wordOf } from '../../reasons/model'
import { tileReason, type OffStandardBlock, type OffStandardTile } from '../indirect'

/**
 * SCR-090 "No bundle: what are you doing?" (MES-156, MES-158): the company's off-standard and indirect codes as the DS icon tiles;
 * one tap starts it (another tile switches), Done ends it, and scanning a bundle returns to standard. A running block sits on the
 * scan step with its own clock, so the next bundle is one scan away.
 */

export function IndirectTiles({ codes, online, t, onPick }: { codes: readonly OffStandardTile[] | null; online: boolean; t: Translate; onPick: (id: string) => void }) {
  const locale = useLocale()
  const words = useReasonWords()
  if (codes === null) {
    return online ? <p className="fw-floor-muted" aria-busy="true">{t('indirect.loading')}</p> : <FloorState tone="warning" icon={<Coffee />} title={t('indirect.offline.title')} text={t('indirect.offline.body')} alert />
  }
  if (codes.length === 0) return <FloorState tone="info" icon={<Coffee />} title={t('indirect.empty.title')} text={t('indirect.empty.body')} />
  const tiles: ReasonTile[] = tilesOf(codes.map(tileReason), locale).map((tile) => ({ id: tile.id, label: tile.label, icon: glyphOf(tile.icon), tone: tile.tone }))
  return (
    <div className="fw-floor-stack">
      {!online ? <HeldLine text={t('indirect.queues')} /> : null}
      <ReasonGrid label={t('indirect.question')} reasons={tiles} value={null} onChange={(id) => onPick(id)} words={words} locale={INTL_LOCALE[locale]} />
    </div>
  )
}

export function RunningBlock({ block, skewMs, t, onDone }: { block: OffStandardBlock; skewMs: number; t: Translate; onDone: () => void }) {
  const locale = useLocale()
  const labels = useDsWords().floorElapsed
  const word = wordOf(tileReason(block.code, 0), locale)
  return (
    <section className="fw-scans-clock" data-state="indirect" aria-label={t('indirect.running')}>
      <FloorElapsed label={word} since={Date.parse(block.startedAt) + skewMs} labels={labels} />
      <p className="fw-floor-muted">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <ScanLine />
        </span>
        {t('indirect.scanReturns')}
      </p>
      <FloorButton size="lg" variant="primary" icon={<Check />} onClick={onDone}>
        {t('indirect.done')}
      </FloorButton>
    </section>
  )
}
