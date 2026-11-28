'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame } from '../../../shell/frame'
import { useOffline } from '../../orders/hooks'
import { newOrderHref } from '../../neworder/model'
import { NotInAccess } from '../../neworder/view/parts'
import { useOrderingWords } from '../../neworder/words'
import { fetchStyle, type StyleDetail } from '../api'
import { askStyleHeld, askStyleHref, NS, orderHeld } from '../model'
import { fetchOrdersWith, type PortalOrderRow } from './api'
import { PRODUCT_TABS, portalProductOf, productHref, productTabOf, readStateOf } from './product-model'
import { PRODUCT_NS, ProductPageView, type ProductPageModel } from './view/ProductPageView'

/**
 * `/p/<party>/catalogue/<styleId>?tab=overview|sizes` — owb-pd4 step 4.5 (gap G9): the customer's product page. A customer with the
 * catalogue (portal.catalogue.view) reads its own design or a product of the range priced for it (GET /portal/catalogue/:styleId: the
 * brand wall is the API's — another customer's product answers 404 and the page says "not in your catalogue"); with
 * portal.salesOrders.view also its own orders that name it. The band holds the two tabs, "Ask for a change" and "Order it"
 * (portal.orderRequests.manage; held with why).
 */
export function CustomerProductPage({ styleId }: { styleId: string }) {
  return (
    <WithMessages namespaces={[NS, PRODUCT_NS, 'ds-words']}>
      <ProductContainer styleId={styleId} />
    </WithMessages>
  )
}

function ProductContainer({ styleId }: { styleId: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const params = useSearchParams()
  const locale = useLocale()
  const words = useOrderingWords()
  const tp = useT(PRODUCT_NS)
  const offline = useOffline()
  const tab = productTabOf(params?.get('tab'))
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.catalogue.view')
  const readsOrders = frame.me.permissions.includes('portal.salesOrders.view')
  const mayOrder = frame.me.permissions.includes('portal.orderRequests.manage')
  const [state, setState] = useState<ProductPageModel['state']>('loading')
  const [detail, setDetail] = useState<StyleDetail | null>(null)
  const [orders, setOrders] = useState<PortalOrderRow[] | null>(null)
  const [tick, setTick] = useState(0)

  const read = useCallback(
    (signal: AbortSignal) => {
      setState('loading')
      fetchStyle(api, styleId, signal)
        .then((next) => {
          setDetail(next)
          setState('ready')
          if (!readsOrders) return
          fetchOrdersWith(api, next.style.code, signal)
            .then((answer) => setOrders(answer.items))
            .catch(() => setOrders(null))
        })
        .catch((error: unknown) => {
          if (signal.aborted) return
          setDetail(null)
          setState(readStateOf(isApiError(error) ? error : null))
        })
    },
    [api, styleId, readsOrders],
  )

  useEffect(() => {
    if (!allowed) return
    const control = new AbortController()
    read(control.signal)
    return () => control.abort()
  }, [allowed, read, tick])

  const page = detail ? portalProductOf(detail, readsOrders ? (orders ?? []) : null, frame.prefix, locale) : null
  const facts = { mayOrder, preview: frame.me.preview, offline }
  const orderHeldKey = orderHeld(facts)
  usePortalBand(
    allowed
      ? {
          title: page?.name ?? words.t('detail.reading'),
          back: { href: `${frame.prefix}/catalogue`, label: words.t('catalogue.title') },
          tabs: page
            ? { items: PRODUCT_TABS.map((id) => ({ id, label: tp(`tab.${id}`), href: productHref(frame.prefix, styleId, id) })), active: tab, label: tp('tab.label') }
            : null,
          actions: page
            ? [{ id: 'order', label: tp('band.order'), variant: 'primary', heldReason: orderHeldKey ? words.t(orderHeldKey) : null, ...(orderHeldKey ? {} : { href: newOrderHref(frame.prefix, { way: 'pick', styles: [styleId] }) }) }]
            : [],
        }
      : { title: words.t('catalogue.title') },
  )

  if (!allowed) return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />
  return (
    <ProductPageView
      model={{
        state,
        tab,
        page,
        askHref: askStyleHref(frame.prefix, styleId),
        askHeld: askStyleHeld(facts),
        sheetHref: `${frame.prefix}/catalogue/${encodeURIComponent(styleId)}/sheet`,
      }}
      onRetry={() => setTick((n) => n + 1)}
    />
  )
}
