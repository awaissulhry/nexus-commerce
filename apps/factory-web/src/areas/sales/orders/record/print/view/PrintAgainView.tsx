'use client'

import type { ReactElement, ReactNode } from 'react'
import { AlertTriangle, Copy, Info, PencilLine, Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, FilterChip } from '@nexus/ui/primitives'
import type { AgainReason, SheetCard } from '../api'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { PartReading } from '../../../../../../lib/record-sections/Kit'
import { WindowShell } from '../../../../../../lib/window-shell/view/WindowShell'
import { AGAIN_REASON_KEYS, NOTE_MAX, type AgainForm, type AgainPage, type Said } from '../model'
import '../print.css'

/**
 * owb-ss4 step 4.3 (design plan § 5zj B; reprint.js `reprintModal`; settle L7) — the window "Print again", drawn with the ONE window frame:
 * "Nothing starts, and no basket moves. The scan codes stay the same." · the reason in ONE tap (Lost · Damaged · A small change · One
 * more copy) · for "A small change" the words (needed, ≤ 140, a counter) and the line "The baskets of this piece show “The design
 * changed” on the floor" · the pages of each piece and the basket cards with tick boxes (from the order: all ticked; a card of a shipped
 * basket is not offered); the ONE act **Print again** held with its words. Draws its model; fetches nothing.
 */

export interface PrintAgainViewModel {
  readonly open: boolean
  readonly state: 'reading' | 'failed' | 'ready'
  /** Why it could not be read (a `shipments` word: problem.read.*). */
  readonly readProblem: string | null
  readonly pages: readonly AgainPage[]
  readonly cards: readonly SheetCard[]
  /** The cards could not be read (the pages still print). */
  readonly cardsMissing: boolean
  readonly form: AgainForm
  readonly held: Said | null
  readonly busy: boolean
  /** A refused print, in the Warehouse's refusal words (`shipments`: problem.write.*), with the API's sentence. */
  readonly writeProblem: { readonly key: string; readonly detail: string | null } | null
}

export interface PrintAgainViewActions {
  readonly onClose: () => void
  readonly onForm?: (form: AgainForm) => void
  readonly onTickPage?: (key: string) => void
  readonly onTickCard?: (bundleId: string) => void
  readonly onAllCards?: (all: boolean) => void
  readonly onPrint?: () => void
}

const NO_ACTIONS: PrintAgainViewActions = Object.freeze({ onClose: () => undefined })

const REASON_ICON: Readonly<Record<AgainReason, ReactNode>> = Object.freeze({
  LOST: <Search size={14} aria-hidden />,
  DAMAGED: <AlertTriangle size={14} aria-hidden />,
  SMALL_CHANGE: <PencilLine size={14} aria-hidden />,
  ONE_MORE_COPY: <Copy size={14} aria-hidden />,
})

export function PrintAgainView({ model, actions = NO_ACTIONS }: { model: PrintAgainViewModel; actions?: PrintAgainViewActions }): ReactElement {
  const t = useT('print-start')
  const s = useT('shipments')
  const { form } = model
  const ticked = form.pages.size + form.cards.size
  const act =
    model.state === 'ready'
      ? { words: ticked > 0 ? t('again.actCount', { pages: form.pages.size, cards: form.cards.size }) : t('again.act'), onAct: () => actions.onPrint?.(), held: model.held ? t(model.held.key, model.held.params) : null, busy: model.busy }
      : null
  // The pages, grouped by piece (one row of tick boxes a piece).
  const pieces = model.pages.reduce<{ salesOrderLineId: string; label: string; pages: AgainPage[] }[]>((groups, page) => {
    const group = groups.find((entry) => entry.salesOrderLineId === page.salesOrderLineId)
    if (group) group.pages.push(page)
    else groups.push({ salesOrderLineId: page.salesOrderLineId, label: page.label, pages: [page] })
    return groups
  }, [])
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={t('again.title')} act={act} size="lg">
      <div className="fw-print">
        {model.state === 'reading' ? <PartReading rows={4} /> : null}
        {model.state === 'failed' ? <Banner tone="danger" title={t('again.readFailed')}>{model.readProblem ? s(model.readProblem) : null}</Banner> : null}
        {model.state === 'ready' ? (
          <>
            <Banner tone="info" icon={<Info size={18} aria-hidden />} title={t('again.nothingStarts')}>
              {t('again.sameCodes')}
            </Banner>
            <fieldset className="fw-print-set">
              <legend className="fw-print-h3">{t('again.why')}</legend>
              <div className="fw-print-chips" role="group" aria-label={t('again.why')}>
                {AGAIN_REASON_KEYS.map(({ reason, key }) => (
                  <FilterChip key={reason} pressed={form.reason === reason} size="md" onClick={() => actions.onForm?.({ ...form, reason })}>
                    {REASON_ICON[reason]} {t(key)}
                  </FilterChip>
                ))}
              </div>
            </fieldset>
            {form.reason === 'SMALL_CHANGE' ? (
              <Field label={t('again.note')} hint={t('again.noteHint')} required>
                <Textarea rows={2} limit={NOTE_MAX} value={form.note} placeholder={t('again.notePlaceholder')} onChange={(event) => actions.onForm?.({ ...form, note: event.target.value })} />
              </Field>
            ) : null}
            <fieldset className="fw-print-set">
              <legend className="fw-print-h3">{t('again.pages', { count: model.pages.length })}</legend>
              {pieces.length === 0 ? <p className="fw-print-mu">{t('again.noPages')}</p> : null}
              {pieces.map((piece) => (
                <div key={piece.salesOrderLineId} className="fw-print-piece">
                  <span className="fw-print-piece-t">{piece.label}</span>
                  <span className="fw-print-ticks">
                    {piece.pages.map((page) => (
                      <Checkbox key={page.key} checked={form.pages.has(page.key)} onChange={() => actions.onTickPage?.(page.key)} label={t('again.page', { n: page.page })} />
                    ))}
                  </span>
                </div>
              ))}
            </fieldset>
            <fieldset className="fw-print-set">
              <legend className="fw-print-h3">{t('again.cards', { count: model.cards.length })}</legend>
              {model.cards.length > 1 ? (
                <span className="fw-print-ticks">
                  <Button size="sm" variant="quiet" onClick={() => actions.onAllCards?.(true)}>
                    {t('again.allCards')}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => actions.onAllCards?.(false)}>
                    {t('again.noCards')}
                  </Button>
                </span>
              ) : null}
              {model.cardsMissing ? <p className="fw-print-mu">{t('again.cardsMissing')}</p> : null}
              {!model.cardsMissing && model.cards.length === 0 ? <p className="fw-print-mu">{t('again.noCardsOnFloor')}</p> : null}
              <div className="fw-print-cards">
                {model.cards.map((card) => (
                  <Checkbox
                    key={card.bundleId}
                    checked={form.cards.has(card.bundleId)}
                    onChange={() => actions.onTickCard?.(card.bundleId)}
                    label={`${card.basketNo} · ${card.label}${card.printNo > 1 ? ` · ${t('again.printedTimes', { count: card.printNo })}` : ''}`}
                  />
                ))}
              </div>
            </fieldset>
          </>
        ) : null}
        {model.writeProblem ? (
          <Banner tone="danger" title={s(model.writeProblem.key)}>
            {model.writeProblem.detail}
          </Banner>
        ) : null}
      </div>
    </WindowShell>
  )
}
