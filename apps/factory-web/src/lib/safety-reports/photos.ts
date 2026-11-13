import { z } from 'zod'
import type { ApiClient } from '../api/client'
import { putToStore, sha256Hex } from '../../record-panels/store'

/**
 * A photo onto a product-safety report (B-W2b-351's three photo doors, the same three steps): announced with its SHA-256
 * (`POST …/photos`), the bytes PUT straight to the store with the presigned request of the answer, then confirmed
 * (`POST …/photos/<file>/complete`). The public door names its report by the signed ticket the send gave (in the body of
 * both calls); the portal and the office by the report's id in the address. Each step has its own Idempotency-Key, so a
 * retry of the same photo starts again cleanly. The photo is the DS PhotoCapture's re-encoded JPEG (no place, no device).
 */

const presigned = z.object({ method: z.enum(['GET', 'PUT']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })
const announced = z.object({ file: z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number(), status: z.string() }), upload: presigned })
const completed = z.object({ file: z.object({ id: z.string(), originalName: z.string(), sizeBytes: z.number(), status: z.string() }) })

export interface PhotoDoor {
  /** `POST` to announce: the address and what the body carries beside the photo's facts (the public ticket). */
  readonly announce: string
  readonly complete: (fileId: string) => string
  readonly extra?: Readonly<Record<string, string>>
}

export interface PhotoSent {
  readonly fileId: string
  readonly name: string
  readonly sizeBytes: number
  readonly status: string
}

export async function uploadSafetyPhoto(
  api: ApiClient,
  door: PhotoDoor,
  photo: { blob: Blob; name: string },
  keys: { announce: string; complete: string },
  put: typeof putToStore = putToStore,
): Promise<PhotoSent> {
  const bytes = await photo.blob.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const first = await api.post(door.announce, {
    body: { ...door.extra, originalName: photo.name, contentType: photo.blob.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256 },
    schema: announced,
    idempotencyKey: keys.announce,
  })
  await put(first.upload, bytes)
  const done = await api.post(door.complete(first.file.id), { ...(door.extra ? { body: door.extra } : {}), schema: completed, idempotencyKey: keys.complete })
  return { fileId: done.file.id, name: done.file.originalName, sizeBytes: done.file.sizeBytes, status: done.file.status }
}

/** A photo's file name: the report's number and its place in the list ("PSR-2026-0007-photo-2.jpg"). */
export const photoName = (number: string, index: number): string => `${number.replace(/[^A-Za-z0-9-]/g, '')}-photo-${index}.jpg`
