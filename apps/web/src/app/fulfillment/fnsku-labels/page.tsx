'use client'

import dynamic from 'next/dynamic'

const FnskuLabelDesigner = dynamic(() => import('./FnskuLabelDesigner'), { ssr: false })

export default function FnskuLabelsPage() {
  return <FnskuLabelDesigner />
}
