import CustomerDetailClient from './CustomerDetailClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function CustomerDetailPage({
  params,
}: {
  params: { id: string }
}) {
  return <CustomerDetailClient customerId={params.id} />
}
