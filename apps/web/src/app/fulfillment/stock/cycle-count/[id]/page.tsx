import PageHeader from '@/components/layout/PageHeader'
import CycleCountSessionClient from './CycleCountSessionClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function CycleCountSessionPage({ params }: PageProps) {
  const { id } = await params
  return (
    <div className="space-y-3">
      <PageHeader
        title="Count Session"
        description="Enter the physical count for each item · variance reconciliation creates StockMovement audit rows"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Stock', href: '/fulfillment/stock' },
          { label: 'Cycle Counts', href: '/fulfillment/stock/cycle-count' },
          { label: id.slice(-8) },
        ]}
      />
      <CycleCountSessionClient countId={id} />
    </div>
  )
}
