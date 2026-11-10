'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { formatDate } from '../../../lib/i18n/format'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { useLocale } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { csvLine, downloadText, liveMatches, useLive } from '../../quality/_shared/hooks'
import { archiveFile, createFile, listFiles, readStyles, type ListAnswer, type StyleOption } from './api'
import { CSV_COLUMNS, csvRows, failed, LOADING, listAddressOf, listSearch, NAMESPACE, problemOf, ready, recordAddress, refusalDetail, romeToday, techfilesCan, valueOf, type ListAddress, type Read } from './model'
import { useOnline } from './use-online'
import { usePackDialog } from './use-pack-dialog'
import type { Notice } from './view/parts'
import { TechFilesView, type ArchiveManyState, type NewFileState } from './view/TechFilesView'

/**
 * `/w/<company>/compliance/techfiles` (SCR-120): reads the files and their tiles with the address's filters (the words typed
 * after a short pause), counts live changes behind "N updates · Show", and runs New technical file (one live file per style:
 * the one there opens instead), Archive N (one reason, one call each at the row's version), Export (this view or the rows
 * chosen, as CSV) and Build evidence pack (`?pack=<file>`, the shared pop-up). Writes send an Idempotency-Key.
 */
export function TechFilesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => techfilesCan(session.permissions), [session.permissions])
  const address = useMemo(() => listAddressOf(params), [params])
  const online = useOnline()
  const [list, setList] = useState<Read<ListAnswer>>(LOADING)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [add, setAdd] = useState<NewFileState | null>(null)
  const [archive, setArchive] = useState<ArchiveManyState | null>(null)
  const [query, setQuery] = useState({ status: address.status, q: address.q, tile: address.tile })

  const go = useCallback((patch: Partial<ListAddress>) => router.replace(`${pathname}${listSearch({ ...address, ...patch })}`, { scroll: false }), [address, pathname, router])

  // The words typed are read after a short pause; the other filters at once.
  useEffect(() => {
    const next = { status: address.status, q: address.q.trim(), tile: address.tile }
    const timer = window.setTimeout(() => setQuery((now) => (now.status === next.status && now.q === next.q && now.tile === next.tile ? now : next)), next.q === query.q ? 0 : 300)
    return () => window.clearTimeout(timer)
  }, [address.status, address.q, address.tile])

  const read = useCallback(
    (quiet = false, signal?: AbortSignal) => {
      if (!can.view) return
      if (!quiet) setList((current) => (current.status === 'ready' ? current : LOADING))
      listFiles(api, query, signal).then(
        (value) => {
          if (signal?.aborted) return
          setList(ready(value))
          setReadAt(new Date().toISOString())
          setUpdates(0)
        },
        (error) => !signal?.aborted && setList((current) => (quiet && current.status === 'ready' ? current : failed(problemOf(error)))),
      )
    },
    [api, can.view, query],
  )

  useEffect(() => {
    const controller = new AbortController()
    read(false, controller.signal)
    return () => controller.abort()
  }, [read])

  const pack = usePackDialog({ api, can, language: locale, online, onBuilt: () => read(true) })

  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['technical_file.'])) return
      if (change.type === 'technical_file.pack_changed' && typeof change.fields.packId === 'string') pack.onLive(change.fields.packId)
      setUpdates((count) => count + 1)
    },
    () => read(true),
  )

  // Build evidence pack follows `?pack=<fileId>`.
  const rows = valueOf(list)?.files ?? null
  const packFile = address.pack
  useEffect(() => {
    if (!packFile) {
      pack.close()
      return
    }
    const row = rows?.find((entry) => entry.id === packFile)
    if (row && pack.model?.file.id !== row.id) pack.open({ id: row.id, number: row.number, style: { code: row.style.code, name: row.style.name }, latestBatch: row.latestBatch?.batchNumber ?? null })
  }, [packFile, rows])

  // New technical file follows `?new=1`.
  const findStyles = useCallback(
    (q: string) => {
      readStyles(api, q).then(
        (value) => setAdd((current) => (current ? { ...current, styles: ready(value) } : current)),
        (error) => setAdd((current) => (current ? { ...current, styles: failed(problemOf(error)) } : current)),
      )
    },
    [api],
  )
  useEffect(() => {
    if (!address.add || !can.manage) {
      setAdd(null)
      return
    }
    setAdd((current) => current ?? { q: '', styles: LOADING, styleId: null, note: '', busy: false, problem: null, existing: null })
    findStyles('')
  }, [address.add, can.manage, findStyles])

  const liveFileOf = (styleId: string) => (valueOf(list)?.files ?? []).find((row) => row.style.id === styleId && row.status !== 'ARCHIVED') ?? null
  const addKey = useRef(newIdempotencyKey())

  const create = () => {
    if (!add || !add.styleId || add.busy) return
    const style = (valueOf(add.styles) ?? []).find((entry: StyleOption) => entry.id === add.styleId)
    setAdd({ ...add, busy: true, problem: null })
    createFile(api, { styleId: add.styleId, ...(style && style.companyId === null && session.company ? { companyId: session.company.id } : {}), note: add.note.trim() || null }, addKey.current).then(
      (record) => {
        addKey.current = newIdempotencyKey()
        setAdd(null)
        router.push(recordAddress(prefix, record.file.id, 'annex', { created: '1' }))
      },
      (error) => {
        if (isApiError(error) && error.kind === 'conflict') {
          // The style has a live file: find it and offer to open it.
          listFiles(api, { status: null, q: '', tile: null, styleId: add.styleId }).then(
            (answer) => {
              const live = answer.files.find((row) => row.status !== 'ARCHIVED')
              setAdd((current) => (current ? { ...current, busy: false, existing: live ? { id: live.id, number: live.number } : null, problem: live ? null : { tone: 'warning', key: 'new.conflict', detail: refusalDetail(error) } } : current))
            },
            () => setAdd((current) => (current ? { ...current, busy: false, problem: { tone: 'warning', key: 'new.conflict', detail: refusalDetail(error) } } : current)),
          )
          return
        }
        setAdd((current) => (current ? { ...current, busy: false, problem: { tone: 'danger', key: problemOf(error), detail: refusalDetail(error) } } : current))
      },
    )
  }

  const archiveMany = async () => {
    if (!archive || archive.busy) return
    const reason = archive.reason.trim()
    const targets = (valueOf(list)?.files ?? []).filter((row) => archive.ids.includes(row.id))
    setArchive({ ...archive, busy: true })
    const refused: string[] = []
    let done = 0
    for (const row of targets) {
      try {
        await archiveFile(api, row.id, { version: row.version, reason }, newIdempotencyKey())
        done += 1
      } catch (error) {
        refused.push(`${row.number}: ${refusalDetail(error)[0] ?? ''}`.replace(/: $/, ''))
      }
    }
    setArchive(null)
    setSelected([])
    setNotice(refused.length === 0 ? { tone: 'success', key: 'done.archivedMany', params: { count: done } } : { tone: 'warning', key: 'done.archivedSome', params: { count: done, refused: refused.length }, detail: refused })
    read(true)
  }

  const exportRows = (ids: readonly string[] | null) => {
    const answer = valueOf(list)
    if (!answer) return
    const t = createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE] ?? {})
    const day = (value: string | null) => (value ? formatDate(value.length === 10 ? `${value}T12:00:00Z` : value, { locale }) : '')
    const chosen = ids ? answer.files.filter((row) => ids.includes(row.id)) : answer.files
    const header = CSV_COLUMNS.map((column) => t(`csv.${column}`))
    downloadText(`${t('csv.file')}-${romeToday()}.csv`, [csvLine(header), ...csvRows(chosen, t, day).map(csvLine)].join('\n'))
  }

  return (
    <TechFilesView
      model={{
        prefix,
        can,
        address,
        list,
        online,
        live,
        readAt,
        updates,
        selected,
        notice,
        add,
        archive,
        pack: pack.model ? { ...pack.model } : null,
      }}
      actions={{
        onAddress: (patch) => {
          if (patch.add === false) setAdd(null)
          go(patch)
        },
        onOpen: (fileId) => router.push(recordAddress(prefix, fileId)),
        onRetry: () => read(),
        onShowUpdates: () => read(true),
        onSelected: setSelected,
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
        onNewQuery: (q) => {
          setAdd((current) => (current ? { ...current, q } : current))
          findStyles(q)
        },
        onNewPick: (styleId) => {
          const live = liveFileOf(styleId)
          setAdd((current) => (current ? { ...current, styleId: styleId || null, existing: live ? { id: live.id, number: live.number } : null, problem: null } : current))
        },
        onNewNote: (note) => setAdd((current) => (current ? { ...current, note } : current)),
        onNewCreate: create,
        onArchiveMany: (ids) => setArchive(ids ? { ids, reason: '', busy: false } : null),
        onArchiveReason: (reason) => setArchive((current) => (current ? { ...current, reason } : current)),
        onArchiveApply: () => void archiveMany(),
        pack: {
          ...pack.actions,
          onClose: () => go({ pack: null }),
          onOpenPdf: (packId) => window.open(`${prefix}/compliance/techfiles/pack?pack=${encodeURIComponent(packId)}`, '_blank', 'noopener'),
          onShare: (packId) => {
            const fileId = pack.model?.file.id
            if (fileId) router.push(recordAddress(prefix, fileId, 'pack', { share: packId }))
          },
        },
      }}
    />
  )
}
