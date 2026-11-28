'use client'

import type { ReactElement } from 'react'
import { AlertTriangle, CircleAlert, FileText, Layers, ScanLine } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { PartReading } from '../../../../../../lib/record-sections/Kit'
import { WindowShell } from '../../../../../../lib/window-shell/view/WindowShell'
import type { PrintPreview } from '../api'
import { placedLineOf, printsLineOf, problemGroupsOf, reasonShown, REASON_MAX, startStateOf, type Said } from '../model'
import '../print.css'

/**
 * owb-ss4 step 4.1 (design plan word table "Print and start the work…", § 1 row 1, § 4.1, § 5f; office.js modal 'cards') — the window
 * "Print and start the work", drawn with the ONE window frame: what prints (the design pages, and the basket cards — or "Basket cards
 * print at cutting on this site"), "0 of 3 placed — the code goes to the usual place" (never a stop), the work orders it makes and starts,
 * the problems in words in two groups (**Must be fixed first** · **Warnings**), the reason field only when the material warning asks for
 * it; the ONE act **Print and start the work** held with its words. Draws its model; fetches nothing.
 */

export interface PrintStartViewModel {
  readonly open: boolean
  readonly state: 'reading' | 'failed' | 'ready'
  /** Why it could not be read (a `shipments` word: problem.read.*). */
  readonly readProblem: string | null
  readonly orderNumber: string | null
  readonly preview: PrintPreview | null
  readonly reason: string
  readonly held: Said | null
  readonly busy: boolean
  /** A refused start, in the Warehouse's refusal words (`shipments`: problem.write.*); a refusal's list is said again by the preview. */
  readonly writeProblem: { readonly key: string; readonly detail: string | null } | null
}

export interface PrintStartViewActions {
  readonly onClose: () => void
  readonly onReason?: (reason: string) => void
  readonly onStart?: () => void
}

const NO_ACTIONS: PrintStartViewActions = Object.freeze({ onClose: () => undefined })

export function PrintStartView({ model, actions = NO_ACTIONS }: { model: PrintStartViewModel; actions?: PrintStartViewActions }): ReactElement {
  const t = useT('print-start')
  const s = useT('shipments')
  const preview = model.preview
  const act = model.state === 'ready' && preview && startStateOf(preview) !== 'printed' ? { words: t('start.act'), onAct: () => actions.onStart?.(), held: model.held ? t(model.held.key, model.held.params) : null, busy: model.busy } : null
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={t('start.title')} subtitle={model.orderNumber ?? undefined} act={act} size="lg">
      <div className="fw-print">
        {model.state === 'reading' ? <PartReading rows={4} /> : null}
        {model.state === 'failed' ? <Banner tone="danger" title={t('start.readFailed')}>{model.readProblem ? s(model.readProblem) : null}</Banner> : null}
        {model.state === 'ready' && preview ? <Ready preview={preview} model={model} actions={actions} /> : null}
        {model.writeProblem ? (
          <Banner tone="danger" title={s(model.writeProblem.key)}>
            {model.writeProblem.detail}
          </Banner>
        ) : null}
      </div>
    </WindowShell>
  )
}

function Ready({ preview, model, actions }: { preview: PrintPreview; model: PrintStartViewModel; actions: PrintStartViewActions }): ReactElement {
  const t = useT('print-start')
  const locale = useLocale()
  const state = startStateOf(preview)
  if (state === 'printed') return <Banner tone="info" title={t('start.printed', { day: preview.printedAt ? formatDate(preview.printedAt, { locale }) : '—' })}>{t('start.printedWhy')}</Banner>
  if (state === 'notConfirmed') return <Banner tone="warning" title={t('start.notConfirmed')} />
  const prints = printsLineOf(preview)
  const placed = placedLineOf(preview.placed)
  const groups = problemGroupsOf(preview.problems)
  return (
    <>
      <ul className="fw-print-what">
        <li>
          <FileText size={16} aria-hidden /> <b>{t('start.pages', { count: prints.pages })}</b>
        </li>
        <li>
          <Layers size={16} aria-hidden /> <b>{t(prints.cards.key, prints.cards.params)}</b>
        </li>
        <li>
          <ScanLine size={16} aria-hidden /> <span>{t(placed.key, placed.params)}</span>
        </li>
      </ul>
      {preview.basketsAtPrint && preview.baskets.lines.length > 0 ? (
        <ul className="fw-print-list">
          {preview.baskets.lines.map((line) => (
            <li key={line.salesOrderLineId}>
              <span className="fw-print-grow">{line.label}</span>
              <span className="fw-print-mu">{t('start.basketsOfLine', { count: line.baskets })}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <h3 className="fw-print-h3">{t('start.workOrders', { count: preview.workOrders.length })}</h3>
      <ul className="fw-print-list">
        {preview.workOrders.map((row, index) => (
          <li key={row.workOrderId ?? `new-${index}`}>
            <span className="fw-print-mono">{row.number ?? t('start.newWorkOrder')}</span>
            <span className="fw-print-grow">{row.styleCode}</span>
            <span className="fw-print-mu">{t('start.pieces', { count: row.pieces })}</span>
            <Pill tone={row.workOrderId ? 'neutral' : 'info'}>{row.workOrderId ? t('start.willStart') : t('start.willMake')}</Pill>
          </li>
        ))}
      </ul>
      {groups.mustFix.length > 0 ? (
        <Banner tone="danger" icon={<CircleAlert size={18} aria-hidden />} title={t('start.mustFix', { count: groups.mustFix.length })}>
          <ul className="fw-print-problems">
            {groups.mustFix.map((problem, index) => (
              <li key={`${problem.code}-${index}`}>
                {problem.workOrderNumber ? <b>{problem.workOrderNumber}: </b> : null}
                {problem.words}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {groups.warnings.length > 0 ? (
        <Banner tone="warning" icon={<AlertTriangle size={18} aria-hidden />} title={t('start.warnings', { count: groups.warnings.length })}>
          <ul className="fw-print-problems">
            {groups.warnings.map((problem, index) => (
              <li key={`${problem.code}-${index}`}>
                {problem.workOrderNumber ? <b>{problem.workOrderNumber}: </b> : null}
                {problem.words}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {reasonShown(preview) ? (
        <Field label={t('start.reason')} hint={t('start.reasonHint')} required>
          <Textarea rows={2} limit={REASON_MAX} value={model.reason} onChange={(event) => actions.onReason?.(event.target.value)} />
        </Field>
      ) : null}
      <p className="fw-print-hint">{t('start.hint')}</p>
    </>
  )
}
