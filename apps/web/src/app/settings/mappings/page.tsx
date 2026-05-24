import type { Metadata } from 'next'
import MappingsClient from './MappingsClient'

export const metadata: Metadata = {
  title: 'Mappings · Settings · Nexus',
}

export default function MappingsPage() {
  return <MappingsClient />
}
