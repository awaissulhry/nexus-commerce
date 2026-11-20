'use client'

import { useEffect, useRef, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { changeCountOf, type LinesDraft } from '../../lines-draft'
import type { LinesTabActions } from '../../lines-tab-model'
import { Frame } from '../Dialogs'
import { lineNameOf } from './StyleTable'

/**
 * F-OL-03 (Order LINES lane; 10-design-tab §11, 11-design-dialogs D-k; 18-lead-settles F14, F27, F28) — the save bar, only while
 * the draft holds a change: the DS EditModeBar as it is, "{n} changes not saved" with "Undo last edit" inside its message, Discard
 * (it asks "Discard {n} changes?" naming what is lost), "Review and save…" (⌘S; held with the first thing that stops it, said for its
 * cell). ⌘Z outside a box with its own text history takes the last draft step back (no redo). Leaving the page with changes asks
 * first (the bar's own guard). Fetches nothing.
 */
export function SaveBar({ order, draft, canUndo, held, saving, actions }: { order: Order; draft: LinesDraft; canUndo: boolean; held: string | null; saving: boolean; actions?: LinesTabActions }) {
  const t = useT('orders')
  const [confirm, setConfirm] = useState(false)
  const count = changeCountOf(draft)
  const undo = useRef(actions?.onUndo)
  undo.current = actions?.onUndo
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      // A box keeps its own text history; a window (a dialog) its own keys.
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      event.preventDefault()
      undo.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (count === 0) return null
  const names = [...Object.keys(draft.lines), ...draft.added.map((line) => line.key)].map((key) => lineNameOf(order, draft, key))
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} ${t('save.discard.more', { count: names.length - 3 })}` : names.join(', ')
  return (
    <div className="fw-lt-bar">
      <EditModeBar
        message={
          <span className="fw-lt-bar-words">
            <strong>{t('save.count', { count })}</strong>
            <Button size="sm" variant="quiet" heldReason={canUndo ? null : t('save.nothingToUndo')} onClick={() => actions?.onUndo?.()} aria-keyshortcuts="Meta+Z Control+Z">
              <Undo2 size={14} aria-hidden /> {t('save.undo')}
            </Button>
          </span>
        }
        count={count}
        onDiscard={() => setConfirm(true)}
        onApply={() => actions?.onReview?.()}
        applyLabel={saving ? t('save.saving') : t('save.review')}
        applyHeldReason={held}
        busy={saving}
        saveShortcut
      />
      {confirm && (
        <Frame
          title={t('save.discard.title', { count })}
          held={null}
          go={() => {
            setConfirm(false)
            actions?.onDiscard?.()
          }}
          goLabel={t('save.discard.go', { count })}
          onClose={() => setConfirm(false)}
          problem={null}
          size="sm"
          tone="danger"
          closeLabel={t('save.discard.keep')}
        >
          <p className="fw-so-hint">{t('save.discard.body', { list })}</p>
        </Frame>
      )}
    </div>
  )
}
