'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { readProblem } from '../../../_shared/model'
import { travellerPdf } from '../api'
import { travellerIdsOf } from '../model'
import { TravellerPdfView, type TravellerModel } from './view/TravellerPdfView'

/**
 * `/w/<company>/production/work-orders/<id>/traveller` and `/w/<company>/production/work-orders/travellers?ids=a,b`
 * (tab:wo-tab-traveller): the API's traveller PDF in the page's language, read with the company header a plain link cannot send.
 */
export function TravellerPdf({ workOrderId }: { workOrderId?: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const params = useSearchParams()
  const idsText = workOrderId ?? params?.get('ids') ?? ''
  const ids = useMemo(() => travellerIdsOf(idsText), [idsText])
  const allowed = session.permissions.includes('workorders.view')
  const [state, setState] = useState<Pick<TravellerModel, 'pdf' | 'problem'>>({ pdf: null, problem: null })

  const read = useCallback(async () => {
    if (!allowed || ids.length === 0) return
    setState({ pdf: null, problem: null })
    try {
      setState({ pdf: await travellerPdf(api, ids, locale), problem: null })
    } catch (error) {
      setState({ pdf: null, problem: readProblem(error) })
    }
  }, [api, ids, locale, allowed])

  useEffect(() => {
    void read()
  }, [read])

  return <TravellerPdfView model={{ allowed, count: ids.length, ...state }} onRetry={() => void read()} />
}
