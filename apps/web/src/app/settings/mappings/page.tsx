import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Mappings · Settings · Nexus',
}

export default async function MappingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (typeof value === 'string') query.set(key === 'code' ? 'market' : key, value)
  redirect(`/channels/mapping${query.size ? `?${query}` : ''}`)
}
