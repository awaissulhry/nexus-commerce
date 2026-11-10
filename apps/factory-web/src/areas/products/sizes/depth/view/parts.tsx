'use client'

import type { ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button, Kbd } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { DepthProblem } from '../model'
import '../depth.css'

/**
 * The parts Sizes & measurements in depth draws (B-W2b-240), from design-system parts only; nothing here fetches.
 */

/** A list's head: one plain sentence, the freshness, the actions (primary last). */
export function DepthHead({ intro, status, actions }: { intro: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-szd-head">
      <div className="fw-szd-headtext">
        <p className="fw-szd-sub">{intro}</p>
        {status}
      </div>
      {actions && <div className="fw-szd-actions">{actions}</div>}
    </div>
  )
}

/** A page key only when nothing is typed into and no modifier is held. */
export function isTypingKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return true
  const target = event.target as HTMLElement | null
  if (!target) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || !!target.closest?.('[role="dialog"], .ag-cell-inline-editing')
}

/** A refused write: our words, with the API's own sentences under them (as the libraries do). */
export function ProblemBanner({ problem, onReload }: { problem: DepthProblem; onReload?: () => void }) {
  const t = useT('products-sizes-depth')
  return (
    <Banner
      tone={problem.key === 'problem.write.moved' ? 'warning' : 'danger'}
      title={t(problem.key)}
      action={
        problem.reload && onReload ? (
          <Button size="sm" onClick={onReload}>
            {t('common.readAgain')}
          </Button>
        ) : undefined
      }
    >
      {problem.messages.length > 0 && (
        <ul className="fw-szd-list">
          {problem.messages.slice(0, 6).map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** The page's keys in full ("?" or the footer icon's "All keys"). */
export function KeysDialog({ keys, onClose }: { keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose: () => void }) {
  const t = useT('products-sizes-depth')
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} size="sm" title={t('common.keysTitle')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <dl className="fw-szd-keys">
        {keys.map((entry) => (
          <div key={entry.keys.join('+')}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
