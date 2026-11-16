'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import type { Invoice } from '../../_shared/api'
import { money, readProblem } from '../../_shared/model'
import { getInvoiceIntent, nameDeclaration, type InvoiceIntent } from './api'
import { intentAbilitiesOf, intentProblem, letGoHeld, nameHeld, namedWords, NAMING_TYPES, pickShown, type IntentProblem } from './model'
import { DeclarationPickView } from './view/DeclarationPickView'

/**
 * The draft's declaration of intent (B-W2b-GB02, G152 on B-W2b-392's GET …/tax and PUT …/declaration-of-intent): read for a
 * draft whenever its version changes; names the declaration picked or lets the named one go, each with the draft's version
 * and an Idempotency-Key, and hands the answer to the record (which reads its parts again). Draws nothing for a type that
 * names none, or a customer that sent none.
 */
export function DeclarationPick({ invoice, onChanged }: { invoice: Invoice; onChanged: (next: Invoice) => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const can = useMemo(() => intentAbilitiesOf(session.permissions), [session.permissions])
  const [intent, setIntent] = useState<{ value: InvoiceIntent | null; problem: string | null }>({ value: null, problem: null })
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<IntentProblem | null>(null)

  const names = (NAMING_TYPES as readonly string[]).includes(invoice.docType)
  const read = useCallback(async () => {
    if (!names) return
    try {
      setIntent({ value: await getInvoiceIntent(api, invoice.id), problem: null })
    } catch (error) {
      setIntent({ value: null, problem: readProblem(error) })
    }
  }, [api, invoice.id, names])
  useEffect(() => {
    setPicked(null)
    void read()
  }, [read, invoice.version])

  const value = intent.value
  // Nothing while it is read (most customers send no declaration: no line flashes in and out), nor when none applies.
  if (!names || (value === null && intent.problem === null) || (value !== null && !pickShown(invoice.docType, value))) return null
  const named = value?.declarationOfIntent ?? null
  const save = (declarationId: string | null) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    void (async () => {
      try {
        onChanged(await nameDeclaration(api, invoice, declarationId))
      } catch (error) {
        const words = intentProblem(error)
        setProblem(words)
        if (words.reload) void read()
      } finally {
        setBusy(false)
      }
    })()
  }
  return (
    <DeclarationPickView
      model={{
        intent: value,
        readProblem: intent.problem,
        named: named ? namedWords(named, can.price && named.thisAmount !== undefined ? money(named.thisAmount, invoice.currency, locale) : null) : null,
        picked,
        nameHeld: nameHeld({ can, switchOn: value?.switches.declarationsOfIntentOn ?? false, picked, named: named?.id ?? null, busy }),
        letGoHeld: letGoHeld(can, busy),
        busy,
        problem,
      }}
      actions={{
        onPick: setPicked,
        onName: () => picked && save(picked),
        onLetGo: () => save(null),
        onRetry: () => void read(),
      }}
    />
  )
}
