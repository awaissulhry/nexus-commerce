'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { Banner, Modal } from '@nexus/ui/components'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { useT } from '../../../../../../lib/i18n/provider'
import { newIdempotencyKey } from '../../../../../../lib/api/client'
import { applyAmendment, getOrder, previewAmendment, type AmendLineInput, type AmendPreview, type Order } from '../../../api'
import { EMPTY_HISTORY, baseSizesOf, bodyLinesOf, piecesBeforeAfter, setCell, type DraftHistory } from '../../../record/lines-draft'
import type { SheetRowRead } from '../api'
import { NS, pageOf } from '../map'
import { refusalWordsOf } from '../use-office-sheet'

/**
 * owb-of3 step 3 (L2) — a typed cell of a CONFIRMED order stages ONE change (a line's sizes) and opens this window: today's Review and
 * save path of the order's Lines tab — the amendment's preview (`POST …/amendments/preview`), then Save (`POST …/amendments` at the
 * order's version). Built from the Lines tab's own pure draft (`record/lines-draft.ts`: `setCell`, `bodyLinesOf`), never a copy; never
 * a silent write. What the preview cannot settle here (pieces already cut, a problem it names) goes to the Lines tab, one press away.
 */
export function stagedHistoryOf(order: Pick<Order, 'lines'>, lineId: string, sizes: Readonly<Record<string, number>>): DraftHistory {
  const line = order.lines.find((entry) => entry.id === lineId)
  if (!line) return EMPTY_HISTORY
  const all = new Set([...Object.keys(baseSizesOf(line)), ...Object.keys(sizes)])
  let history = EMPTY_HISTORY
  for (const size of all) history = setCell(history, order, lineId, size, sizes[size] ?? 0)
  return history
}

type Phase = { readonly kind: 'reading' } | { readonly kind: 'ready'; readonly order: Order; readonly lines: AmendLineInput[]; readonly preview: AmendPreview } | { readonly kind: 'failed'; readonly words: string }

export function ReviewChangeWindow({ row, lineId, sizes, prefix, onClose, onDone }: { row: SheetRowRead; lineId: string; sizes: Readonly<Record<string, number>>; prefix: string; onClose: () => void; onDone: (words: string | null) => void }) {
  const api = useOfficeApi()
  const t = useT(NS)
  const [phase, setPhase] = useState<Phase>({ kind: 'reading' })
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const sizesKey = JSON.stringify(sizes)

  useEffect(() => {
    const control = new AbortController()
    void (async () => {
      try {
        const order = await getOrder(api, row.id, control.signal)
        const history = stagedHistoryOf(order, lineId, JSON.parse(sizesKey) as Record<string, number>)
        const lines = bodyLinesOf(history.draft, order)
        const preview = await previewAmendment(api, row.id, { version: order.version, lines }, control.signal)
        if (!control.signal.aborted) setPhase({ kind: 'ready', order, lines, preview })
      } catch (error) {
        if (!control.signal.aborted) setPhase({ kind: 'failed', words: refusalWordsOf(error, t) })
      }
    })()
    return () => control.abort()
  }, [api, row.id, lineId, sizesKey, t])

  const line = row.lines.find((entry) => entry.id === lineId)
  const pieces = useMemo(() => (phase.kind === 'ready' ? piecesBeforeAfter(stagedHistoryOf(phase.order, lineId, sizes).draft, phase.order) : null), [phase, lineId, sizes])
  const cut = phase.kind === 'ready' && (phase.preview.workOrders?.extra.length ?? 0) > 0
  const held = phase.kind !== 'ready' || !phase.preview.ok || cut
  const linesTab = pageOf(prefix, row, 'lines')

  const save = async () => {
    if (phase.kind !== 'ready' || held) return
    setSaving(true)
    setProblem(null)
    try {
      await applyAmendment(api, row.id, { version: phase.order.version, lines: phase.lines }, newIdempotencyKey())
      onDone(t('office.review.saved', { number: row.number ?? '' }))
    } catch (error) {
      setProblem(refusalWordsOf(error, t))
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('office.review.title')}
      subtitle={`${row.number ?? ''} · ${row.subject ?? t('part.noSubject')} · ${row.party.name}`}
      footer={
        <>
          <Button variant="link" asChild>
            <Link href={linesTab}>{t('office.review.linesTab')}</Link>
          </Button>
          <span className="grow" />
          <Button onClick={onClose}>{t('office.cancel')}</Button>
          <Button variant="primary" disabled={held || saving} onClick={() => void save()}>
            {t(saving ? 'office.review.saving' : 'office.review.save')}
          </Button>
        </>
      }
    >
      {problem && <Banner tone="danger" title={problem} />}
      {phase.kind === 'reading' && <p className="fw-osp-muted">{t('office.reading')}</p>}
      {phase.kind === 'failed' && <Banner tone="danger" title={phase.words} />}
      {phase.kind === 'ready' && (
        <div className="fw-osp-review">
          <p className="fw-osp-strong">{t('office.review.line', { seq: line?.seq ?? '', what: line?.product ? `${line.product.code} ${line.product.name}` : (line?.text ?? '') })}</p>
          <p className="fw-osp-fromto">
            <span className="fw-osp-from">{line?.sizes ?? '—'}</span>
            <ArrowRight size={14} aria-label={t('office.asks.to')} />
            <span className="fw-osp-to">{Object.entries(sizes).map(([size, count]) => `${size}:${count}`).join(' ')}</span>
          </p>
          {pieces && <p className="fw-osp-muted">{t('office.review.pieces', { before: pieces.before, after: pieces.after })}</p>}
          {!phase.preview.ok && <Banner tone="warning" title={t('office.review.problems', { count: Math.max(1, phase.preview.problems.length) })} />}
          {cut && <Banner tone="warning" title={t('office.review.cut')} />}
          {phase.preview.amountChanges && <p className="fw-osp-muted">{t('office.review.amount')}</p>}
        </div>
      )}
    </Modal>
  )
}
