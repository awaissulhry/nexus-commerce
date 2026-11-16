'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { storeUrl } from '../../../../record-panels/store'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem, romeToday, type Phrase } from '../../_shared/model'
import { getTaxSettings } from '../../settings/tax/api'
import { checkDeclaration, createDeclaration, getCustomers, intentTouched, listDeclarations, revokeDeclaration, uploadReceipt, type Declaration } from './api'
import { addFieldProblems, addInput, emptyAddDraft, intentAbilitiesOf, intentProblem, NAMESPACE, ReceiptHeldError, yearsOf, type IntentProblem, type StateFilter } from './model'
import { DeclarationsDialog, type DeclarationForm } from './view/DeclarationsDialog'

/**
 * Declarations of intent (B-W2b-GB02, G152 on B-W2b-392's API), opened from Invoices' ⋯ or a declaration's link
 * (`?intent=<id>`): the address's company, this year by default; the company's declarations switch from the tax set-up;
 * a new declaration, its check with the receipt (uploaded onto the declaration, then the check), its revocation — each one
 * write with an Idempotency-Key and the declaration's version; reads again on a declaration's, the switches' or an issue's
 * live event.
 */
export function Declarations({ onClose, openId = null }: { onClose: () => void; openId?: string | null }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/finance\/invoices\/?$/, '')
  const can = useMemo(() => intentAbilitiesOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const today = romeToday()
  // A declaration opened by its link shows whatever its year.
  const [year, setYear] = useState<number | null>(openId ? null : Number(today.slice(0, 4)))
  const [state, setState] = useState<StateFilter>('ALL')
  const [list, setList] = useState<{ value: Declaration[] | null; problem: string | null }>({ value: null, problem: null })
  const [switchOn, setSwitchOn] = useState<boolean | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(openId)
  const [form, setForm] = useState<DeclarationForm | null>(null)
  const receipt = useRef<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<IntentProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)

  const read = useCallback(async () => {
    if (!companyId) return
    try {
      setList({ value: await listDeclarations(api, { companyId, year, state: state === 'ALL' ? null : state }), problem: null })
    } catch (error) {
      setList({ value: null, problem: readProblem(error) })
    }
  }, [api, companyId, year, state])
  const readSwitch = useCallback(async () => {
    try {
      const companies = await getTaxSettings(api)
      setSwitchOn(companies.find((company) => company.companyId === companyId)?.switches.declarationsOfIntentOn ?? null)
    } catch {
      setSwitchOn(null)
    }
  }, [api, companyId])
  useEffect(() => {
    setList({ value: null, problem: null })
    void read()
  }, [read])
  useEffect(() => {
    void readSwitch()
  }, [readSwitch])
  const reread = useCoalesced(() => {
    void read()
    void readSwitch()
  }, 900)
  useLive(
    (change) => {
      if (intentTouched(change)) reread()
    },
    () => reread(),
  )

  const selected = list.value?.find((row) => row.id === selectedId) ?? null

  const write = async (work: () => Promise<Phrase>, onRefused?: (error: unknown) => void) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      setNotice(await work())
      setForm(null)
      receipt.current = null
      await read()
    } catch (error) {
      const words = intentProblem(error)
      setProblem(words)
      onRefused?.(error)
      if (words.reload) void read()
    } finally {
      setBusy(false)
    }
  }

  return (
    <DeclarationsDialog
      model={{ can, prefix, today, switchOn, year, years: yearsOf(today), state, list, selectedId, form, busy, problem, notice }}
      actions={{
        onYear: setYear,
        onState: setState,
        onSelect: (id) => {
          setForm((open) => (open?.kind === 'add' ? open : null))
          setProblem(null)
          setSelectedId(id)
        },
        onRetry: () => void read(),
        onAdd: () => {
          if (!companyId) return
          setProblem(null)
          setForm({ kind: 'add', draft: emptyAddDraft(today), customers: { value: null, problem: null }, fieldProblems: {} })
          getCustomers(api, companyId)
            .then((customers) => setForm((open) => (open?.kind === 'add' ? { ...open, customers: { value: customers, problem: null } } : open)))
            .catch((error: unknown) => setForm((open) => (open?.kind === 'add' ? { ...open, customers: { value: null, problem: readProblem(error) } } : open)))
        },
        onDraft: (patch) =>
          setForm((open) => {
            if (open?.kind !== 'add') return open
            const draft = { ...open.draft, ...patch }
            // A new protocol date keeps a year it allows (its own, or the next one).
            if (patch.protocolDate !== undefined) {
              const protocolYear = Number(patch.protocolDate.slice(0, 4))
              if (draft.year !== protocolYear && draft.year !== protocolYear + 1) draft.year = Number.isFinite(protocolYear) ? protocolYear : null
            }
            return { ...open, draft, fieldProblems: {} }
          }),
        onSubmitAdd: () => {
          if (form?.kind !== 'add' || !companyId) return
          const input = addInput(form.draft, companyId, today)
          if (!input) return
          const key = newIdempotencyKey()
          void write(
            async () => {
              const made = await createDeclaration(api, input, key)
              setSelectedId(made.id)
              if (year !== null && made.year !== year) setYear(made.year)
              return { key: 'notice.added', params: { protocol: made.protocolNumber } }
            },
            (error) => setForm((open) => (open?.kind === 'add' ? { ...open, fieldProblems: addFieldProblems(error) } : open)),
          )
        },
        onCheck: () => {
          setProblem(null)
          receipt.current = null
          setForm({ kind: 'check', file: null })
        },
        onReceipt: (file) => {
          receipt.current = file
          setForm({ kind: 'check', file: file ? { name: file.name } : null })
        },
        onSubmitCheck: () => {
          const file = receipt.current
          if (!selected || !file) return
          const target = selected
          void write(async () => {
            const uploaded = await uploadReceipt(api, target, file)
            if (!uploaded.available) throw new ReceiptHeldError()
            const checked = await checkDeclaration(api, target, uploaded.id, newIdempotencyKey())
            return { key: 'notice.checked', params: { protocol: checked.protocolNumber } }
          })
        },
        onRevoke: () => {
          setProblem(null)
          setForm({ kind: 'revoke', reason: '' })
        },
        onReason: (reason) => setForm({ kind: 'revoke', reason }),
        onSubmitRevoke: () => {
          if (!selected || form?.kind !== 'revoke') return
          const target = selected
          const reason = form.reason
          void write(async () => {
            const revoked = await revokeDeclaration(api, target, reason, newIdempotencyKey())
            return { key: 'notice.revoked', params: { protocol: revoked.protocolNumber } }
          })
        },
        onCancelForm: () => {
          receipt.current = null
          setForm(null)
        },
        onOpenReceipt: (fileId) => {
          void (async () => {
            try {
              const { download } = await downloadLink(api, fileId)
              const anchor = document.createElement('a')
              anchor.href = storeUrl(download.url)
              anchor.rel = 'noopener'
              anchor.target = '_blank'
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            } catch (error) {
              setProblem({ key: `${NAMESPACE}:${readProblem(error) === 'problem.read.forbidden' ? 'receiptForbidden' : 'receiptFailed'}`, reload: false })
            }
          })()
        },
        onClose,
      }}
    />
  )
}
