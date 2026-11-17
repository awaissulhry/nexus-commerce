'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import type { Locale } from '../../lib/i18n/locales'
import type { ListField, ListFieldValue, ListToolsTransport } from '../tools/transport'
import { cellWords, fieldLabel, fieldOnRow, idsToRead, type ListCustom } from './model'

/**
 * B-TH-241 (SHEET-G04): the custom columns of a list frame. `useCustomFields` reads the record type's fields in the list's scope
 * through the list tools' seam (the Office's `GET /fields`; a design case's made-up ones) and makes their columns — hidden until a
 * view shows them (`context.optIn`), named "… (custom field)" in Customise. `useCustomValues` reads the values of the loaded rows
 * only while a custom column is in view, 200 ids a read, each row once (a fresh read of the list — rows null — starts again).
 */

type Translate = (key: string, params?: Record<string, string | number>) => string
type Values = ReadonlyMap<string, Readonly<Record<string, ListFieldValue>>>

export interface CustomColumns<T> {
  /** The fields read (null: none asked, still reading, or the read failed: no custom columns). */
  readonly fields: readonly ListField[] | null
  readonly columns: ColDef<T>[]
}

export function useCustomFields<T>(custom: ListCustom<T> | null | undefined, transport: ListToolsTransport | null, values: Values, reading: ReadonlySet<string>, rowId: (row: T) => string, locale: Locale, t: Translate): CustomColumns<T> {
  const [fields, setFields] = useState<readonly ListField[] | null>(null)
  const recordType = custom?.recordType ?? null
  const companyId = custom?.companyId ?? null
  const partyId = custom?.partyId ?? null
  const reader = transport?.fields ?? null
  useEffect(() => {
    if (!recordType || !reader) {
      setFields(null)
      return
    }
    let gone = false
    reader
      .read(recordType, { companyId, partyId })
      .then((found) => !gone && setFields(found))
      // A refused or failed read: no custom columns (the list itself works as before).
      .catch(() => !gone && setFields(null))
    return () => {
      gone = true
    }
  }, [recordType, companyId, partyId, reader])

  // The row's customer through a ref (a list passes a new function each render; the columns stay the same).
  const partyRef = useRef(custom?.partyOf)
  partyRef.current = custom?.partyOf
  const columns = useMemo<ColDef<T>[]>(() => {
    if (!fields) return []
    return fields.map((field) => {
      const label = fieldLabel(field, locale)
      const text = (row: T | undefined): string | null => {
        if (!row) return null
        const partyOf = partyRef.current
        if (!fieldOnRow(field, partyOf ? partyOf(row) : undefined)) return null
        const words = cellWords(field, values.get(rowId(row))?.[field.code], locale)
        return words.yesNo ? t(`custom.${words.yesNo}`) : words.text
      }
      const Cell = ({ data }: ICellRendererParams<T>) => {
        if (!data) return null
        if (reading.has(rowId(data)) && !values.has(rowId(data))) return <span className="fw-list-cf reading" aria-label={t('custom.reading')}>…</span>
        const shown = text(data)
        return shown === null ? null : <span className="fw-list-cf">{shown}</span>
      }
      return {
        colId: field.columnId,
        headerName: label,
        headerTooltip: t('custom.hint', { label }),
        minWidth: 112,
        flex: 0.8,
        sortable: false,
        hide: true,
        valueGetter: ({ data }: { data?: T }) => text(data) ?? '',
        cellRenderer: Cell,
        context: { optIn: true, toolLabel: t('custom.toolLabel', { label }) },
      } as ColDef<T>
    })
  }, [fields, values, reading, locale, t, rowId])

  return { fields, columns }
}

export interface CustomValues {
  readonly values: Values
  readonly reading: ReadonlySet<string>
}

/** The values of the loaded rows, read while `wanted` (a custom column is in view). */
export function useCustomValues<T>(custom: ListCustom<T> | null | undefined, transport: ListToolsTransport | null, rows: readonly T[] | null, rowId: (row: T) => string, wanted: boolean): CustomValues {
  const [values, setValues] = useState<Values>(() => new Map())
  const [reading, setReading] = useState<ReadonlySet<string>>(() => new Set())
  const known = useRef<Set<string>>(new Set())
  const asked = useRef<Set<string>>(new Set())
  // Each fresh read of the list is a new generation: an answer of an older one is dropped (its rows are asked again).
  const generation = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const recordType = custom?.recordType ?? null
  const reader = transport?.fields ?? null

  // A fresh read of the list (rows null), or another record type: the values are read again.
  const fresh = rows === null
  useEffect(() => {
    if (!fresh && recordType) return
    generation.current += 1
    known.current = new Set()
    asked.current = new Set()
    setValues(new Map())
    setReading(new Set())
  }, [fresh, recordType])

  useEffect(() => {
    if (!wanted || !reader || !recordType || !rows || rows.length === 0) return
    const chunks = idsToRead(rows.map(rowId), known.current, asked.current)
    const mine = generation.current
    const current = () => alive.current && mine === generation.current
    for (const chunk of chunks) {
      for (const id of chunk) asked.current.add(id)
      setReading((before) => new Set([...before, ...chunk]))
      reader
        .rows(recordType, chunk)
        .then((found) => {
          if (!current()) return
          for (const id of chunk) known.current.add(id)
          setValues((before) => {
            const next = new Map(before)
            // A row the API left out (not the reader's to see) holds no value: it is known, and stays empty.
            for (const id of chunk) next.set(id, found.get(id) ?? {})
            return next
          })
        })
        .catch(() => {
          // A failed read: these rows may be asked again with the next rows.
          if (current()) for (const id of chunk) asked.current.delete(id)
        })
        .finally(() => current() && setReading((before) => new Set([...before].filter((id) => !chunk.includes(id)))))
    }
  }, [wanted, reader, recordType, rows, rowId])

  return { values, reading }
}
