import type { Metadata } from 'next'
import CanvasClient from './CanvasClient'

export const metadata: Metadata = {
  title: 'Mapping Canvas · Settings · Nexus',
}

interface PageProps {
  params: Promise<{ channel: string; code: string }>
}

export default async function MappingCanvasPage({ params }: PageProps) {
  const { channel, code } = await params
  return <CanvasClient channel={channel} code={code} />
}
