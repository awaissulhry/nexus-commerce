'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { readProblem, romeToday } from '../../_shared/model'
import { payProblem, scoped, type PayProblem, type Phrase } from '../../payments/riba/depth'
import { PayStepUp } from '../../payments/riba/view/PayStepUp'
import { approveProposal, createProposal, getProposal, listProposals, proposalCandidates, putLines, reasonMove, recordProposalPaid, type Proposal } from './api'
import { defaultPicks, linesOf, mondayOf, proposalCanOf, proposalRefusals, proposalTouched } from './model'
import { ProposalButton } from './view/ProposalButton'
import { ProposalDialog, type ProposalStage } from './view/ProposalDialog'

/**
 * The payment proposal's container (B-W2b-425 on B-W2b-403's API; Finance › Payables band "Payment proposal", `?proposal=new|<id>`):
 * the band's primary, then the pop-up — reads the week's candidates (and the company's proposals, to open one of the week),
 * makes a draft of the invoices picked with the discounts typed, changes its lines, approves it (a fresh code FIRST; the
 * maker is refused; above the amount the first yes waits for a second person), sends it back or cancels it with why, and
 * records the transfers made — one write each with an Idempotency-Key and the proposal's version. Live: a proposal or a
 * supplier invoice that moves reads the open stage again.
 */
