import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Mapping Canvas · Settings · Nexus',
}

interface PageProps {
  params: Promise<{ channel: string; code: string }>
}

export default async function MappingCanvasPage({ params }: PageProps) {
  const { channel, code } = await params
  redirect(`/channels/mapping?${new URLSearchParams({ channel, market: code })}`)
}
