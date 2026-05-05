// Order detail page with timeline + items drill + shipments + returns + financials.
import OrderDetailClient from './OrderDetailClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <OrderDetailClient id={id} />
}
