'use client'

import { useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { duplicateQuote, findCustomers, type PartyRow } from '../api'
import { readProblem, writeProblem } from '../problems'
import { duplicateBody, duplicateOf, type DuplicateActions, type DuplicateModel, type DuplicateSource } from './model'

/**
 * The Duplicate dialog's container part, shared by the quote list (row ⋯) and the quote record (band ⋯): the customer
 * search (another customer of the source's company), the copy (POST /sales/quotes/:id/duplicate, one command), and its
 * answer kept on screen until the person opens the new quote.
 */
export function useDuplicate(api: ApiClient, companyId: string | null, onOpen: (quoteId: string) => void): { model: DuplicateModel | null; open: (source: DuplicateSource) => void; actions: DuplicateActions } {
  const [model, setModel] = useState<DuplicateModel | null>(null)
  const latest = useRef(model)
  latest.current = model
  const seq = useRef(0)
  const search = (query: string) => {
    const mine = ++seq.current
    setModel((current) => (current ? { ...current, query, results: null, searchProblem: null } : current))
    findCustomers(api, query, companyId)
      .then((results) => mine === seq.current && setModel((current) => (current ? { ...current, results } : current)))
      .catch((error: unknown) => mine === seq.current && setModel((current) => (current ? { ...current, searchProblem: readProblem(error) } : current)))
  }
  const actions: DuplicateActions = {
    onDuplicateField: (patch) => {
      setModel((current) => (current ? { ...current, ...patch, problem: null } : current))
      if (patch.target === 'other' && latest.current && latest.current.results === null) search('')
    },
    onDuplicateSearch: search,
    onDuplicatePick: (party: PartyRow | null) => setModel((current) => (current ? { ...current, party, problem: null } : current)),
    onDuplicate: () => {
      const current = latest.current
      if (!current) return
      setModel({ ...current, busy: true, problem: null })
      duplicateQuote(api, current.source.id, duplicateBody(current))
        .then((answer) => setModel((state) => (state ? { ...state, busy: false, done: { quoteId: answer.quote.id, number: answer.quote.number, lines: answer.quote.lines.length, dropped: answer.dropped, warnings: answer.warnings } } : state)))
        .catch((error: unknown) => setModel((state) => (state ? { ...state, busy: false, problem: writeProblem(error).key } : state)))
    },
    onDuplicateClose: () => setModel(null),
    onDuplicateOpen: (quoteId) => {
      setModel(null)
      onOpen(quoteId)
    },
  }
  return { model, open: (source) => setModel(duplicateOf(source)), actions }
}
