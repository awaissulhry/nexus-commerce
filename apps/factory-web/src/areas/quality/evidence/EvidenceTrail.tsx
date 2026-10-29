'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { failedRead, problemKey, qualityCan, ready, reading, type Read } from '../_shared/model'
import { EVIDENCE_KINDS, getEvidence, type Evidence, type EvidenceKind } from './api'
import { EvidenceTrailView } from './view/EvidenceTrailView'

/**
 * The evidence trail's container (`/w/<company>/compliance/evidence/<batch|serial>/<subject>`, opened in a new tab):
 * reads the trail once (it is a snapshot to show or print; Updated says when) and draws it. quality.inspections.view.
 */
export function EvidenceTrail({ kind, subject }: { kind: string; subject: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const evidenceKind = (EVIDENCE_KINDS as readonly string[]).includes(kind) ? (kind as EvidenceKind) : null
  const [evidence, setEvidence] = useState<Read<Evidence>>(reading())
  const [asOf, setAsOf] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!can.inspectionsView || !evidenceKind) return
    try {
      setEvidence(ready(await getEvidence(api, evidenceKind, subject)))
      setAsOf(new Date().toISOString())
    } catch (error) {
      setEvidence(failedRead(problemKey(error)))
    }
  }, [api, can.inspectionsView, evidenceKind, subject])

  useEffect(() => {
    void load()
  }, [load])

  return <EvidenceTrailView model={{ prefix, kind: evidenceKind, subject, can: { view: can.inspectionsView }, evidence, asOf }} />
}
