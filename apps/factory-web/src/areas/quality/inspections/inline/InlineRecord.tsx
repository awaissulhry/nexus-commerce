'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useT } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { liveMatches, useLive, useRecordTab, useStepUp } from '../../_shared/hooks'
import { failedRead, problemKey, qualityCan, ready, reading, type Read } from '../../_shared/model'
import { RecordProblem, RecordSkeleton } from '../../_shared/parts'
import { getInline, type Inline } from '../depth/api'
import { depthCan } from '../depth/model'
import { DepthMessages } from '../depth/parts'
import { useAmendments } from '../depth/use-amendments'
import { INLINE_TABS, InlineRecordView } from './view/InlineRecordView'

const EVENTS = ['in_process_check.', 'inspection_amendment.'] as const

/**
 * `/w/<company>/quality/inspections/inline/<id>?tab=check|decision` (SCR-076-inline): reads the in-process check (GET
 * /quality/inprocess/checks/:id, quality.inprocess.view) and, once decided, its amendments; the line's changes re-read it live.
 */
export function InlineRecord({ checkId }: { checkId: string }) {
  return (
    <DepthMessages>
      <Container checkId={checkId} />
    </DepthMessages>
  )
}

function Container({ checkId }: { checkId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const t = useT('quality')
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const depth = useMemo(() => depthCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(INLINE_TABS)
  const [read, setRead] = useState<Read<Inline>>(reading())
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const load = useCallback(async () => {
    if (!depth.inprocessView) return
    try {
      setRead(ready(await getInline(api, checkId)))
    } catch (error) {
      setRead(failedRead(problemKey(error)))
    }
  }, [api, checkId, depth.inprocessView])

  useEffect(() => {
    void load()
  }, [load])

  const amendments = useAmendments({ api, kind: 'InProcessCheck', id: checkId, enabled: read.value?.status === 'DECIDED', guard, onSigned: () => void load() })

  useLive(
    (change) => {
      if (!liveMatches(change, EVENTS)) return
      void load()
      if (change.type.startsWith('inspection_amendment.')) void amendments.load()
    },
    () => void load(),
  )

  const back = (
    <Link className="fw-q-link" href={`${prefix}/quality/inspections?kind=inline`}>
      {t('record.back')}
    </Link>
  )
  if (!depth.inprocessView) return <RecordProblem problem="problem.forbidden" back={back} />
  if (read.problem) return <RecordProblem problem={read.problem} back={back} onRetry={() => void load()} />
  if (!read.value) return <RecordSkeleton />

  return (
    <InlineRecordView
      model={{ prefix, tab, read: read.value, depth, workOrdersView: can.workOrdersView, amendments: amendments.state }}
      stepUp={stepUp}
      actions={{
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onOpen: amendments.open,
        onDraft: amendments.setDraft,
        onRefuseReason: amendments.setRefuseReason,
        onRequest: () => void amendments.request(),
        onSign: (id) => void amendments.sign(id),
        onRefuse: () => void amendments.refuse(),
        onRetry: () => void amendments.load(),
        onDismiss: amendments.dismiss,
      }}
    />
  )
}
