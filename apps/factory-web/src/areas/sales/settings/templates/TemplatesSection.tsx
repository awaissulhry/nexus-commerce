'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveChanges } from '../../../../record-panels/live'
import { findStyles, getStyle, listQuotes } from '../../quotes/api'
import { getTemplate, type QuoteTemplate } from '../../quotes/new-from/api'
import { grainsOf } from '../../quotes/model'
import { readProblem, writeProblem } from '../../quotes/problems'
import { createTemplate, listTemplates, moveTemplate, replaceTemplateLines, templateFromQuote, updateTemplate } from './api'
import { draftOf, emptyDraft, headerPatch, linesBody, linesChanged, mayKeep, movableTemplates, templateProblems, type TemplateStatusFilter } from './model'
import type { TemplateDialogModel } from './view/TemplateDialog'
import { TemplatesView, type TemplatesModel } from './view/TemplatesView'

const NO_COMPOSER: TemplateDialogModel['composer'] = { query: '', results: null, style: null, colourwayId: '', sizes: {}, section: '', unitPrice: '' }
const NO_FROM_QUOTE: TemplateDialogModel['fromQuote'] = { query: '', results: null, chosenId: '', name: '', everyCompany: false }

/**
 * Sales settings › Quote templates (B-W2b-316; SCR-235's section, mounted by SalesSettingsPage): reads every template the
 * person reaches, opens one (or a new one) in its dialog, saves the header and the lines with the template's version,
 * makes one from a quote's current version, archives and restores the ticked ones one by one (each with its version).
 * Live `quote_template.changed` reads the list again.
 */
