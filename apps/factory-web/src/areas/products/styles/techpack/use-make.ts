'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { listCopyParties, makeTechPackPdf, type CopyPartyRow, type TechPackPdfView } from './api'
import { failed, makeHeld, makeProblem, ready, reading, startParty, type MakeDraft, type PrivateLabel, type Read, type TechPackAudience, type TechPackCan, type TechPackSection } from './model'
import type { MakeDialogActions, MakeDialogModel } from './view/MakePdfDialog'

/** Opens a tab now (on the click, so no blocker stops it) and sends it to an address that comes later; closes it on a refusal. */
export function openLater(): { go: (url: string) => void; fail: () => void } {
  const tab = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null
  return {
    go: (url) => {
      if (tab && !tab.closed) tab.location.href = url
      else window.open(url, '_blank', 'noopener')
    },
    fail: () => tab?.close(),
  }
}

export interface MakeTarget {
  styleId: string
  styleCode: string
  revision: { id: string; revision: number; status: 'DRAFT' | 'RELEASED' | 'OBSOLETE' } | null
  privateLabel: PrivateLabel | null
  /** A tenant-wide style's copy: the page's company. */
  companyId: string | null
  allowed: readonly TechPackSection[]
}

/**
 * Make tech pack PDF's container hook (B-W2b-243; the tab, the band's ⋯ and the PDF window share it): the draft, the parties a
 * partner copy may name (read once per audience, parties.view), the POST (one idempotency key per press), and what came of it.
 * From the tab the new version opens in a new tab (opened on the press, sent to the window when the API answers); in the window
 * it opens in place.
 */
export function useMakePdf({
  api,
  target,
  can,
  online,
  opensHere,
  windowFor,
  onMade,
}: {
  api: ApiClient
  target: MakeTarget
  can: TechPackCan
  online: boolean
  opensHere: boolean
  /** The PDF window's address of a version. */
  windowFor: (pdf: TechPackPdfView) => string
  onMade: (pdf: TechPackPdfView) => void
}): { model: MakeDialogModel | null; open: (start: Partial<MakeDraft>) => void; actions: MakeDialogActions } {
  const [draft, setDraft] = useState<MakeDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [parties, setParties] = useState<Partial<Record<Exclude<TechPackAudience, 'INTERNAL'>, Read<CopyPartyRow[]>>>>({})
  const asked = useRef(new Set<string>())

  // The parties of a partner audience: read once while the dialog is open (a private-label brand copy needs none).
  const audience = draft?.audience ?? null
  useEffect(() => {
    if (!audience || audience === 'INTERNAL' || !can.parties) return
    if (audience === 'BRAND' && target.privateLabel) return
    if (asked.current.has(audience)) return
    asked.current.add(audience)
    setParties((current) => ({ ...current, [audience]: reading() }))
    listCopyParties(api, audience, target.companyId)
      .then((rows) => setParties((current) => ({ ...current, [audience]: ready(rows) })))
      .catch(() => {
        asked.current.delete(audience)
        setParties((current) => ({ ...current, [audience]: failed('techpack.problem.read.internal') }))
      })
  }, [api, audience, can.parties, target.companyId, target.privateLabel])

  const open = useCallback(
    (start: Partial<MakeDraft>) => {
      const audienceStart = start.audience ?? 'INTERNAL'
      setProblem(null)
      setDraft({
        audience: audienceStart,
        language: start.language ?? 'it',
        sections: (start.sections ?? target.allowed).filter((section) => target.allowed.includes(section)),
        partyId: start.partyId ?? startParty(audienceStart, target.privateLabel),
      })
    },
    [target.allowed, target.privateLabel],
  )

  const submit = async () => {
    if (!draft || !target.revision) return
    if (makeHeld(draft, { can, online, busy, revision: true, privateLabel: target.privateLabel, allowed: target.allowed })) return
    const tab = opensHere ? null : openLater()
    setBusy(true)
    setProblem(null)
    try {
      const pdf = await makeTechPackPdf(api, target.styleId, target.revision.id, {
        audience: draft.audience,
        language: draft.language,
        sections: draft.sections,
        partyId: draft.audience === 'INTERNAL' ? null : draft.partyId,
        companyId: target.companyId,
      })
      tab?.go(windowFor(pdf))
      setDraft(null)
      onMade(pdf)
    } catch (error) {
      tab?.fail()
      setProblem(makeProblem(error))
    } finally {
      setBusy(false)
    }
  }

  const model: MakeDialogModel | null = draft
    ? {
        styleCode: target.styleCode,
        revision: target.revision ? { revision: target.revision.revision, status: target.revision.status } : null,
        draft,
        allowed: target.allowed,
        parties: draft.audience === 'INTERNAL' || !can.parties ? null : (parties[draft.audience] ?? reading()),
        privateLabel: target.privateLabel,
        busy,
        problem,
        opensHere,
      }
    : null

  return {
    model,
    open,
    actions: {
      onDraft: (patch) =>
        setDraft((current) => {
          if (!current) return current
          const next = { ...current, ...patch }
          // Another audience starts its own party: a private-label brand copy names its brand, an internal copy nobody.
          if (patch.audience && patch.audience !== current.audience) next.partyId = startParty(patch.audience, target.privateLabel)
          return next
        }),
      onSubmit: () => void submit(),
      onClose: () => {
        if (!busy) setDraft(null)
      },
    },
  }
}
