'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight, Info } from 'lucide-react'
import { DetailPopover } from '@nexus/ui/components'
import { useT } from '../../../../../../lib/i18n/provider'
import { CS_NS } from '../../versions/model'

/**
 * The cost sheets' small parts shared by the Cost tab's W2b cards (B-W2b-430): a step of the sheet that opens to the lines
 * behind it (W1's sheet does the same: the DS Disclosure's summary does not stretch to a figure row) and "How is this
 * made?" (the DS DetailPopover with the formula and its numbers).
 */
export function SheetStep({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="fw-st-step">
      <button type="button" className="fw-st-step-head" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <ChevronRight size={14} className="fw-st-step-chevron" aria-hidden />
        {summary}
      </button>
      {open && <div className="fw-st-step-body">{children}</div>}
    </div>
  )
}

export function How({ label, children }: { label: string; children: ReactNode }) {
  const t = useT(CS_NS)
  return (
    <DetailPopover trigger={<Info size={13} aria-hidden />} triggerLabel={t('steps.how', { what: label })} triggerClassName="fw-st-how" label={t('steps.howTitle')} hoverDelay={250}>
      <div className="fw-st-howbody">{children}</div>
    </DetailPopover>
  )
}
