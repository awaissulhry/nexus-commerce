'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { useLiveBus } from '../../shell/live/use-live'
import { searchRecords } from '../../areas/search/api'
import type { Field } from '../../areas/admin/fields/api'
import { readValues, writeValues, type RecordValue } from './api'
import { changesOf, draftOf, fieldsRecordOf, saveFaultOf, type Draft, type DraftValue, type RefDraft } from './model'
import { portalTagOf } from './model' // F-OO-212
import { saveAgainOf, sentRecordVersion } from './model' // F-OO-213
import type { ValueEntry } from './api' // F-OO-213
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
 * F-OO-213 (B-OO-014; 11-design §8.3): a page that gives its record's `version` (the order page: a sales order's values are part of
 * the order) sends it with each save (`recordVersion`) and hears the version the save moved it to (`onSaved`: the page reads the order
 * again, so its next command is not refused); a 409 on that version keeps the draft and offers Save again (read again, the same
 * changes sent at the new version unless one of their fields changed meanwhile) or Discard mine. A closed or cancelled order holds Edit
 * (`editHeld` FINAL). Every other record page gives nothing and behaves as before.
 */
export function useCustomFields({ api, record, title, people, files, version, onSaved }: { api: ApiClient; record: { type: string; id: string }; title: string; people: readonly { id: string; name: string }[]; files: readonly { id: string; name: string }[] | null; /* F-OO-213 */ version?: number; onSaved?: (version: number) => void }): {
  model: CustomFieldsModel | null
  actions: CustomFieldsActions
} {
  const recordType = fieldsRecordOf(record.type)
  // F-OO-213: and the record's own state for its values (editHeld, recordVersion: null from an older answer).
  const [read, setRead] = useState<{ state: 'loading' | 'ready' | 'error' | 'absent'; fault: string | null; fields: Field[]; values: RecordValue[]; canEdit: boolean; editHeld: 'FINAL' | 'ROLE' | null; recordVersion: number | null }>({ state: 'loading', fault: null, fields: [], values: [], canEdit: false, editHeld: null, recordVersion: null })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>({})
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveFault, setSaveFault] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  // F-OO-213: the record's own version moved since it was read (Save again / Discard mine); the fields someone saved meanwhile.
  const [recordChanged, setRecordChanged] = useState(false)
  const [changedFields, setChangedFields] = useState<readonly string[]>([])
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
        setRead({ state: answer.fields.length === 0 ? 'absent' : 'ready', fault: null, fields: answer.fields, values: answer.values, canEdit: answer.canEdit, editHeld: answer.editHeld ?? null, recordVersion: answer.recordVersion ?? null })
        setChangedElsewhere(false)
        setRecordChanged(false) // F-OO-213
        setChangedFields([])
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

  // F-OO-213: one send for Save and Save again — the entries at the record's version (when the page gives one); the answer replaces the
  // section, and the page hears the version the save moved its record to.
  const send = async (entries: readonly ValueEntry[], recordVersion: number | undefined) => {
    if (!recordType) return
    const answer = await writeValues(api, recordType, record.id, entries, newIdempotencyKey(), recordVersion)
    setRead({ state: 'ready', fault: null, fields: answer.fields, values: answer.values, canEdit: answer.canEdit, editHeld: answer.editHeld ?? null, recordVersion: answer.recordVersion ?? null })
    setDraft(draftOf(answer.fields, answer.values))
    setEditing(false)
    setChangedElsewhere(false)
    setRecordChanged(false)
    setChangedFields([])
    setLink(null)
    if (version !== undefined && typeof answer.recordVersion === 'number') onSaved?.(answer.recordVersion)
  }

  const refused = (error: unknown, entries: readonly ValueEntry[]) => {
    const fault = saveFaultOf(error, entries)
    // F-OO-213: someone changed the record first (its own version): the draft stays, Save again / Discard mine.
    if (fault.record === 'stale') return setRecordChanged(true)
    // F-OO-213: closed or cancelled meanwhile: it never changes again — the edit ends, read again (Edit held in the same words).
    if (fault.record === 'final') {
      setEditing(false)
      setSaveFault(fault.key)
      void load(true)
      return
    }
    // Someone saved first: the draft stays, the banner offers to read the record again.
    if (fault.key === 'cf.fault.stale') setChangedElsewhere(true)
    else setSaveFault(fault.key)
    if (fault.code) setProblems({ [fault.code]: fault.key })
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
      await send(entries, sentRecordVersion(version, read.recordVersion)) // F-OO-213: the record's version, only when the page gives one
    } catch (error) {
      refused(error, entries)
    } finally {
      setSaving(false)
    }
  }

  // ---- F-OO-213: Save again (Keep mine) — read the record again; the same changes go at its new version unless one of their fields
  // was saved meanwhile (then named under "Someone saved these fields first": the draft is never sent over a colleague's value).
  const saveAgain = async () => {
    if (!recordType) return
    const { entries, problems: found } = changesOf(read.fields, read.values, draft)
    setProblems(found)
    if (Object.keys(found).length > 0 || entries.length === 0) return
    setSaving(true)
    setSaveFault(null)
    try {
      const fresh = await readValues(api, recordType, record.id)
      const again = saveAgainOf(entries, fresh)
      if (again.kind === 'final') {
        setRead({ state: 'ready', fault: null, fields: fresh.fields, values: fresh.values, canEdit: fresh.canEdit, editHeld: fresh.editHeld ?? null, recordVersion: fresh.recordVersion ?? null })
        setDraft(draftOf(fresh.fields, fresh.values))
        setEditing(false)
        setRecordChanged(false)
        setSaveFault('cf.heldFinal')
        return
      }
      if (again.kind === 'changed') {
        setRecordChanged(false)
        setChangedElsewhere(true)
        setChangedFields(again.codes)
        return
      }
      await send(entries, sentRecordVersion(version, again.recordVersion))
    } catch (error) {
      refused(error, entries)
    } finally {
      setSaving(false)
    }
  }
  // ---- end F-OO-213

  const options = useMemo(() => ({ people: people.map((person) => ({ id: person.id, name: person.name })), files: files ?? null }), [people, files])

  const model: CustomFieldsModel | null =
    !recordType || read.state === 'absent'
      ? null
      : {
          recordLabel: title,
          portalTag: portalTagOf(recordType), // F-OO-212: "Customer sees it" (who reads a field shown in the portal here)
          state: read.state,
          fault: read.fault,
          fields: read.fields,
          values: read.values,
          canEdit: read.canEdit,
          editHeld: read.editHeld, // F-OO-213: a closed or cancelled order holds Edit for everyone
          editing,
          draft,
          problems,
          saving,
          saveFault,
          changedElsewhere,
          recordChanged, // F-OO-213
          changedFields,
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
        // F-OO-213: Discard mine after "Someone changed {record} first" reads it again too (its version and values).
        if (changedElsewhere || recordChanged) void load(true)
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
      onSaveAgain: () => void saveAgain(), // F-OO-213
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
