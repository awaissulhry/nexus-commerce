import type { Metadata } from 'next'
import MatrixClient from './MatrixClient'

export const metadata: Metadata = {
  title: 'Catalog Matrix · Nexus',
}

export default function CatalogMatrixPage() {
  return <MatrixClient />
}
