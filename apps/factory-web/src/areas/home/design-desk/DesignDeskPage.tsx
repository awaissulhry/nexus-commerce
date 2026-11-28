'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { isApiError } from '../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useT } from '../../../lib/i18n/provider'
import { pictureReader } from '../../../lib/record-picture/api'
import { WithMessages } from '../../../record-panels/i18n'
import { answerAsk, readDesk, takeAsk } from './api'
import { mayAnswerFloor, mayPlaceCode } from './model'
import { DESK_NS, DesignDeskView, type DesignDeskModel } from './view/DesignDeskView'

/**
 * Home › Design desk (owb-of7 step 1; replaces the base's stub page) — the container: the desk read (`GET /design-desk`, owb-of2), the
 * floor's two acts (S5's call acts on today's routes), the pictures' batch read, Place the scan code… open. Rights: the page row is
 * `orders.view.own` (the designer; the owner by every()); the read lists only orders the reader may see.
 */
export function DesignDeskPage() {
  return (
    <WithMessages namespaces={[DESK_NS, 'orders', 'stock' /* the kit's unit words */]}>
      <DeskContainer />
    </WithMessages>
  )
}

function DeskContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const t = useT(DESK_NS)
  const prefix = companyPrefix(session.company?.code ?? '')
  const [read, setRead] = useState<DesignDeskModel['read']>({ status: 'loading' })
  const [answer, setAnswer] = useState<DesignDeskModel['answer']>(null)
  const [taking, setTaking] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [place, setPlace] = useState<string | null>(null)
  const words = (error: unknown): string => (isApiError(error) && error.message ? error.message : t('failed'))

  const load = useCallback(
    (signal?: AbortSignal) => {
      readDesk(api, signal)
        .then((value) => setRead({ status: 'ready', value }))
        .catch((error: unknown) => {
          if (signal?.aborted) return
          setRead({ status: 'failed', problem: isApiError(error) && error.message ? error.message : t('failed') })
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  )
  useEffect(() => {
    const abort = new AbortController()
    load(abort.signal)
    return () => abort.abort()
  }, [load])
  const pictures = useMemo(() => pictureReader(api), [api])

  return (
    <DesignDeskView
      model={{ prefix, companyId: session.company?.id ?? null, read, pictures, mayPlace: mayPlaceCode(session.permissions), mayAnswer: mayAnswerFloor(session.permissions), answer, taking, problem, place }}
      actions={{
        onRetry: () => {
          setRead({ status: 'loading' })
          load()
        },
        onTake: (callId) => {
          if (taking) return
          setTaking(callId)
          setProblem(null)
          takeAsk(api, callId)
            .then(() => load())
            .catch((error: unknown) => setProblem(words(error)))
            .finally(() => setTaking(null))
        },
        onAnswerOpen: (callId) => setAnswer({ callId, words: '', busy: false, failed: null }),
        onAnswerWords: (value) => setAnswer((now) => (now ? { ...now, words: value } : now)),
        onAnswerSend: () => {
          if (!answer || answer.busy) return
          setAnswer({ ...answer, busy: true, failed: null })
          answerAsk(api, answer.callId, answer.words)
            .then(() => {
              setAnswer(null)
              load()
            })
            .catch((error: unknown) => setAnswer((now) => (now ? { ...now, busy: false, failed: words(error) } : now)))
        },
        onAnswerClose: () => setAnswer((now) => (now?.busy ? now : null)),
        onPlace: (orderId) => setPlace(orderId),
      }}
    />
  )
}
