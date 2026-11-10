'use client'

import { useState } from 'react'
import '../picture.css'

/**
 * sec:product's picture on the public DoC page (B-W2b-236, SY3:03; the B-W2b-166 gap "no picture"): the style's main
 * picture, whole, beside what the QR points to — the stripped public copy the API serves, never the office's file. A
 * picture the reader's browser cannot load is not drawn (the page reads the same without it). No words of its own: the
 * picture's caption, else the style's name, is its text.
 */
export function PublicDocPicture({ src, alt, caption }: { src: string; alt: string; caption: string | null }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <figure className="fw-pdp">
      <img className="fw-pdp-img" src={src} alt={caption ?? alt} decoding="async" onError={() => setFailed(true)} />
      {caption && <figcaption className="fw-pdp-caption">{caption}</figcaption>}
    </figure>
  )
}
