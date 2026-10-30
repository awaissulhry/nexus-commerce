'use client'

import { useEffect, useState } from 'react'
import { PartyPopper } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { AdminMessages, PageHead } from '../../shared/view/parts'
import { SetupChecklist } from '../../shared/view/SetupChecklist'
import { AttentionSection } from '../../security/view/AttentionSection'
import { doneCount, type OverviewViewModel } from '../model'

export type { OverviewViewModel } from '../model'

export interface OverviewActions {
  onRecheck?: () => void
  onRetry?: (stepId: string) => void
  /** B-W2a-36: Needs attention read again; Enter on a row opens its page. */
  onAttentionRetry?: () => void
  onOpen?: (href: string) => void
}

/**
 * SCR-165 (W0 part) — Admin › All settings: the "Get the factory ready" checklist (Owner O2) for a non-technical owner,
 * every set-up step with its real state, in order, with "Do it" links to the page that does it. Search, switches and
 * history of All settings come in W3 (O2). It draws ONE view model and fetches nothing (AdminOverview.tsx reads the API).
 */
export function AdminOverviewView({ model, actions }: { model: OverviewViewModel; actions?: OverviewActions }) {
  return (
    <AdminMessages>
      <Overview model={model} actions={actions} />
    </AdminMessages>
  )
}

function Overview({ model, actions }: { model: OverviewViewModel; actions?: OverviewActions }) {
  const t = useT('admin')
  const done = doneCount(model.steps)
  const allDone = model.steps.length > 0 && done === model.steps.length
  const [open, setOpen] = useState(model.showAll || !allDone)
  useEffect(() => setOpen(model.showAll || !allDone), [model.showAll, allDone])
  const checking = model.steps.some((step) => step.state === 'checking')

  return (
    <div className="fw-adm">
      <PageHead
        intro={checking ? t('overview.introChecking') : t('overview.intro', { done, total: model.steps.length })}
        asOf={model.checkedAt}
        actions={
          <Button size="sm" onClick={() => actions?.onRecheck?.()} heldReason={checking ? t('overview.checkingHeld') : null}>
            {t('overview.recheck')}
          </Button>
        }
      />
      {allDone && (
        <Banner
          tone="success"
          icon={<PartyPopper size={16} aria-hidden />}
          title={t('overview.allDone')}
          action={
            <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
              {t(open ? 'overview.hide' : 'overview.show')}
            </Button>
          }
        />
      )}
      {open && <SetupChecklist title={t('overview.title')} steps={model.steps} onRetry={actions?.onRetry} />}
      {model.attention && <AttentionSection attention={model.attention} prefix={model.prefix} onRetry={actions?.onAttentionRetry} onOpen={actions?.onOpen} />}
      <p className="fw-adm-hint">{t('overview.later')}</p>
    </div>
  )
}
