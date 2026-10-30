'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { csvLine, downloadText, liveMatches, useLive } from '../../quality/_shared/hooks'
import { failedRead, problemKey, reading, ready, type Notice, type Read } from '../../quality/_shared/model'
import { createTemplate, findStyles, getStyle, listTemplates, type LabelTemplate, type StyleRow } from './api'
import { LABEL_EVENTS, labelHref, labelsCan, labelsCsvRows, mmTyped, NEW_LABEL, viewOf, type LabelView, type NewLabelDraft } from './model'
import { LabelsMessages } from './view/parts'
import { LabelsListView } from './view/LabelsListView'
import type { NewLabelModel } from './view-model'

/**
 * The Labels & marking container (`/w/<company>/compliance/labels`, SCR-053): reads every label the person may see
 * (`GET /compliance/labels`: by code and revision, at most 500; the tiles and the views are counted on the page from it),
 * keeps live changes behind "N updates · Show", and runs New label (`c`, `?new=1`, `?new=1&style=<id>` from a style's
 * Compliance tab): the style search, Create (revision 1, a draft) and on to its record. `?view=` and `?q=` stay in the
 * address so a filtered list can be shared.
 */
export function LabelsPage() {
  return (
    <LabelsMessages>
      <LabelsContainer />
    </LabelsMessages>
  )
}

function LabelsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('labels')
  const can = useMemo(() => labelsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const [view, setView] = useState<LabelView>(() => viewOf(params?.get('view')))
  const [query, setQuery] = useState(() => params?.get('q') ?? '')
  const [rows, setRows] = useState<Read<LabelTemplate[]>>(reading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [newLabel, setNewLabel] = useState<NewLabelModel | null>(null)
  const [shortcuts, setShortcuts] = useState(false)
  const request = useRef<AbortController | null>(null)
  const search = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const answer = await listTemplates(api, {}, controller.signal)
      if (controller.signal.aborted) return
      setRows(ready(answer.templates))
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setSelected((current) => current.filter((id) => answer.templates.some((row) => row.id === id)))
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return
      setRows(failedRead(problemKey(error)))
    }
  }, [api, can.view])

  useEffect(() => {
    void load()
  }, [load])

  const live = useLive(
    (change) => {
      if (liveMatches(change, LABEL_EVENTS)) setUpdates((count) => count + 1)
    },
    () => void load(),
  )

  const address = (next: { view: LabelView; query: string }) => {
    const search = new URLSearchParams()
    if (next.view !== 'all') search.set('view', next.view)
    if (next.query.trim()) search.set('q', next.query.trim())
    router.replace(`${pathname}${search.toString() ? `?${search}` : ''}`, { scroll: false })
  }

  // ---- New label ----
  const asked = params?.get('new') === '1'
  const askedStyle = params?.get('style') ?? null
  const openNew = useCallback(
    (open: boolean, styleId: string | null = null) => {
      if (!open) {
        setNewLabel(null)
        if (asked) address({ view, query })
        return
      }
      setNewLabel({ draft: { ...NEW_LABEL, languages: [...NEW_LABEL.languages] }, styles: null, styleQuery: '', sources: [], busy: false, problem: null })
      if (styleId && can.styles)
        getStyle(api, styleId)
          .then((style) => setNewLabel((current) => (current ? { ...current, draft: { ...current.draft, style: { id: style.id, code: style.code, name: style.name } } } : current)))
          .catch(() => undefined)
    },
    // The address and the list's filters are read when the dialog closes.
    [api, can.styles, asked, view, query],
  )
  useEffect(() => {
    if (asked && can.manage) openNew(true, askedStyle)
    // Only when the address asks.
  }, [asked, askedStyle])

  const sources = useMemo(() => (rows.value ?? []).filter((row) => row.status !== 'RETIRED'), [rows.value])

  const styleQuery = (text: string) => {
    setNewLabel((current) => (current ? { ...current, styleQuery: text, styles: text.trim() ? { value: null, problem: null } : null } : current))
    search.current?.abort()
    if (!text.trim()) return
    const controller = new AbortController()
    search.current = controller
    setTimeout(() => {
      if (controller.signal.aborted) return
      findStyles(api, text, controller.signal)
        .then((styles: StyleRow[]) => !controller.signal.aborted && setNewLabel((current) => (current ? { ...current, styles: ready(styles) } : current)))
        .catch((error) => !controller.signal.aborted && setNewLabel((current) => (current ? { ...current, styles: failedRead(problemKey(error)) } : current)))
    }, 250)
  }

  const create = async () => {
    const model = newLabel
    if (!model) return
    const draft: NewLabelDraft = model.draft
    setNewLabel({ ...model, busy: true, problem: null })
    try {
      const template = await createTemplate(api, {
        code: draft.code.trim() ? draft.code.trim().toUpperCase() : undefined,
        styleId: draft.kind === 'style' ? (draft.style?.id ?? null) : null,
        fromTemplateId: draft.fromTemplateId ?? undefined,
        languages: draft.languages,
        widthMm: mmTyped(draft.widthMm),
        heightMm: mmTyped(draft.heightMm),
      })
      router.push(labelHref(prefix, template.id))
    } catch (error) {
      const key = isApiError(error) && error.kind === 'conflict' ? 'new.problem.taken' : isApiError(error) && error.kind === 'invalid' ? 'new.problem.invalid' : isApiError(error) && error.kind === 'forbidden' ? 'new.problem.forbidden' : 'new.problem.failed'
      setNewLabel((current) => (current ? { ...current, busy: false, problem: key } : current))
    }
  }

  const exportRows = (list: readonly LabelTemplate[]) => {
    const header = [t('csv.code'), t('csv.revision'), t('csv.name'), t('csv.style'), t('csv.languages'), t('csv.maker'), t('csv.status'), t('csv.width'), t('csv.height'), t('csv.problems'), t('csv.updated')]
    const lines = labelsCsvRows(list, header, { status: (row) => t(`status.${row.status}`), shared: t('list.shared') }).map(csvLine)
    downloadText(`labels-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\r\n'))
    setNotice({ key: 'done.exported', params: { count: list.length }, tone: 'success' })
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice({ key: 'done.copied', params: { code: text }, tone: 'success' })
    } catch {
      setNotice({ key: 'done.copyFailed', tone: 'warning' })
    }
  }

  return (
    <LabelsListView
      model={{ prefix, can, view, query, rows, asOf, live, updates, selected, notice, newLabel: newLabel ? { ...newLabel, sources } : null, shortcuts }}
      actions={{
        onQuery: (text) => {
          setQuery(text)
          address({ view, query: text })
        },
        onView: (next) => {
          setView(next)
          setSelected([])
          address({ view: next, query })
        },
        onClearAll: () => {
          setView('all')
          setQuery('')
          address({ view: 'all', query: '' })
        },
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onSelect: (ids) => setSelected([...ids]),
        onOpen: (row) => router.push(labelHref(prefix, row.id)),
        onExport: exportRows,
        onCopy: (text) => void copy(text),
        onDismissNotice: () => setNotice(null),
        onNewLabel: (open) => openNew(open),
        onNewDraft: (draft) => setNewLabel((current) => (current ? { ...current, draft, problem: null } : current)),
        onStyleQuery: styleQuery,
        onCreate: () => void create(),
        onShortcuts: setShortcuts,
      }}
    />
  )
}
