'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { TemplatePointBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveChanges } from '../../../../record-panels/live'
import { downloadCsv } from '../../library/model'
import { depthFiltersOf, depthSearch, NO_DEPTH_FILTERS, statusQuery, type DepthFilters } from '../depth/model'
import { useLibraryImport } from '../depth/use-library-import'
import { createTemplate, getTemplate, listTemplates, type TemplateOption } from './api'
import { copyPointsOf, emptyNewDraft, FACTS_LIMIT, newTemplateBody, readProblem, recordHref, rowFactsOf, templateCan, templatesCsv, writeProblem, type Notice, type RowFacts } from './model'
import { TemplatesMessages, useWords } from './parts'
import { TemplatesListView, type NewTemplateModel, type TemplatesListModel } from './view/TemplatesListView'

/**
 * `/w/<company>/products/sizes?view=templates` (SCR-049-templates; B-W1-17 on B-W2b-283's list and B-W2b-358's template page):
 * the templates the person reads (product.styles.view), `?status=` and `?q=` kept in the address, the required points and
 * where-used of each shown row read from its page (a factory keeps a handful), live measurement_template.* changes behind
 * "N updates · Show", New template (`?new=1`, `c`: created with ONE call and its own Idempotency-Key, then opened).
 */
export function TemplatesList() {
  return (
    <TemplatesMessages>
      <Container />
    </TemplatesMessages>
  )
}

function Container() {
  const { t } = useWords()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const filters = useMemo(() => depthFiltersOf(params), [params])
  const can = useMemo(() => templateCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/products\/sizes\/?$/, '')
  const companyId = session.company?.id ?? null
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const [rows, setRows] = useState<TemplatesListModel['rows']>({ items: null, more: false, problem: null })
  const [facts, setFacts] = useState<Record<string, RowFacts | 'failed'>>({})
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [newTemplate, setNewTemplate] = useState<NewTemplateModel | null>(null)
  const readSeq = useRef(0)
  const createKey = useRef<string | null>(null)
  const imports = useLibraryImport({ api, permissions: session.permissions, companyId, companies, locale, onApplied: () => undefined })

  const go = useCallback((next: DepthFilters, extra: { new?: boolean } = {}) => router.replace(`${pathname}${depthSearch('templates', next, extra)}`), [router, pathname])

  const readFacts = useCallback(
    async (items: readonly TemplateOption[], seq: number) => {
      for (let start = 0; start < Math.min(items.length, FACTS_LIMIT); start += 5) {
        const chunk = items.slice(start, Math.min(start + 5, FACTS_LIMIT))
        const answers = await Promise.all(chunk.map((row) => getTemplate(api, row.id).then(rowFactsOf, () => 'failed' as const)))
        if (seq !== readSeq.current) return
        setFacts((now) => ({ ...now, ...Object.fromEntries(chunk.map((row, index) => [row.id, answers[index]!])) }))
      }
    },
    [api],
  )

  const load = useCallback(async () => {
    if (!can.view) return
    const seq = ++readSeq.current
    setRows((now) => ({ ...now, items: null, problem: null }))
    try {
      const answer = await listTemplates(api, { status: statusQuery(filters.status), q: filters.q })
      if (seq !== readSeq.current) return
      setRows({ items: answer.templates, more: answer.more, problem: null })
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setFacts({})
      void readFacts(answer.templates, seq)
    } catch (error) {
      if (seq === readSeq.current) setRows({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, can.view, filters, readFacts])

  useEffect(() => {
    void load()
  }, [load])

  useLiveChanges({
    onChange: (change) => {
      if (change.type.startsWith('measurement_template.')) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  // New template: `?new=1` opens it once (when the person may make one).
  const askedNew = params?.get('new') === '1'
  useEffect(() => {
    if (askedNew && can.manage && !newTemplate) {
      createKey.current = null
      setNewTemplate({ draft: emptyNewDraft(companies.length > 1 ? null : companyId), companies, templates: rows.items ?? [], copy: null, busy: false, problem: null, refused: [] })
    }
    if (!askedNew && newTemplate) setNewTemplate(null)
  }, [askedNew, can.manage])
  // The copy's source points, read when it is chosen.
  const copyFrom = newTemplate?.draft.start === 'copy' ? newTemplate.draft.copyFromId : ''
  useEffect(() => {
    if (!copyFrom) return
    let gone = false
    setNewTemplate((now) => (now ? { ...now, copy: null } : now))
    getTemplate(api, copyFrom)
      .then((source) => !gone && setNewTemplate((now) => (now && now.draft.copyFromId === copyFrom ? { ...now, copy: copyPointsOf(source) } : now)))
      .catch(() => !gone && setNewTemplate((now) => (now ? { ...now, copy: 'failed' } : now)))
    return () => {
      gone = true
    }
  }, [api, copyFrom])
  useEffect(() => {
    if (rows.items) setNewTemplate((now) => (now ? { ...now, templates: rows.items ?? [] } : now))
  }, [rows.items])

  const create = async () => {
    const model = newTemplate
    if (!model || model.busy) return
    setNewTemplate({ ...model, busy: true, problem: null, refused: [] })
    createKey.current ??= newIdempotencyKey()
    try {
      const copy: readonly TemplatePointBody[] | null = Array.isArray(model.copy) ? model.copy : null
      const template = await createTemplate(api, newTemplateBody(model.draft, copy), createKey.current)
      createKey.current = null
      router.push(recordHref(prefix, template.id))
    } catch (error) {
      const problem = writeProblem(error)
      setNewTemplate((now) => (now ? { ...now, busy: false, problem: problem.key, refused: problem.paths } : now))
    }
  }

  const exportCsv = (ids: readonly string[]) => {
    const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
    const csv = templatesCsv(picked, {
      header: ['code', 'name', 'type', 'points', 'mtm', 'status'].map((key) => t(`csv.${key}`)),
      type: (type) => t(`type.${type}`),
      on: (on) => t(on ? 'mtm.on' : 'mtm.off'),
      status: (status) => t(`status.${status}`),
      locale,
    })
    // The file's name carries no business day: the export is of the list as read.
    downloadCsv('measurement-templates.csv', csv)
  }

  const model: TemplatesListModel = { prefix, can, filters, rows, facts, asOf, updates, notice, newTemplate, switch: { library: 'templates', importHeld: imports.held } }
  return (
    <>
      <TemplatesListView
        model={model}
        actions={{
          onFilters: (next) => go(next),
          onRetry: () => void load(),
          onMore: () => setNotice({ key: 'list.moreHint', tone: 'info' }),
          onShowUpdates: () => void load(),
          onOpen: (id) => router.push(recordHref(prefix, id)),
          onExport: exportCsv,
          onNew: (open) => go(filters, open ? { new: true } : {}),
          onDraft: (draft) => setNewTemplate((now) => (now ? { ...now, draft, refused: [] } : now)),
          onCreate: () => void create(),
          onDismissNotice: () => setNotice(null),
          switch: { onLibrary: (next) => router.push(`${pathname}${depthSearch(next, NO_DEPTH_FILTERS)}`), onImport: imports.open },
        }}
      />
      {imports.dialog}
    </>
  )
}