export function PaymentProposal({ prefix }: { prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => proposalCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? ''
  const today = romeToday()
  const open = params?.get('proposal') ?? null
  const [stage, setStage] = useState<ProposalStage | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<PayProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)
  const stageRef = useRef(stage)
  stageRef.current = stage
  const asked = useRef(0)

  const setAddress = useCallback(
    (value: string | null) => {
      const search = new URLSearchParams(params?.toString() ?? '')
      if (value) search.set('proposal', value)
      else search.delete('proposal')
      const text = search.toString()
      router.replace(text ? `${pathname}?${text}` : pathname)
    },
    [params, pathname, router],
  )

  const readStart = useCallback(
    async (weekStart: string, repick: Proposal | null) => {
      const id = ++asked.current
      setStage((current) => (current?.kind === 'start' ? { ...current, reading: true, problem: null } : current))
      try {
        const [candidates, existing] = await Promise.all([proposalCandidates(api, { companyId, weekStart, ...(repick ? { currency: repick.currency } : {}) }), repick ? Promise.resolve(null) : listProposals(api, { companyId })])
        if (id !== asked.current) return
        setStage((current) => (current?.kind === 'start' ? { ...current, candidates, existing: existing ?? current.existing, reading: false } : current))
      } catch (error) {
        if (id !== asked.current) return
        setStage((current) => (current?.kind === 'start' ? { ...current, candidates: null, reading: false, problem: readProblem(error) } : current))
      }
    },
    [api, companyId],
  )

  const readProposal = useCallback(
    async (proposalId: string) => {
      try {
        const proposal = await getProposal(api, proposalId)
        setStage((current) => (current === null || current.kind === 'proposal' ? { kind: 'proposal', proposal, problem: null } : current))
      } catch (error) {
        setStage((current) => (current === null || current.kind === 'proposal' ? { kind: 'proposal', proposal: null, problem: readProblem(error) } : current))
      }
    },
    [api],
  )

  useEffect(() => {
    setProblem(null)
    setNotice(null)
    if (!open || !can.view || !companyId) {
      setStage(null)
      return
    }
    if (open === 'new') {
      const weekStart = mondayOf(today)
      setStage({ kind: 'start', weekStart, candidates: null, problem: null, reading: true, picked: null, existing: null, repick: null })
      void readStart(weekStart, null)
    } else {
      setStage({ kind: 'proposal', proposal: null, problem: null })
      void readProposal(open)
    }
    // Read when the address opens a proposal; the stage's own moves read again.
  }, [open, can.view, companyId])

  const reread = useCoalesced(() => {
    const current = stageRef.current
    if (current?.kind === 'proposal' && current.proposal) void readProposal(current.proposal.id)
    if (current?.kind === 'start') void readStart(current.weekStart, current.repick)
  }, 800)
  useLive(
    (change) => {
      if (proposalTouched(change)) reread()
    },
    () => reread(),
    can.view && !!open,
  )

  const write = async (run: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await run()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      const words = payProblem(error, 'proposal', proposalRefusals)
      setProblem(words)
      const current = stageRef.current
      if (current?.kind === 'proposal' && current.proposal) void readProposal(current.proposal.id)
    } finally {
      setBusy(false)
    }
  }

  const heldButton = !can.view ? scoped('proposal.held.view') : !companyId ? scoped('proposal.held.company') : null
  const current = stage
  return (
    <>
      <ProposalButton held={heldButton} onOpen={() => setAddress('new')} />
      {current && (
        <ProposalDialog
          model={{ prefix, today, can, stage: current, busy, problem, notice }}
          actions={{
            onClose: () => setAddress(null),
            onDismissNotice: () => setNotice(null),
            onRetry: () => {
              if (current.kind === 'start') void readStart(current.weekStart, current.repick)
              if (current.kind === 'proposal' && open && open !== 'new') void readProposal(current.proposal?.id ?? open)
            },
            onWeek: (weekStart) => {
              setStage((value) => (value?.kind === 'start' ? { ...value, weekStart, picked: null, candidates: null } : value))
              void readStart(weekStart, null)
            },
            onPicked: (ids) => setStage((value) => (value?.kind === 'start' ? { ...value, picked: ids } : value)),
            onCreate: (discounts) => {
              if (current.kind !== 'start' || !current.candidates) return
              const rows = current.candidates.items
              const lines = linesOf(rows, new Set(current.picked ?? defaultPicks(rows)), discounts)
              if (lines.problem) return
              const key = newIdempotencyKey()
              void write(async () => {
                const proposal = await createProposal(api, { companyId, weekStart: current.weekStart, currency: current.candidates!.currency, lines: lines.lines }, key)
                setStage({ kind: 'proposal', proposal, problem: null })
                setNotice({ key: scoped('proposal.notice.created'), params: { week: proposal.week } })
                setAddress(proposal.id)
              })
            },
            onSaveLines: (discounts) => {
              if (current.kind !== 'start' || !current.candidates || !current.repick) return
              const rows = current.candidates.items
              const lines = linesOf(rows, new Set(current.picked ?? defaultPicks(rows)), discounts)
              if (lines.problem) return
              const repick = current.repick
              const key = newIdempotencyKey()
              void write(async () => {
                const proposal = await putLines(api, repick, lines.lines, key)
                setStage({ kind: 'proposal', proposal, problem: null })
                setNotice({ key: scoped('proposal.notice.lines'), params: { count: proposal.totals.lines } })
              })
            },
            onOpen: (proposalId) => setAddress(proposalId),
            onRepick: (proposal) => {
              setProblem(null)
              setNotice(null)
              const picked = proposal.lines.flatMap((line) => (line.invoice ? [line.invoice.id] : []))
              setStage({ kind: 'start', weekStart: proposal.weekStart, candidates: null, problem: null, reading: true, picked, existing: null, repick: proposal })
              void readStart(proposal.weekStart, proposal)
            },
            onStage: (next) => {
              setProblem(null)
              setStage(next)
            },
            onApprove: () => {
              if (current.kind !== 'proposal' || !current.proposal) return
              const proposal = current.proposal
              const key = newIdempotencyKey()
              void write(async () => {
                await ensureFresh(scoped('stepUp.proposal'))
                const answer = await guard(scoped('stepUp.proposal'), () => approveProposal(api, proposal, null, key))
                setStage({ kind: 'proposal', proposal: answer.proposal, problem: null })
                setNotice({ key: scoped(`proposal.notice.approved.${answer.step}`) })
              })
            },
            onReason: (reason) => {
              if (current.kind !== 'reason') return
              const key = newIdempotencyKey()
              void write(async () => {
                const proposal = await reasonMove(api, current.proposal, current.move, reason, key)
                setStage({ kind: 'proposal', proposal, problem: null })
                setNotice({ key: scoped(current.move === 'cancel' ? 'proposal.notice.cancelled' : 'proposal.notice.sentBack') })
              })
            },
            onPaid: (input) => {
              if (current.kind !== 'paid') return
              const key = newIdempotencyKey()
              void write(async () => {
                const answer = await recordProposalPaid(api, current.proposal, input, key)
                setStage({ kind: 'proposal', proposal: answer.proposal, problem: null })
                const sent = answer.remittances.filter((entry) => entry.sent).length
                setNotice(answer.remittances.every((entry) => entry.held === 'SWITCHED_OFF') ? { key: scoped('proposal.notice.paidNoMail'), params: { count: answer.proposal.totals.lines } } : { key: scoped('proposal.notice.paid'), params: { count: answer.proposal.totals.lines, sent, held: answer.remittances.length - sent } })
              })
            },
          }}
        />
      )}
      <PayStepUp stepUp={stepUp} onSubmit={(code) => void submitStepUp(code)} onCancel={cancelStepUp} />
    </>
  )
}
