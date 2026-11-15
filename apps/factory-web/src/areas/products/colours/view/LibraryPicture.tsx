'use client'

import { useState, type ReactNode } from 'react'

/**
 * A library picture through the API (a colour's photo, a branding set's logo or artwork; B-W2b-F56): a picture the store
 * does not hold (404 "The file is missing from the store") shows the place's own placeholder, never the browser's broken
 * image, as the style gallery does.
 */
export function LibraryPicture({ src, alt, className, lazy, fallback }: { src: string | null; alt: string; className: string; lazy?: boolean; fallback: ReactNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src) return <>{fallback}</>
  return <img className={className} src={src} alt={alt} loading={lazy ? 'lazy' : undefined} onError={() => setFailedSrc(src)} />
}
