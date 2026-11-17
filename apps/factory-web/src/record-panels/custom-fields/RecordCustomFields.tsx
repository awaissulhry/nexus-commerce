'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../lib/session/context'
import { listFiles, listPeople } from '../api'
import { useCustomFields } from './use-custom-fields'
import { CustomFieldsPanel, type CustomFieldsActions } from './view/CustomFieldsPanel'

type Choice = { readonly id: string; readonly name: string }

/**
 * B-TH-280 — the record's custom-fields section on the record frame (B-W2b-431, SCR-520): the old record panels drew it above
 * their tabs; since the record pages moved onto RecordFrame it is the frame's `fields` slot, which each page fills on its first
 * tab: `<RecordCustomFields record={{ type, id }} title="SO-2026-0142" />`. It reads the record's fields and values
 * (use-custom-fields: absent — nothing drawn — for a type without custom fields, a record the person may not see, or no field
 * that applies). The choices a person field and a file field offer are read only when the person starts editing: the
 * record's people (`GET …/people`) with threads.post, its files (`GET /files`) with files.read (without it the file field says
 * so: `files` null). A failed read of either leaves the choices empty; a value already set still shows its own words.
 */
export function RecordCustomFields({ record, title }: { record: { type: string; id: string }; title: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const key = useMemo(() => ({ type: record.type, id: record.id }), [record.type, record.id])
  const mayPeople = session.permissions.includes('threads.post')
  const mayFiles = session.permissions.includes('files.read')
  const [people, setPeople] = useState<readonly Choice[]>([])
  const [files, setFiles] = useState<readonly Choice[] | null>(mayFiles ? [] : null)
  // The record whose choices were read (once per record, on the first Edit).
  const read = useRef<string | null>(null)
  useEffect(() => {
    read.current = null
    setPeople([])
    setFiles(mayFiles ? [] : null)
  }, [key, mayFiles])

  const readChoices = useCallback(() => {
    const mine = `${key.type}:${key.id}`
    if (read.current === mine) return
    read.current = mine
    if (mayPeople) {
      listPeople(api, key)
        .then((answer) => (read.current === mine ? setPeople(answer.people.map((person) => ({ id: person.id, name: person.name }))) : undefined))
        .catch(() => undefined) // Without the list a person field offers nobody new; its value keeps its words.
    }
    if (mayFiles) {
      listFiles(api, key)
        .then((answer) => (read.current === mine ? setFiles(answer.files.map((file) => ({ id: file.id, name: file.originalName }))) : undefined))
        .catch(() => undefined) // Without the list a file field offers no file; its value keeps its words.
    }
  }, [api, key, mayPeople, mayFiles])

  const section = useCustomFields({ api, record: key, title, people, files })
  // Edit first reads the choices (once per record), then opens the section's edit as before.
  const actions: CustomFieldsActions = {
    ...section.actions,
    onEdit: () => {
      readChoices()
      section.actions.onEdit?.()
    },
  }
  if (!section.model) return null
  return <CustomFieldsPanel model={section.model} actions={actions} />
}
