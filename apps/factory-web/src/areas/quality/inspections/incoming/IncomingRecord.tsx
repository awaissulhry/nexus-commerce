'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useT } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { liveMatches, useLive, useRecordTab, useStepUp } from '../../_shared/hooks'
import { failedRead, problemKey, qualityCan, ready, reading, type Notice, type Read } from '../../_shared/model'
import { RecordProblem, RecordSkeleton } from '../../_shared/parts'
import { PlaceHold, type PlaceHoldPrefill } from '../../holds/place/PlaceHold'
import { getIncoming, type Incoming } from '../depth/api'
import { depthCan } from '../depth/model'
import { DepthMessages } from '../depth/parts'
import { useAmendments } from '../depth/use-amendments'
import { INCOMING_TABS, IncomingRecordView } from './view/IncomingRecordView'

const EVENTS = ['incoming_inspection.', 'inspection_amendment.', 'inventory.hide_'] as const

/**
 * `/w/<company>/quality/inspections/incoming/<id>?tab=units|decision` (SCR-076-incoming): reads the incoming inspection (GET
 * /quality/incoming/:id, quality.incoming.view) and, once decided, its amendments; Place hold on its rejected and to-sort
 * hides (the record's own prefill: the holds' one dialog); the bench's changes re-read it live.
 */
export function IncomingRecord({ inspectionId }: { inspectionId: string }) {
  return (
    <DepthMessages>
      <Container inspectionId={inspectionId} />
    </DepthMessages>
  )
}

function Container({ inspectionId }: { inspectionId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const t = useT('quality')
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const depth = useMemo(() => depthCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(INCOMING_TABS)
  const [read, setRead] = useState<Read<Incoming>>(reading())
  const [notice, setNotice] = useState<Notice | null>(null)
  const [hold, setHold] = useState<PlaceHoldPrefill | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const load = useCallback(async () => {
    if (!depth.incomingView) return
    try {
      setRead(ready(await getIncoming(api, inspectionId)))
    } catch (error) {
      setRead(failedRead(problemKey(error)))
    }
  }, [api, depth.incomingView, inspectionId])

  useEffect(() => {
    void load()
  }, [load])

  const amendments = useAmendments({ api, kind: 'IncomingInspection', id: inspectionId, enabled: read.value?.inspection.status === 'DECIDED', guard, onSigned: () => void load() })

  useLive(
    (change) => {
      if (!liveMatches(change, EVENTS)) return
      void load()
      if (change.type.startsWith('inspection_amendment.')) void amendments.load()
    },
    () => void load(),
  )

  const back = (
    <Link className="fw-q-link" href={`${prefix}/quality/inspections?kind=incoming`}>
      {t('record.back')}
    </Link>
  )
  if (!depth.incomingView) return <RecordProblem problem="problem.forbidden" back={back} />
  if (read.problem) return <RecordProblem problem={read.problem} back={back} onRetry={() => void load()} />
  if (!read.value) return <RecordSkeleton />
  const value = read.value

  return (
    <>
      <IncomingRecordView
        model={{ prefix, tab, read: value, can, depth, amendments: amendments.state, notice }}
        stepUp={stepUp}
        actions={{
          onPlaceHold: () => {
            const prefill = value.next?.holdPrefill
            if (!prefill) return
            const codes = [...(value.next?.rejectedHides ?? []), ...(value.next?.toSortHides ?? [])].filter((hide) => prefill.subjectIds.includes(hide.hideId)).map((hide) => hide.code)
            setHold({ subjectType: 'Hide', subjectIds: prefill.subjectIds, codes, fromLabel: value.inspection.number })
          },
          onDismissNotice: () => setNotice(null),
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
      <PlaceHold
        open={hold !== null}
        prefill={hold}
        onClose={() => setHold(null)}
        onPlaced={() => {
          setHold(null)
          setNotice({ key: 'hold.placed', tone: 'success' })
          void load()
        }}
      />
    </>
  )
}
