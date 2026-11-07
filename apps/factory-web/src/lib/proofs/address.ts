/**
 * A picture proof's bytes as an address an <img> shows (B-W2b-165): `data:image/…;base64,…`, so a picture read once
 * stays on screen after the store's 60-second address has run out, and no blob address has to be released. The accept
 * link and the quote record's Proofs panel both use it.
 */
export function pictureAddress(bytes: Uint8Array, contentType: string): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return `data:${contentType.split(';')[0]!.trim().toLowerCase()};base64,${btoa(binary)}`
}
