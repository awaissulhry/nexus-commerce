'use client'

import { useCallback, useEffect, useState } from 'react'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame } from '../../shell/frame'
import { NotInAccess } from '../neworder/view/parts'
import { useOrderingWords } from '../neworder/words'
import { fetchStyle, type StyleDetail } from './api'
import { NS } from './model'
import { StyleSheetView, type StyleSheetModel } from './view/StyleSheetView'

/**
 * `/p/<party>/catalogue/<styleId>/sheet` — tab:style-sheet (B-W2b-194): one style on one sheet in a new tab, opened from the
 * style picker, a catalogue card or the style's detail; the browser prints it or saves it as PDF. Same read as the detail.
 */
export function CustomerStyleSheetPage({ styleId }: { styleId: string }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <SheetContainer styleId={styleId} />
    </WithMessages>
  )
}

function SheetContainer({ styleId }: { styleId: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const { t } = useOrderingWords()
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.catalogue.view')
  const [state, setState] = useState<StyleSheetModel['state']>('loading')
  const [detail, setDetail] = useState<StyleDetail | null>(null)
  const [printedAt] = useState(() => new Date().toISOString())

  const read = useCallback(() => {
    setState('loading')
    fetchStyle(api, styleId)
      .then((next) => {
        setDetail(next)
        setState('ready')
      })
      .catch((error: unknown) => setState(isApiError(error) && error.kind === 'not_found' ? 'missing' : 'error'))
  }, [api, styleId])

  useEffect(() => {
    if (allowed) read()
  }, [allowed, read])

  usePortalBand({ title: detail ? t('sheet.title', { code: detail.style.code }) : t('sheet.titleNone'), back: { href: `${frame.prefix}/catalogue`, label: t('catalogue.title') } })

  if (!allowed) return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />
  return <StyleSheetView model={{ state, detail, partyName: frame.me.party.name, printedAt }} onRetry={read} />
}
