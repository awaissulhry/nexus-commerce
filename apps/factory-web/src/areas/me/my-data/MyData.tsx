'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi } from '../../../lib/session/context'
import { askMyData, myData, myPackageLink } from './api'
import { anyCollecting, myProblem, type MyDataModel } from './model'
import { MyDataView } from './view/MyDataView'

/** While a package is being collected and the dialog is open, my requests are read again this often (no live stream: they are mine). */
const POLL_MS = 4000

/**
 * My profile › Download my data, live (B-W2b-414 on B-W2b-405's API): read when the dialog opens (`GET /privacy/my-data`), Ask
 * = `POST /privacy/my-data` (one Idempotency-Key per attempt), read again every few seconds while a package is being collected,
 * Download = a 60-second link opened in a new tab (the first download hands it over: the list is read again after).
 */
export function MyData() {
  const api = useOfficeApi()
  const [open, setOpen] = useState(false)
  const [read, setRead] = useState<MyDataModel['read']>({ value: null, problem: null })
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const askKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      setRead({ value: await myData(api), problem: null })
    } catch (error) {
      setRead({ value: null, problem: myProblem(error) })
    }
  }, [api])

  useEffect(() => {
    if (open) void load()
  }, [open, load])
  const collecting = open && anyCollecting(read.value)
  useEffect(() => {
    if (!collecting) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [collecting, load])

  const ask = async () => {
    if (busy || !read.value?.mayAsk) return
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      askKey.current ??= newIdempotencyKey()
      const answer = await askMyData(api, askKey.current)
      askKey.current = null
      setRead({ value: answer, problem: null })
      setDone('dp.my.asked')
    } catch (error) {
      setProblem(myProblem(error))
      void load()
    } finally {
      setBusy(false)
    }
  }

  const download = async (requestId: string) => {
    setDownloading(requestId)
    setProblem(null)
    try {
      window.open(await myPackageLink(api, requestId), '_blank', 'noopener')
      setDone('dp.my.downloaded')
      void load()
    } catch (error) {
      setProblem(myProblem(error))
    } finally {
      setDownloading(null)
    }
  }

  return (
    <MyDataView
      model={{ open, read, busy, downloading, problem, done, timeZone: 'Europe/Rome' }}
      actions={{
        onOpen: () => {
          setDone(null)
          setProblem(null)
          setOpen(true)
        },
        onClose: () => setOpen(false),
        onAsk: () => void ask(),
        onDownload: (requestId) => void download(requestId),
        onRetry: () => void load(),
      }}
    />
  )
}
