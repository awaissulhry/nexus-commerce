'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, Clock } from 'lucide-react'
import { Button, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { listRetention } from '../retention/api'
import { retentionCan } from '../retention/model'
import { listRequests } from './api'
import { isDepthEvent, requestsCan } from './model'
import { DepthMessages } from './view/RequestsView'

/** One duty line's facts: requests (open and late), retention (rules, how many apply). null: not shown / not read. */
export interface DepthDutiesModel {
  requests: { open: number; late: number } | null
  retention: { rules: number; applying: number } | null
}

type DutyState = 'done' | 'needs' | 'review'
const ICON = { done: CheckCircle2, needs: CircleAlert, review: Clock } as const
const TONE = { done: 'success', needs: 'warning', review: 'info' } as const

/** The two duties' states and words (design admin.privacy sec:duties "Data requests answered within 30 days · Retention rules set"). */
export function depthDutyLines(model: DepthDutiesModel): { key: 'requests' | 'retention'; state: DutyState; words: { key: string; params?: Record<string, number> }; view: 'requests' | 'retention' }[] {
  const lines: ReturnType<typeof depthDutyLines> = []
  if (model.requests) {
    const { open, late } = model.requests
    lines.push({ key: 'requests', view: 'requests', state: late > 0 ? 'needs' : open > 0 ? 'review' : 'done', words: late > 0 ? { key: 'dp.duty.requests.late', params: { count: late } } : open > 0 ? { key: 'dp.duty.requests.open', params: { count: open } } : { key: 'dp.duty.requests.none' } })
  }
  if (model.retention) {
    const { rules, applying } = model.retention
    lines.push({ key: 'retention', view: 'retention', state: rules === 0 ? 'needs' : applying > 0 ? 'done' : 'review', words: rules === 0 ? { key: 'dp.duty.retention.none' } : applying > 0 ? { key: 'dp.duty.retention.applying', params: { count: rules, applying } } : { key: 'dp.duty.retention.reporting', params: { count: rules } } })
  }
  return lines
}

/**
 * The duties card's two W2b lines (B-W2b-414, in place of "Data requests and retention rules come in a later step"): data requests
 * answered within 30 days (open and late, privacy.requests.view only) and retention rules set (all reporting until a person
 * switches one on). Each opens its list. Drawn by `DepthDutiesView`.
 */
export function DepthDuties({ companyId, onView }: { companyId: string | null; onView: (view: 'requests' | 'retention') => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const requests = useMemo(() => requestsCan(session.permissions), [session.permissions])
  const retention = useMemo(() => retentionCan(session.permissions), [session.permissions])
  const [model, setModel] = useState<DepthDutiesModel>({ requests: null, retention: null })
  const load = useCallback(async () => {
    const [r, k] = await Promise.allSettled([requests.view ? listRequests(api, { companyId, view: 'open', kind: null }) : Promise.reject(), retention.view ? listRetention(api, companyId) : Promise.reject()])
    setModel({
      requests: r.status === 'fulfilled' ? { open: r.value.counts.open, late: r.value.counts.overdue } : null,
      retention: k.status === 'fulfilled' ? { rules: k.value.rules.filter((rule) => rule.active).length, applying: k.value.rules.filter((rule) => rule.active && rule.applyOn).length } : null,
    })
  }, [api, companyId, requests.view, retention.view])
  useEffect(() => {
    void load()
  }, [load])
  // A request or a rule changed (here or elsewhere): the two lines read their counts again.
  const refresh = useCoalesced(() => void load(), 1500)
  useLive((change) => isDepthEvent(change.type) && refresh(), () => void load(), requests.view || retention.view)
  return <DepthDutiesView model={model} onView={onView} />
}

export function DepthDutiesView({ model, onView }: { model: DepthDutiesModel; onView?: (view: 'requests' | 'retention') => void }) {
  return (
    <DepthMessages>
      <Lines model={model} onView={onView} />
    </DepthMessages>
  )
}

function Lines({ model, onView }: { model: DepthDutiesModel; onView?: (view: 'requests' | 'retention') => void }) {
  const t = useT('admin-privacy-depth')
  const lines = depthDutyLines(model)
  if (lines.length === 0) return null
  return (
    <ol className="fw-pv-duties" aria-label={t('dp.duty.label')}>
      {lines.map((line) => {
        const Icon = ICON[line.state]
        return (
          <li key={line.key} className={`fw-pv-duty is-${line.state}`}>
            <span className="fw-pv-duty-icon" aria-hidden>
              <Icon size={18} />
            </span>
            <span className="fw-pv-duty-body">
              <span className="fw-pv-duty-line">
                <span className="fw-pv-duty-name">{t(`dp.duty.${line.key}.name`)}</span>
                <Pill tone={TONE[line.state]}>{t(`dp.duty.state.${line.state}`)}</Pill>
              </span>
              <span className="fw-pv-duty-words">{t(line.words.key, line.words.params)}</span>
              <span className="fw-pv-duty-law">{t(`dp.duty.${line.key}.law`)}</span>
            </span>
            <span className="fw-pv-duty-go">
              <Button size="sm" variant={line.state === 'needs' ? 'primary' : 'quiet'} onClick={() => onView?.(line.view)}>
                {t(line.state === 'needs' ? 'dp.duty.doIt' : 'dp.duty.open')}
                <span className="fw-pv-sr"> {t(`dp.duty.${line.key}.name`)}</span>
              </Button>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
