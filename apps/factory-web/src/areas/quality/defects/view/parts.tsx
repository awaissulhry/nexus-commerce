'use client'

import type { ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { Mark, Notice } from '../model'

/** The catalogues of this page: its own, the shared quality words, the list frame's, the reason editor's icon and colour words, the photo kit's. */
export const DEFECT_NAMESPACES = ['defects', 'reasons', 'photo-kit'] as const

/** A cell's save mark: saving / unknown (the DS CellSaveMark), refused ("!" with its reason); nothing once saved. */
export function SaveMark({ mark }: { mark: Mark | undefined }) {
  const t = useT('defects')
  if (!mark || mark.state === 'saved') return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'problem.failed')
    return (
      <span className="fw-df-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

/** The page's notice: a save, a bulk result with each refused code named, a refusal. */
export function DefectsNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss?: () => void }) {
  const t = useT('defects')
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={t(notice.key, notice.params as Record<string, string | number> | undefined)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    >
      {notice.refused && notice.refused.length > 0 ? (
        <ul className="fw-df-lines">
          {notice.refused.map((entry) => (
            <li key={entry.code}>
              <b>{entry.code}</b> — {t(entry.key)}
            </li>
          ))}
        </ul>
      ) : null}
    </Banner>
  )
}

/** A small labelled block of the drawer. */
export function DrawerBlock({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <section className="fw-df-block">
      <h3 className="fw-df-block-title">{title}</h3>
      {sub && <p className="fw-df-sub">{sub}</p>}
      {children}
    </section>
  )
}

/** Whether a key press is typing (a field, a menu, a dialog): the page's own keys skip it. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  return element.closest?.('input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"], .ag-cell-inline-editing, .ag-popup-editor') != null
}
