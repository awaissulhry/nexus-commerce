'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { ClipboardPaste, FileInput } from 'lucide-react'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { useDepthWords } from '../words'
import { WarningsSection, type WarningsModel } from './WarningsSection'

export type LinesView = 'blocks' | 'table'

export interface LinesTopModel {
  warnings: WarningsModel
  view: LinesView
}

/**
 * Above the Lines tab's composer (B-W2b-316): the Warnings section and the Blocks | Table switch (`t` switches, never while
 * typing or in a dialog; the view is the address's `view=table`).
 */
export function LinesTop({ model, onView, onRetryWarnings }: { model: LinesTopModel; onView?: (view: LinesView) => void; onRetryWarnings?: () => void }) {
  const { t } = useDepthWords()
  const latest = useRef({ view: model.view, onView })
  latest.current = { view: model.view, onView }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 't' || event.metaKey || event.ctrlKey || event.altKey) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], .ag-root') || target.isContentEditable)) return
      event.preventDefault()
      latest.current.onView?.(latest.current.view === 'table' ? 'blocks' : 'table')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="fw-q-stack">
      <WarningsSection model={model.warnings} onRetry={onRetryWarnings} />
      <div className="fw-qd-viewbar">
        <SegmentedControl
          size="sm"
          ariaLabel={t('view.label')}
          value={model.view}
          onChange={(value) => onView?.(value === 'table' ? 'table' : 'blocks')}
          options={[
            { value: 'blocks', label: t('view.blocks') },
            { value: 'table', label: t('view.table') },
          ]}
        />
        <span className="fw-q-hint">{t(model.view === 'table' ? 'view.tableHint' : 'view.blocksHint')}</span>
      </div>
    </div>
  )
}

export interface ComposerExtraModel {
  /** The quote came from an inquiry: its number and address (RECORD_PAGES.Inquiry). */
  inquiry: { number: string; href: string } | null
}

/** Lines › Add a style › Also (design quote.lines.composer): Paste lines (W2b) and From inquiry when the quote came from one. */
export function ComposerExtra({ model, onPaste }: { model: ComposerExtraModel; onPaste?: () => void }) {
  const { t } = useDepthWords()
  return (
    <div className="fw-qd-also">
      <span className="fw-q-hint">{t('composer.also')}</span>
      <Button size="sm" onClick={() => onPaste?.()}>
        <ClipboardPaste size={14} aria-hidden /> {t('composer.paste')}
      </Button>
      {model.inquiry && (
        <Link className="fw-q-hint fw-qd-inline" href={model.inquiry.href}>
          <FileInput size={14} aria-hidden /> {t('composer.fromInquiry', { number: model.inquiry.number })}
        </Link>
      )}
    </div>
  )
}
