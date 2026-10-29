'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EmptyState, Modal } from '@nexus/ui/components'
import { SelectionLabel } from '@nexus/ui/grid'
import { Button, Kbd } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../list-frame/model'
import { WithMessages } from '../../../record-panels/i18n'
import { onScreen } from './bulk-model'
import './list.css'

/**
 * What the B-W0-28 lists add around the shared list frame (`src/list-frame/`, Owner rule 2026-10-29): the selection
 * (the page's, or the design gallery's own so ticking works there too), the `?` dialog with every key of the list, the
 * frame's states in our words, and a bulk button (an icon and its words; the DS hides the words first on a narrow card).
 */

/**
 * The selected ids, kept to the rows on screen. With `onSelect` the page owns them; without it (a design case) the view
 * keeps them, starting from the model's.
 */
export function useSelection(given: readonly string[] | undefined, onSelect: ((ids: string[]) => void) | undefined, rowIds: readonly string[]) {
  const [local, setLocal] = useState<readonly string[]>(given ?? [])
  useEffect(() => setLocal(given ?? []), [given])
  const raw = onSelect ? given : local
  const shownKey = rowIds.join('|')
  // The rows on screen change by content, not by identity: their ids joined are the dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selected = useMemo(() => onScreen(raw, rowIds), [raw, shownKey])
  const onChange = useCallback((ids: string[]) => (onSelect ? onSelect(ids) : setLocal(ids)), [onSelect])
  return { selected, onChange }
}

/**
 * The latest value, read when a cell's button is pressed: a page's callbacks are new on each render, and a column
 * definition that held them would rebuild the grid's columns every time.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** `?` on a list (and the footer icon's "All shortcuts"): every key of the list, in a dialog. */
export function useKeysHelp(own: readonly ListKey[], withSelection: boolean) {
  const [open, setOpen] = useState(false)
  const onHelp = useCallback(() => setOpen(true), [])
  const help = open ? (
    <WithMessages namespaces={['lists']}>
      <KeysDialog own={own} withSelection={withSelection} onClose={() => setOpen(false)} />
    </WithMessages>
  ) : null
  return { onHelp, help }
}

function KeysDialog({ own, withSelection, onClose }: { own: readonly ListKey[]; withSelection: boolean; onClose: () => void }) {
  const t = useT('lists')
  const words = (does: string) => {
    const text = t(does)
    return text === does ? does : text
  }
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-list-keymap">
        {listKeys(own, withSelection).map((entry) => (
          <Fragment key={`${entry.keys.join('+')}-${entry.does}`}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key === 'click' ? t('keys.click') : key}</Kbd>
              ))}
            </dt>
            <dd>{words(entry.does)}</dd>
          </Fragment>
        ))}
      </dl>
    </Modal>
  )
}

/** The frame's state when its read failed: the problem in words and Try again (never drawn as an empty list). */
export function ListProblem({ problem, onRetry }: { problem: string; onRetry?: () => void }) {
  const t = useT('admin')
  return (
    <EmptyState
      title={t('list.failedTitle')}
      description={t(problem)}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    />
  )
}

/**
 * One bulk action in the frame's selection bar: an icon and its words (they say the action's reach, "Close 2 series"),
 * held with the reason when it applies to none of the selected rows or the person lacks the right.
 */
export function BulkButton({ icon, label, held, onClick, variant }: { icon: ReactNode; label: string; held: string | null; onClick?: () => void; variant?: 'danger-outline' }) {
  return (
    <Button size="sm" variant={variant} aria-label={label} heldReason={held} onClick={onClick}>
      {icon} <SelectionLabel>{label}</SelectionLabel>
    </Button>
  )
}

/** In a bulk confirm: what the action applies to (by name), and each reason some selected rows are left out. */
export function BulkReach({ names, left, label }: { names: readonly string[]; left: ReadonlyArray<{ why: string; count: number; words: string }>; label: string }) {
  return (
    <div className="fw-adm-bulk-reach">
      <ul className="fw-adm-bulk-names" aria-label={label}>
        {names.map((name, index) => (
          <li key={`${name}-${index}`}>{name}</li>
        ))}
      </ul>
      {left.map((entry) => (
        <p key={entry.why} className="fw-adm-hint">
          {entry.words}
        </p>
      ))}
    </div>
  )
}
