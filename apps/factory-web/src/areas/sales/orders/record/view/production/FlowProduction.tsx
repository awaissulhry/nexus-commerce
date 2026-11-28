'use client'

import { Flame, Printer, ScanLine } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { DeptChip } from '../../../../../../lib/department/view/DeptChip'
import type { Department } from '../../../../../../lib/department/model'
import type { BasketCard } from '../../../../../../lib/production/baskets-board'
import { useFlowWords } from '../../flow-words'
import './flow-production.css'

/**
 * owb-of6 step 1 (design plan § 5k; prototype rec.js productionTab) — the Production tab's new doors and the basket rows, drawn in
 * today's sections: Rush (L4: today's "Priority and rush…" — the office priority URGENT), Print again… (S3's window, production.print.start),
 * Place the scan code… (S3's window: production.print.start or the designer on the order), and the Baskets rows from S5's board read
 * (L8: until it answers, the section keeps today's work-order rows). A door this reader may not use is not drawn (the host decides).
 */

/** Rush… — the order's priority URGENT through today's dialog (the band's ⋯ Set priority… opens the same one). */
export function RushButton({ onRush }: { readonly onRush: () => void }) {
  const f = useFlowWords()
  return (
    <Button key="rush" size="sm" variant="quiet" onClick={onRush}>
      <Flame size={14} aria-hidden /> {f('production.rush')}
    </Button>
  )
}

/** Print again… (S3's window: the SAME codes, a reason; never a second first print). */
export function PrintAgainButton({ onOpen }: { readonly onOpen: () => void }) {
  const f = useFlowWords()
  return (
    <Button key="printAgain" size="sm" variant="quiet" onClick={onOpen}>
      <Printer size={14} aria-hidden /> {f('production.printAgain')}
    </Button>
  )
}

/** Place the scan code… (S3's window: where the code sits on each design page). */
export function PlaceScanCodeButton({ onOpen }: { readonly onOpen: () => void }) {
  const f = useFlowWords()
  return (
    <Button key="placeCode" size="sm" variant="quiet" onClick={onOpen}>
      <ScanLine size={14} aria-hidden /> {f('production.placeCode')}
    </Button>
  )
}

/** The words of a basket's state (Working · Paused · Waiting; anything else as its own word). */
const STATES = ['WORKING', 'PAUSED', 'WAITING', 'READY'] as const
export const basketStateKeyOf = (state: string | null | undefined): string | null => (state && (STATES as readonly string[]).includes(state.toUpperCase()) ? `baskets.state.${state.toUpperCase()}` : null)

/** "Step 2 of 6" from S5's progress (null when the card says none). */
export const stepWordsOf = (progress: BasketCard['progress']): { done: number; total: number } | null => (progress && progress.total > 0 ? { done: Math.min(progress.done, progress.total), total: progress.total } : null)

/**
 * One row per basket (prototype productionTab › Baskets): its code, where it is (the department chip, or Ready to ship), Working /
 * Paused / Waiting, "Step k of n", who has it (the worker the read names, else the department), late, "Set by hand". No price.
 */
export function BasketRows({ baskets }: { readonly baskets: readonly { readonly card: BasketCard; readonly dept: Department | null }[] }) {
  const f = useFlowWords()
  return (
    <ul className="fw-flow-baskets" aria-label={f('baskets.label')}>
      {baskets.map(({ card, dept }) => {
        const state = basketStateKeyOf(card.state)
        const step = stepWordsOf(card.progress)
        return (
          <li key={card.bundleId} className="fw-flow-basket">
            <span className="fw-flow-basket-code">{card.code ?? card.label ?? '—'}</span>
            <span className="fw-flow-basket-where">{dept ? <DeptChip dept={dept} /> : <Tag tone="success">{f('baskets.ready')}</Tag>}</span>
            <span className="fw-flow-basket-state">{state ? f(state) : (card.state ?? '')}</span>
            <span className="fw-flow-basket-step">{step ? f('baskets.step', step) : ''}</span>
            <span className="fw-flow-basket-who">{card.worker?.name ?? dept?.shortName ?? ''}</span>
            <span className="fw-flow-basket-marks">
              {card.late ? <Tag tone="danger">{f('baskets.late', { count: card.late.days, days: card.late.days })}</Tag> : null}
              {card.byHand ? <Tag tone="neutral">{f('baskets.byHand')}</Tag> : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
