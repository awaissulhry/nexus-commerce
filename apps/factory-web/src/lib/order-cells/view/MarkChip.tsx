'use client'

import Link from 'next/link'
import { Tag } from '@nexus/ui/primitives'
import type { MarkChipModel } from '../model'
import '../order-cells.css'

/**
 * pg-w1 (18-lead-settles Z1, Z4; 10-design § 1.5) — the mark chip of a row: ONE thing that stops it or waits on someone, the DS Tag
 * with its mark beside its words and its tail after a dot (both go to its tooltip in a dense cell), outlined when neutral (who it
 * waits on); a real link when it has a door. The office's Where it is cell draws its stop chip with it (its eight kinds and their
 * words stay office); the customer's list draws "Needs your answer" with it. It draws its model and nothing else.
 */
export function MarkChip({ chip }: { chip: MarkChipModel }) {
  const { tone, head, dense } = chip
  const tail = chip.tail ?? null
  const href = chip.href ?? null
  const tip = chip.tip ?? null
  const Icon = chip.mark
  const full = tail ? `${head} · ${tail}` : head
  const body = (
    <Tag tone={tone} className={tone === 'neutral' ? 'fw-sheet-stop is-dash' : 'fw-sheet-stop'} title={href ? undefined : (tip ?? full)}>
      {!dense && <Icon size={11} aria-hidden />}
      {head}
      {tail && !dense && ` · ${tail}`}
    </Tag>
  )
  if (!href) return body
  return (
    <Link href={href} className="fw-sheet-chip-door" data-door="" title={tip ?? full}>
      {body}
    </Link>
  )
}
