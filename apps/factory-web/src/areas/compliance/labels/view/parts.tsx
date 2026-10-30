'use client'

import { Fragment, type ReactNode } from 'react'
import { Banner, Modal } from '@nexus/ui/components'
import { LabelPreview, type LabelPrintState } from '@nexus/ui/components/LabelPreview/index'
import { Button, Kbd, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { QualityMessages } from '../../../quality/_shared/parts'
import type { LabelTemplate, Rendered } from '../api'
import { sheetOf, STATUS_TONE, type StandIn } from '../model'
import '../labels.css'

/**
 * The parts both Labels & marking screens draw (the list and the label record, SCR-053): the screen's words with the
 * shared quality words, the status pill (a word with every colour), the label sheet — the DS LabelPreview to scale, with
 * the CE mark, the EN 17092 pictogram and the care symbols drawn as STAND-INS (words in a dashed box, never the
 * artwork: the real artwork is an outside item for the Owner) — and the keys dialog. Nothing here fetches.
 */

export function LabelsMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={['labels']}>{children}</QualityMessages>
}

export function StatusPill({ status }: { status: LabelTemplate['status'] }) {
  const t = useT('labels')
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

/** A stand-in mark: a dashed box with the words of what it stands for, filling its square (an SVG scales with the label). */
function StandInMark({ mark, standIn }: { mark: StandIn; standIn: string }) {
  const lines = mark.kind === 'ce' ? ['CE', standIn] : mark.kind === 'pictogram' ? [...mark.text.split(' ').filter(Boolean), standIn] : [mark.text]
  const size = mark.kind === 'care' ? 30 : lines.length > 2 ? 17 : 20
  const top = 50 - ((lines.length - 1) * size * 1.1) / 2
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden className="fw-lb-standin" data-kind={mark.kind}>
      <rect x="3" y="3" width="94" height="94" rx="6" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray="9 6" />
      {lines.map((line, index) => (
        <text key={index} x="50" y={top + index * size * 1.1} textAnchor="middle" dominantBaseline="middle" fontSize={size} fill="currentColor">
          {line}
        </text>
      ))}
    </svg>
  )
}

/**
 * The label sheet: the rendered label to scale (paper and ink in both themes), the stand-ins named above it, and — for a
 * test print — the job's state with Retry. `test` marks it "TEST – not for garments" on the sheet itself.
 */
export function LabelSheet({ label, widthMm, heightMm, test, print, onRetry, retryHeld, scale }: { label: Rendered; widthMm: number; heightMm: number; test?: boolean; print?: LabelPrintState; onRetry?: () => void; retryHeld?: string | null; scale?: number }) {
  const t = useT('labels')
  const sheet = sheetOf(label, widthMm, heightMm, {
    name: t('sheet.name', { code: label.template.code, revision: label.template.revision }),
    ce: t('sheet.ce'),
    pictogram: (standard, ppeClass) => t('sheet.pictogram', { standard: standard || '—', class: ppeClass || '—' }),
    care: (words) => t('sheet.care', { words }),
    test: test ? t('sheet.test') : null,
  })
  const hasStandIns = Object.keys(sheet.marks).length > 0
  return (
    <div className="fw-lb-sheet">
      {hasStandIns && <Banner tone="warning" title={t('sheet.standInsTitle')}>{t('sheet.standInsBody')}</Banner>}
      <div className="fw-lb-sheet-paper">
        <LabelPreview
          layout={sheet.layout}
          scale={scale ?? 4}
          renderMark={(id) => {
            const mark = sheet.marks[id]
            return mark ? <StandInMark mark={mark} standIn={t('sheet.standIn')} /> : null
          }}
          codeLabel={(value) => t('sheet.barcode', { value })}
          invalidCodeLabel={(value) => t('sheet.barcodeInvalid', { value })}
          print={print}
          onRetry={onRetry}
          retryLabel={t('test.retry')}
          retryHeldReason={retryHeld ?? null}
        />
      </div>
      <p className="fw-q-hint">{t('sheet.textSize')}</p>
    </div>
  )
}

/** The page's keys in a dialog (`?`, and the keys panel's "All shortcuts"). */
export function ShortcutsDialog({ open, keys, onClose }: { open: boolean; keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose?: () => void }) {
  const t = useT('labels')
  const q = useT('quality')
  return (
    <Modal open={open} onClose={() => onClose?.()} title={t('keys.title')} size="sm" footer={<Button onClick={() => onClose?.()}>{q('common.close')}</Button>}>
      <dl className="fw-lb-keymap">
        {keys.map((entry) => (
          <Fragment key={entry.does}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does}</dd>
          </Fragment>
        ))}
      </dl>
    </Modal>
  )
}

/** A key's words: a `lists` message key (the frame's keys), else the screen's own words. */
export function useListWords() {
  const t = useT('lists')
  return (does: string) => {
    const text = t(does)
    return text === does ? does : text
  }
}
