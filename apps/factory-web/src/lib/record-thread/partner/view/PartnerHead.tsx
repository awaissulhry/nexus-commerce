'use client'

import type { ReactNode } from 'react'
import { Info, MoreVertical } from 'lucide-react'
import { DetailPopover, Menu, type MenuItemDef } from '@nexus/ui/components'
import { useT } from '../../../i18n/provider'
import { widthRows } from '../../head/model'
import '../../head/head.css'

/** The partner's keys in the ⓘ: J / K, Enter on a quote, Enter, Shift+Enter, Esc (no modes, no search). A link's guest has no quotes. */
const PARTNER_KEYS: ReadonlyArray<{ readonly glyph: string | { readonly key: string }; readonly key: string; readonly quote?: true }> = [
  { glyph: 'J / K', key: 'keys.jk' },
  { glyph: { key: 'keys.enterKey' }, key: 'keys.quote', quote: true },
  { glyph: { key: 'keys.enterKey' }, key: 'keys.enter' },
  { glyph: { key: 'keys.shiftEnterKey' }, key: 'keys.shiftEnter' },
  { glyph: 'Esc', key: 'keys.esc' },
]

/** The host's width chooser (the portal frame's): its widths, the current one, and the choice (a width, Hide, or back to Default). */
export interface PartnerWidth {
  readonly widths: readonly string[]
  readonly current: string | null
  readonly choose: (width: string) => void
}

/**
 * pt-w2 W2.2 (lane pt-, S6; 10-design §1 row 1): the partner face's ONE head row — the title (the host's: "Messages", "Ask us a
 * question"), the ONE ⓘ (the keys and the host's long sentences: "You can also answer our emails", the designer's rule, price talk —
 * key hints live only here) and, only when the host hands a width chooser, the ⋮ with the office's Width rows (`widthRows`: the
 * portal's three widths, Hide, Default). No record line, no owner, no waiting time, no files, no search. Words: `record-thread-head`
 * (an outside reader's forms: "How it works", "Hide the messages").
 */
export function PartnerHead({ title, label, help, quotes, width }: { title: string; label: string; help: readonly string[]; quotes: boolean; width?: PartnerWidth | null | undefined }): ReactNode {
  const t = useT('record-thread-head')
  const items: MenuItemDef[] = width
    ? [
        { id: 'width-heading', heading: true, label: t('width.title') },
        ...widthRows(width.widths, width.current).map((row) => ({
          id: `width-${row.width}`,
          label: t(`width.${row.width}`),
          ...(row.width === 'hide' || row.width === 'reset' ? {} : { checked: row.checked }),
          onSelect: () => width.choose(row.width),
        })),
      ]
    : []
  return (
    <div className="fw-rth" role="group" aria-label={label}>
      <div className="fw-rth-titleblock">
        <div className="fw-rth-title">
          <span className="fw-rth-title-words">{title}</span>
        </div>
      </div>
      <div className="fw-rth-tools">
        {/* The ONE ⓘ — the only place key hints and the long sentences live. */}
        <DetailPopover trigger={<Info size={18} aria-hidden />} triggerLabel={t('keys.title')} triggerClassName="nds-btn sm quiet icon fw-rth-keys" label={t('keys.title')} hoverDelay={0}>
          <dl className="fw-rth-keylist">
            {PARTNER_KEYS.filter((row) => quotes || !row.quote).map((row) => (
              <div key={row.key} className="fw-rth-keyrow">
                <dt>
                  <kbd className="nds-kbd">{typeof row.glyph === 'string' ? row.glyph : t(row.glyph.key)}</kbd>
                </dt>
                <dd>{t(row.key)}</dd>
              </div>
            ))}
          </dl>
          {help.map((line) => (
            <p key={line} className="fw-rtp-help">
              {line}
            </p>
          ))}
        </DetailPopover>
        {width && items.length > 0 ? <Menu align="right" className="fw-rth-menu" label={<MoreVertical size={18} aria-hidden />} items={items} triggerProps={{ className: 'nds-btn sm quiet icon', 'aria-label': t('more.label') }} /> : null}
      </div>
    </div>
  )
}
