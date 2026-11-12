'use client'

import { Card, PressableRow } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { Loading, ReadFailed } from '../view/parts'
import { useReturnWords } from '../words'
import type { RepairsRead } from './api'
import { garmentLine, NS, stageTone } from './model'

/**
 * SCR-187 › Your repairs (B-W2b-342; RR1:02): the customer's repair and alteration requests on the Returns & claims page,
 * newest first, as the page's complaints are (DS PressableRow; the design's single list of every case is Later, SAL-447):
 * the number, the kind, where it stands, the next step ("Your move:" when it is theirs), the garment and the day it was
 * asked; a row opens the repair's page. Hidden while the person has none and none is loading; a failed read says so.
 */

export interface RepairsSectionModel {
  state: 'loading' | 'error' | 'ready'
  read: RepairsRead | null
}

export function RepairsSection({ model, onOpen, onRetry }: { model: RepairsSectionModel; onOpen?: (id: string) => void; onRetry?: () => void }) {
  const r = useT(NS)
  const { date } = useReturnWords()
  const items = model.read?.items ?? []
  if (model.state === 'ready' && items.length === 0) return null
  return (
    <section className="fw-pret-section" aria-labelledby="fw-pret-repairs">
      <h2 id="fw-pret-repairs" className="fw-pret-h2">
        {r('portal.list.title')}
        {model.read ? <span className="fw-pret-h2-count">{items.length}</span> : null}
      </h2>
      <p className="fw-pret-hint">{r('portal.list.hint')}</p>
      {model.state === 'loading' ? (
        <Loading rows={2} height={56} />
      ) : model.state === 'error' ? (
        <ReadFailed title={r('portal.list.failed')} onRetry={onRetry} />
      ) : (
        <Card className="fw-pret-complaints">
          {items.map((row) => (
            <PressableRow
              key={row.id}
              stacked
              label={
                <span className="fw-pret-complaint-head">
                  <span className="fw-pret-strong">{row.number}</span>
                  <Pill tone={stageTone(row)}>{r(`common.stage.${row.stage}`)}</Pill>
                </span>
              }
              description={r('portal.list.open', { number: row.number })}
              onClick={() => onOpen?.(row.id)}
            >
              <span className="fw-pret-complaint-body">
                <span className="fw-pret-subject">{[r(`common.kind.${row.kind}`), garmentLine(row.garment, r)].join(' · ')}</span>
                <span className="fw-pret-sub">
                  {row.next.forYou ? <strong>{r('common.yourMove')} </strong> : null}
                  {r(`common.next.${row.next.code}`)}
                </span>
                <span className="fw-pret-sub">{r('common.opened', { day: date(row.opened) })}</span>
              </span>
            </PressableRow>
          ))}
        </Card>
      )}
    </section>
  )
}
