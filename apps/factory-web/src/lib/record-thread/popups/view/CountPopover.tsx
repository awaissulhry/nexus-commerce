'use client'

import { useId, type ReactNode } from 'react'
import { DetailPopover } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { COUNT_LINES_MAX, type CountPopoverModel } from '../model'
import { POPUPS_NS } from './FileViewer'
import '../popups.css'

/**
 * One count popover (B-TH-211, T-POP-F06): the Head's chip "2 tasks" opens a small popover with the lines the reader may
 * see and ONE action (Add task · Ask a partner to approve · Share with a partner · Add a colleague) — held with its reason
 * when the person lacks the right. Enter opens it, Esc closes it and the focus returns to the chip. No second tab row.
 */
export function CountPopover({ model, trigger, triggerLabel, onAction, open, onOpenChange }: { model: CountPopoverModel; trigger: ReactNode; triggerLabel: string; onAction?: () => void; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return (
    <WithMessages namespaces={[POPUPS_NS]}>
      <Popover model={model} trigger={trigger} triggerLabel={triggerLabel} onAction={onAction} open={open} onOpenChange={onOpenChange} />
    </WithMessages>
  )
}

function Popover({ model, trigger, triggerLabel, onAction, open, onOpenChange }: { model: CountPopoverModel; trigger: ReactNode; triggerLabel: string; onAction?: (() => void) | undefined; open?: boolean | undefined; onOpenChange?: ((open: boolean) => void) | undefined }) {
  const t = useT(POPUPS_NS)
  const headingId = useId()
  const shown = model.lines.slice(0, COUNT_LINES_MAX)
  const more = model.count - shown.length
  return (
    <DetailPopover
      trigger={trigger}
      triggerLabel={triggerLabel}
      triggerClassName="fw-rtp-countchip"
      label={t(`count.title.${model.kind}`, { count: model.count })}
      hoverDelay={0}
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {({ close }) => (
        <div className="fw-rtp-count" aria-labelledby={headingId}>
          <p id={headingId} className="fw-rtp-count-title">
            {t(`count.title.${model.kind}`, { count: model.count })}
          </p>
          {shown.length > 0 ? (
            <ul className="fw-rtp-count-lines">
              {shown.map((line) => (
                <li key={line.id}>
                  <span className="fw-rtp-count-label">{line.label}</span>
                  {line.meta && <span className="fw-rtp-muted">{line.meta}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="fw-rtp-muted">{t(`count.none.${model.kind}`)}</p>
          )}
          {more > 0 && <p className="fw-rtp-muted">{t('count.more', { count: more })}</p>}
          <Button
            size="sm"
            variant="primary"
            heldReason={model.held ?? null}
            onClick={() => {
              close()
              onAction?.()
            }}
          >
            {t(`count.action.${model.kind}`)}
          </Button>
        </div>
      )}
    </DetailPopover>
  )
}