export function QuoteTemplatesSection() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const grains = grainsOf(session.permissions)
  const may = mayKeep(session.permissions)
  const companyId = session.company?.id ?? ''
  const [rows, setRows] = useState<TemplatesModel['rows']>({ status: 'loading' })
  const [mayCreate, setMayCreate] = useState(false)
  const [status, setStatus] = useState<TemplateStatusFilter>('ACTIVE')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<TemplatesModel['notice']>(null)
  const [dialog, setDialog] = useState<(TemplateDialogModel & { template: QuoteTemplate | null }) | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    try {
      const answer = await listTemplates(api, { status: 'ALL' })
      setRows({ status: 'ready', value: answer.templates })
      setMayCreate(answer.mayCreate && may)
    } catch (error) {
      setRows({ status: 'error', problem: readProblem(error) })
    }
  }, [api, may])
  useEffect(() => {
    void load()
  }, [load])
  useLiveChanges({ onChange: (change) => change.type === 'quote_template.changed' && void load(), onReconnect: () => void load() })

  const companies = session.companies.map((company) => ({ id: company.id, code: company.code, name: company.name }))
  const open = (id: string | 'new') => {
    const base = { start: 'empty' as const, companies, grains: { price: grains.price }, currency: 'EUR', saving: false, problem: null, composer: NO_COMPOSER, fromQuote: NO_FROM_QUOTE }
    if (id === 'new') {
      const draft = emptyDraft(companyId)
      setDialog({ ...base, mode: 'new', reading: false, readProblem: null, archived: false, draft, before: draft, mayKeep: mayCreate, template: null })
      return
    }
    const draft = emptyDraft(companyId)
    setDialog({ ...base, mode: 'edit', reading: true, readProblem: null, archived: false, draft, before: draft, mayKeep: false, template: null })
    getTemplate(api, id)
      .then((template) => {
        const loaded = draftOf(template)
        setDialog((current) => (current ? { ...current, reading: false, template, draft: loaded, before: loaded, archived: template.status === 'ARCHIVED', mayKeep: template.mayManage, currency: template.currency } : current))
      })
      .catch((error: unknown) => setDialog((current) => (current ? { ...current, reading: false, readProblem: readProblem(error) } : current)))
  }

  const save = async () => {
    const current = dialog
    if (!current || current.saving) return
    setDialog({ ...current, saving: true, problem: null })
    try {
      if (current.mode === 'new' && current.start === 'quote') {
        await templateFromQuote(api, { quoteId: current.fromQuote.chosenId, name: current.fromQuote.name.trim(), ...(current.fromQuote.everyCompany ? { companyId: null } : {}) })
      } else if (current.mode === 'new') {
        if (templateProblems(current.draft, current.grains).length > 0) return setDialog({ ...current, saving: false })
        const header = headerPatch(emptyDraft(''), current.draft)
        await createTemplate(api, { ...header, companyId: current.draft.companyId || null, name: current.draft.name.trim(), lines: linesBody(current.draft.lines, current.grains) })
      } else if (current.template) {
        let template = current.template
        const patch = headerPatch(current.before, current.draft)
        if (Object.keys(patch).length > 0) template = await updateTemplate(api, template, patch)
        if (linesChanged(current.before.lines, current.draft.lines, current.grains)) template = await replaceTemplateLines(api, template, linesBody(current.draft.lines, current.grains))
      }
      setDialog(null)
      setNotice({ words: { key: current.mode === 'new' ? 'tpl.done.created' : 'tpl.done.saved' }, tone: 'success' })
      void load()
    } catch (error) {
      setDialog((state) => (state ? { ...state, saving: false, problem: { ns: 'sales', key: writeProblem(error).key } } : state))
    }
  }

  const move = async (to: 'archive' | 'restore') => {
    if (rows.status !== 'ready') return
    const chosen = movableTemplates(rows.value, selected, to)
    setBusy(true)
    let done = 0
    for (const row of chosen) {
      try {
        await moveTemplate(api, row, to)
        done++
      } catch {
        // Counted below; the list is read again.
      }
    }
    setBusy(false)
    setSelected([])
    setNotice(done === chosen.length ? { words: { key: to === 'archive' ? 'tpl.done.archived' : 'tpl.done.restored', params: { count: done } }, tone: 'success' } : { words: { key: 'tpl.done.partly', params: { done, failed: chosen.length - done } }, tone: 'warning' })
    void load()
  }

  const styleSearch = (query: string) => {
    const mine = ++seq.current
    setDialog((current) => (current ? { ...current, composer: { ...current.composer, query, results: query.trim() === '' ? null : current.composer.results, style: null } } : current))
    if (query.trim() === '') return
    findStyles(api, query, dialog?.draft.companyId || companyId || null)
      .then((results) => mine === seq.current && setDialog((current) => (current ? { ...current, composer: { ...current.composer, results } } : current)))
      .catch(() => mine === seq.current && setDialog((current) => (current ? { ...current, composer: { ...current.composer, results: [] } } : current)))
  }

  const quoteSearch = (query: string) => {
    const mine = ++seq.current
    setDialog((current) => (current ? { ...current, fromQuote: { ...current.fromQuote, query, results: query.trim() === '' ? null : current.fromQuote.results } } : current))
    if (query.trim() === '') return
    listQuotes(api, { q: query })
      .then((page) => mine === seq.current && setDialog((current) => (current ? { ...current, fromQuote: { ...current.fromQuote, results: page.quotes } } : current)))
      .catch(() => mine === seq.current && setDialog((current) => (current ? { ...current, fromQuote: { ...current.fromQuote, results: [] } } : current)))
  }

  const model: TemplatesModel = { rows, status, selected, mayCreate, busy, notice, dialog }
  return (
    <TemplatesView
      model={model}
      actions={{
        onStatus: setStatus,
        onSelect: setSelected,
        onOpen: open,
        onMove: (to) => void move(to),
        onRetry: () => void load(),
        onDismissNotice: () => setNotice(null),
        dialog: {
          onClose: () => setDialog(null),
          onStart: (start) => setDialog((current) => (current ? { ...current, start } : current)),
          onDraft: (patch) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
          onComposer: (patch) => setDialog((current) => (current ? { ...current, composer: { ...current.composer, ...patch } } : current)),
          onComposerSearch: styleSearch,
          onComposerPick: (styleId) => {
            getStyle(api, styleId)
              .then((style) => setDialog((current) => (current ? { ...current, composer: { ...current.composer, style, colourwayId: '', sizes: {} } } : current)))
              .catch(() => undefined)
          },
          onFromQuote: (patch) => setDialog((current) => (current ? { ...current, fromQuote: { ...current.fromQuote, ...patch } } : current)),
          onFromQuoteSearch: quoteSearch,
          onSave: () => void save(),
        },
      }}
    />
  )
}
