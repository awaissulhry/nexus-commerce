'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import type { Party } from '../../../parties/_shared/api'
import { listPriceLists, type PriceListRow } from '../../pricelists/api'
import { readProblem } from '../../pricelists/problems'
import { getCommercialTerms, listPaymentTerms, updateCommercialTerms, type CommercialTerms as Terms, type PaymentTermsRow } from './api'
import { termsAbilitiesOf, termsDraftOf, termsHeld, termsPatch, type TermsDraft } from './model'
import { CommercialTermsCard } from './view/CommercialTermsCard'

/**
 * The container of the customer's Commercial terms card (Tax & terms tab of SCR-033): reads the terms
 * (`GET /parties/:id/commercial-terms`, parties.view) again whenever the party's version moves (a write here, on another
 * tab, or by someone else), reads the choices when Edit is pressed — the payment terms library of the customer's company
 * (paymentterms.view) and the price lists (pricelists.view) — and saves the fields that changed with the party's version.
 * After a save the record reads the party again (`onChanged`): the terms are its columns, so its version moved.
 */
export function CommercialTerms({ party, onChanged }: { party: Party; onChanged: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => termsAbilitiesOf(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const [terms, setTerms] = useState<Terms | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [draft, setDraft] = useState<TermsDraft | null>(null)
  const [library, setLibrary] = useState<PaymentTermsRow[] | null>(null)
  const [lists, setLists] = useState<PriceListRow[] | null>(null)
  const [choicesProblem, setChoicesProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveProblem, setSaveProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      setTerms(await getCommercialTerms(api, party.id))
      setProblem(null)
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, party.id])
  useEffect(() => {
    void load()
  }, [load, party.version])

  const edit = () => {
    if (!terms) return
    setDraft(termsDraftOf(terms))
    setSaved(false)
    setSaveProblem(null)
    setChoicesProblem(null)
    const company = party.companyId ?? session.company?.id ?? null
    const reads: Array<Promise<unknown>> = []
    if (can.terms) reads.push(listPaymentTerms(api, company).then(setLibrary))
    else setLibrary([])
    if (can.lists) reads.push(listPriceLists(api, { companyId: company }).then((answer) => setLists(answer.lists)))
    else setLists([])
    Promise.all(reads).catch(() => setChoicesProblem('terms.choicesFailed'))
  }

  const save = () => {
    if (!terms || !draft) return
    const patch = termsPatch(termsDraftOf(terms), draft, can)
    if (Object.keys(patch).length === 0) {
      setDraft(null)
      return
    }
    setBusy(true)
    setSaveProblem(null)
    updateCommercialTerms(api, { partyId: party.id, version: party.version }, patch)
      .then((next) => {
        setTerms(next)
        setDraft(null)
        setSaved(true)
        onChanged()
      })
      .catch((error: unknown) => {
        setSaveProblem(saveProblemOf(error))
        if (isApiError(error) && error.kind === 'conflict') onChanged()
      })
      .finally(() => setBusy(false))
  }

  return (
    <CommercialTermsCard
      model={{ prefix, can, terms, problem, held: termsHeld(party, can), draft, library, lists, choicesProblem, busy, saveProblem, saved }}
      actions={{
        onRetry: () => void load(),
        onEdit: edit,
        onDraft: setDraft,
        onDiscard: () => {
          setDraft(null)
          setSaveProblem(null)
        },
        onSave: save,
      }}
    />
  )
}

/** A refused save in the card's words: moved meanwhile, a list or terms the customer may not have, or a field. */
function saveProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'terms.refused.internal'
  if (error.kind === 'conflict') return 'terms.refused.moved'
  if (error.kind === 'forbidden') return 'terms.refused.forbidden'
  if (error.kind === 'invalid') {
    const paths = error.issues.map((issue) => issuePath(issue))
    if (paths.some((path) => path.includes('priceListId'))) return 'terms.refused.list'
    if (paths.some((path) => path.includes('paymentTermsId'))) return 'terms.refused.terms'
    if (paths.some((path) => path.includes('currency'))) return 'terms.refused.currency'
    return 'terms.refused.fields'
  }
  return error.kind === 'unavailable' ? 'terms.refused.unavailable' : 'terms.refused.internal'
}
