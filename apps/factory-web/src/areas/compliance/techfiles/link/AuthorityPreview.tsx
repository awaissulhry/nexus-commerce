'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { packBytes, readPack, type Pack } from '../api'
import { failed, LOADING, problemOf, ready, techfilesCan, type Read } from '../model'
import { AuthorityPreviewView } from './view/AuthorityPreviewView'

/**
 * `/w/<company>/compliance/techfiles/pack/link?pack=<id>` (SCR-327, a window page; design tab:tf-authority): reads the pack
 * (its PDF and ZIP, its links) and shows what the authority meets on the link, before and after the password; Read it here
 * reads the PDF's bytes through the office (never through the link: nothing is counted).
 */
export function AuthorityPreview() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => techfilesCan(session.permissions), [session.permissions])
  const packId = params?.get('pack') ?? ''
  const [pack, setPack] = useState<Read<Pack>>(LOADING)
  const [step, setStep] = useState<'password' | 'files'>('password')
  const [preview, setPreview] = useState<Read<Uint8Array> | null>(null)

  const read = useCallback(() => {
    if (!packId || !can.view) return setPack(failed(packId ? 'problem.forbidden' : 'problem.notFound'))
    setPack(LOADING)
    readPack(api, packId).then(
      (value) => setPack(ready(value)),
      (error) => setPack(failed(problemOf(error))),
    )
  }, [api, packId, can.view])

  useEffect(() => {
    read()
  }, [read])

  return (
    <AuthorityPreviewView
      model={{ canView: can.view, sender: session.company?.name ?? session.tenant.name, pack, step, preview, now: new Date().toISOString() }}
      actions={{
        onStep: setStep,
        onRetry: read,
        onRead: () => {
          setPreview(LOADING)
          packBytes(api, packId, 'PDF').then(
            (answer) => setPreview(ready(answer.bytes)),
            (error) => setPreview(failed(problemOf(error))),
          )
        },
        onClosePreview: () => setPreview(null),
      }}
    />
  )
}
