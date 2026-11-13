'use client'

import { PackageCheck } from 'lucide-react'
import type { Translate } from '../../../../../lib/i18n/messages'
import { FloorFacts } from '../../../../frame/view/FloorFacts'
import { FloorState } from '../../../../frame/view/FloorState'
import type { PackedSummary } from '../model'

/**
 * Packed (B-W2b-387; design floor.pack "Packed": 'Shipment S-0012 packed · 4 cartons · labels printed.'): the state
 * screen once a shipment is done at the bench — its number, its cartons and what became of the labels in one line, then
 * the facts: the carton marks, the carrier labels, the DDT with the packing list, each as it really stands.
 */
export function PackedDone({ summary, t }: { summary: PackedSummary; t: Translate }) {
  const labelsFact = summary.labels === 'notNeeded' ? t(`done.transport.${summary.transportBy}`) : t(`done.labelsState.${summary.labels}`)
  return (
    <FloorState tone="success" icon={<PackageCheck />} title={t('done.title', { number: summary.number })} text={t('done.line', { count: summary.cartons, labels: t(`done.labels.${summary.labels}`) })}>
      <FloorFacts
        facts={[
          { label: t('done.facts.cartons'), value: String(summary.cartons) },
          { label: t('done.facts.marks'), value: summary.marks === 'printed' ? t('done.marks.printed', { count: summary.cartons }) : t('done.marks.due') },
          { label: t('done.facts.labels'), value: labelsFact },
          { label: t('done.facts.documents'), value: t(`done.documentsState.${summary.documents}`) },
        ]}
      />
    </FloorState>
  )
}
