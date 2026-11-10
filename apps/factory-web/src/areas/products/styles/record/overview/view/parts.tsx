'use client'

import type { ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import type { DepthPart, StyleDepthActions, StyleDepthModel } from '../model'

/** The depth's catalogue. */
export const NS = 'products-styles-depth'
export const useDepthT = () => useT(NS)

/**
 * A part's body while it loads (Skeleton lines), when it failed (the reason in words + Try again; the rest of the record
 * stays usable), or ready (the children with its value).
 */
export function PartBody<T>({ part, actions, lines = 3, children }: { part: DepthPart<T>; actions?: StyleDepthActions; lines?: number; children: (value: T) => ReactNode }) {
  const t = useDepthT()
  if (part.status === 'ready') return <>{children(part.value)}</>
  if (part.status === 'error')
    return (
      <div className="fw-st-stack" role="status">
        <p className="fw-st-hint">{t(part.problem)}</p>
        {actions?.onRetry && (
          <span>
            <Button size="sm" onClick={() => actions.onRetry?.()}>
              {t('base.retry')}
            </Button>
          </span>
        )}
      </div>
    )
  return (
    <div className="fw-st-stack" aria-busy="true">
      <span className="fw-sdp-sr" role="status">
        {t('base.loading')}
      </span>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={18} />
      ))}
    </div>
  )
}

/** The depth's own banner: a write it did, or why it was refused (outside a pop-up). */
export function DepthNotice({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  const t = useDepthT()
  if (!model.notice) return null
  return (
    <Banner
      tone={model.notice.tone}
      title={t(model.notice.key, noticeParams(model.notice.params, t))}
      action={
        actions?.onDismissNotice ? (
          <Button size="sm" variant="quiet" onClick={() => actions.onDismissNotice?.()}>
            {t('base.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** A notice's params: a lifecycle state is said in words. */
function noticeParams(params: Record<string, string | number> | undefined, t: (key: string) => string): Record<string, string | number> | undefined {
  if (!params) return params
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, name === 'state' ? t(`lifecycle.state.${value}`) : value]))
}

/** A refusal said above a pop-up's buttons. */
export function DialogProblem({ problem }: { problem: string | null }) {
  const t = useDepthT()
  return problem ? <Banner tone="danger" title={t(problem)} /> : null
}
