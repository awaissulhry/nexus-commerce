import RecallDetailClient from './RecallDetailClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function RecallDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RecallDetailClient recallId={id} />
}
