'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { useLiveBus } from '../../shell/live/use-live'
import { searchRecords } from '../../areas/search/api'
import type { Field } from '../../areas/admin/fields/api'
import { readValues, writeValues, type RecordValue } from './api'
import { changesOf, draftOf, fieldsRecordOf, saveFaultOf, type Draft, type DraftValue, type RefDraft } from './model'
import type { CustomFieldsActions, CustomFieldsModel } from './view/CustomFieldsPanel'

const LINK_PAUSE_MS = 250

/**
 * The record's custom-fields section (B-W2b-431; B-TH-280: drawn by RecordCustomFields at the end of the record frame's first
 * tab): the container side. It reads the record's values (`GET
 * /fields/values/:type/:id` with the record's own view permission), keeps the section's draft while the person edits,
 * sends the changed values in ONE `PUT` (each at its version, a cleared one as null) and says each refusal at its field.
 * A linked record is found through global search (`GET /search?type=<model>`). custom_field.changed of its type reads the
 * fields again; a save refused because someone saved first keeps the draft and offers to read the record again.
 * The section is absent for a record type without custom fields, a record the person may not see, and when no field
 * applies — `model` is then null.
 */
export function useCustomFields({ api, record, title, people, files }: { api: ApiClient; record: { type: string; id: string }; title: string; people: readonly { id: string; name: string }[]; files: readonly { id: string; name: string }[] | null }): {
  model: CustomFieldsModel | null
  actions: CustomFieldsActions
} {
  const recordType = fieldsRecordOf(record.type)
  const [read, setRead] = useState<{ state: 'loading' | 'ready' | 'error' | 'absent'; fault: string | null; fields: Field[]; values: RecordValue[]; canEdit: boolean }>({ state: 'loading', fault: null, fields: [], values: [], canEdit: false })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>({})
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveFault, setSaveFault] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [link, setLink] = useState<CustomFieldsModel['link']>(null)
  const editingRef = useRef(false)
  editingRef.current = editing
  const ticket = useRef(0)

  const load = useCallback(
    async (quiet = false) => {
      if (!recordType) return
      const mine = ++ticket.current
      if (!quiet) setRead((current) => ({ ...current, state: current.state === 'ready' ? 'ready' : 'loading', fault: null }))
      try {
        const answer = await readValues(api, recordType, record.id)
        if (mine !== ticket.current) return
        setRead({ state: answer.fields.length === 0 ? 'absent' : 'ready', fault: null, fields: answer.fields, values: answer.values, canEdit: answer.canEdit })
        setChangedElsewhere(false)
        if (!editingRef.current) setDraft(draftOf(answer.fields, answer.values))
      } catch (error) {
        if (mine !== ticket.current) return
        // A record the person may not see (or a type the API no longer knows) has no section at all.
        if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden')) setRead((current) => ({ ...current, state: 'absent' }))
        else setRead((current) => ({ ...current, state: current.state === 'ready' ? 'ready' : 'error', fault: isApiError(error) && error.kind === 'unavailable' ? 'cf.fault.offline' : 'cf.fault.read' }))
      }
    },
    [api, recordType, record.id],
  )

  useEffect(() => {
    setEditing(false)
    setProblems({})
    setSaveFault(null)
    void load()
  }, [load])

  useLiveBus(
    {
      // custom_field.changed reaches people with fields.view (its recordType is the model, as the panel's record type);
      // custom_value.changed has no live message (who may see a record is its own permission): a stale save says it.
      onChange: (change) => {
        if (change.type === 'custom_field.changed' && change.fields.recordType === record.type && !editingRef.current) void load(true)
      },
      onReconnect: () => {
        if (!editingRef.current) void load(true)
      },
    },
    recordType !== null,
  )

  // The LINK picker: global search of the linked record type, a short pause after typing.
  const linkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linkRequest = useRef<AbortController | null>(null)
  const searchLink = (code: string, query: string) => {
    const field = read.fields.find((entry) => entry.code === code)
    setLink({ code, query, options: [], loading: query.trim().length >= 2, error: null })
    if (linkTimer.current) clearTimeout(linkTimer.current)
    linkRequest.current?.abort()
    if (!field?.linkTo || query.trim().length < 2) return
    linkTimer.current = setTimeout(() => {
      const request = new AbortController()
      linkRequest.current = request
      searchRecords(api, { q: query.trim(), type: field.linkTo, limit: 8 }, request.signal)
        .then((answer) => {
          if (request.signal.aborted) return
          setLink((current) => (current && current.code === code ? { ...current, loading: false, options: answer.results.map((result) => ({ value: result.recordId, label: result.number ? `${result.number} · ${result.title}` : result.title })) } : current))
        })
        .catch(() => {
          if (request.signal.aborted) return
          setLink((current) => (current && current.code === code ? { ...current, loading: false, error: 'cf.fault.search' } : current))
        })
    }, LINK_PAUSE_MS)
  }

  const save = async () => {
    const { entries, problems: found } = changesOf(read.fields, read.values, draft)
    setProblems(found)
    if (Object.keys(found).length > 0) return
    if (entries.length === 0) {
      setEditing(false)
      return
    }
    if (!recordType) return
    setSaving(true)
    setSaveFault(null)
    try {
      const answer = await writeValues(api, recordType, record.id, entries, newIdempotencyKey())
      setRead({ state: 'ready', fault: null, fields: answer.fields, values: answer.values, canEdit: answer.canEdit })
      setDraft(draftOf(answer.fields, answer.values))
      setEditing(false)
      setChangedElsewhere(false)
      setLink(null)
    } catch (error) {
      const fault = saveFaultOf(error, entries)
      // Someone saved first: the draft stays, the banner offers to read the record again.
      if (fault.key === 'cf.fault.stale') setChangedElsewhere(true)
      else setSaveFault(fault.key)
      if (fault.code) setProblems({ [fault.code]: fault.key })
    } finally {
      setSaving(false)
    }
  }

  const options = useMemo(() => ({ people: people.map((person) => ({ id: person.id, name: person.name })), files: files ?? null }), [people, files])

  const model: CustomFieldsModel | null =
    !recordType || read.state === 'absent'
      ? null
      : {
          recordLabel: title,
          state: read.state,
          fault: read.fault,
          fields: read.fields,
          values: read.values,
          canEdit: read.canEdit,
          editing,
          draft,
          problems,
          saving,
          saveFault,
          changedElsewhere,
          people: options.people,
          files: options.files,
          link,
        }

  return {
    model,
    actions: {
      onEdit: () => {
        setDraft(draftOf(read.fields, read.values))
        setProblems({})
        setSaveFault(null)
        setEditing(true)
      },
      onDiscard: () => {
        setDraft(draftOf(read.fields, read.values))
        setProblems({})
        setSaveFault(null)
        setEditing(false)
        setLink(null)
        if (changedElsewhere) void load(true)
      },
      onDraft: (code: string, value: DraftValue) => {
        setDraft((current) => ({ ...current, [code]: value }))
        setProblems((current) => {
          if (!(code in current)) return current
          const next = { ...current }
          delete next[code]
          return next
        })
      },
      onSave: () => void save(),
      onRetry: () => void load(),
      onReload: () => {
        setEditing(false)
        setProblems({})
        setSaveFault(null)
        void load()
      },
      onLinkQuery: (code: string | null, query: string) => (code === null ? setLink(null) : searchLink(code, query)),
      onLinkPick: (code: string, ref: RefDraft) => {
        setDraft((current) => ({ ...current, [code]: ref }))
        setLink(null)
      },
    },
  }
}
