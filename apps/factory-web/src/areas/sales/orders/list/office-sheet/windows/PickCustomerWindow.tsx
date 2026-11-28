'use client'

import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { Button, Input } from '@nexus/ui/primitives'
import { Banner, Modal } from '@nexus/ui/components'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { useT } from '../../../../../../lib/i18n/provider'
import { findCustomers, type PartyRow } from '../../../../quotes/api'
import { createOfficeDraft } from '../../../draft/api'
import type { SheetColumnId } from '../../../../../../lib/orders-sheet/model'
import { NS } from '../map'
import { refusalWordsOf } from '../use-office-sheet'

/**
 * owb-of3 step 3 (L2) — the "New order" row in the office: pick the customer, then today's office start (`POST /sales/order-requests`,
 * ONE customer and the subject typed in the row, if any) makes the draft; the sheet reads again and the new draft is its first order,
 * ready to type in. Nothing else is asked here (the draft page holds the rest).
 */
export function PickCustomerWindow({ seed, companyId, onClose, onDone }: { seed: { readonly column: SheetColumnId; readonly value: string }; companyId: string; onClose: () => void; onDone: (words: string | null) => void }) {
  const api = useOfficeApi()
  const t = useT(NS)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<readonly PartyRow[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const control = new AbortController()
    const timer = setTimeout(() => {
      findCustomers(api, q, companyId || null, control.signal)
        .then((rows) => !control.signal.aborted && setFound(rows))
        .catch((error: unknown) => !control.signal.aborted && setProblem(refusalWordsOf(error, t)))
    }, 250)
    return () => {
      clearTimeout(timer)
      control.abort()
    }
  }, [api, q, companyId, t])

  const start = async (party: PartyRow) => {
    setBusy(true)
    setProblem(null)
    try {
      const subject = seed.column === 'what' && seed.value.trim() ? seed.value.trim() : undefined
      await createOfficeDraft(api, { companyId, partyId: party.id, ...(subject ? { subject } : {}) })
      onDone(t('office.pick.started', { customer: party.tradeName ?? party.legalName }))
    } catch (error) {
      setProblem(refusalWordsOf(error, t))
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} size="md" title={t('office.pick.title')} subtitle={seed.column === 'what' && seed.value ? t('office.pick.withSubject', { subject: seed.value }) : t('office.pick.subtitle')} footer={<Button onClick={onClose}>{t('office.cancel')}</Button>}>
      {problem && <Banner tone="danger" title={problem} />}
      <Input autoFocus value={q} onChange={(event) => setQ(event.target.value)} leadingIcon={<Search size={14} aria-hidden />} placeholder={t('office.pick.search')} aria-label={t('office.pick.search')} />
      {found === null ? (
        <p className="fw-osp-muted">{t('office.reading')}</p>
      ) : found.length === 0 ? (
        <p className="fw-osp-muted">{t('office.pick.none')}</p>
      ) : (
        <ul className="fw-osp-pick">
          {found.map((party) => (
            <li key={party.id}>
              <button type="button" className="fw-osp-pick-row" disabled={busy} onClick={() => void start(party)}>
                <span className="fw-osp-strong">{party.tradeName ?? party.legalName}</span>
                <span className="fw-osp-code">{party.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
