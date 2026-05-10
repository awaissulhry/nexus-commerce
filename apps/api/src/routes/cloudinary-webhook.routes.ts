/**
 * MC.13.3 — Cloudinary webhook callbacks.
 *
 * Cloudinary fires `notification_url` POSTs for upload/eager/derived/
 * delete events. Wiring this up means the DAM stays consistent with
 * Cloudinary even when changes happen out-of-band — manual deletions
 * from the Cloudinary console, eager-transform completions for large
 * assets, etc.
 *
 * Verification: Cloudinary signs every payload with sha1(body_string
 * + timestamp + api_secret). The body_string is the canonical JSON
 * Cloudinary emits (no whitespace). We re-stringify the parsed body
 * — same approach as the Sendcloud webhook (O.7) — and compare in
 * constant time. With no CLOUDINARY_API_SECRET set the route refuses
 * to accept events so this surface is safe to expose publicly.
 *
 * Side effects:
 *   - notification_type='delete' → flag the matching DigitalAsset
 *     metadata.cloudinaryDeletedAt. We don't hard-delete the row
 *     because AssetUsage rows still need to surface "where this
 *     previously lived" in the orphaned-asset triage.
 *   - notification_type='upload'|'eager'|'derived' → audit only.
 *
 * Always 200s on signature-verified events (even if the side-effect
 * write fails) so Cloudinary's retry queue doesn't pile up.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

interface CloudinaryNotification {
  notification_type?: string
  timestamp?: string
  request_id?: string
  public_id?: string
  resource_type?: string
  type?: string
  asset_id?: string
  bytes?: number
  format?: string
  url?: string
  secure_url?: string
}

function verifySignature(
  bodyString: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!timestamp || !signature) return false
  const expected = createHash('sha1')
    .update(bodyString + timestamp + secret)
    .digest('hex')
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(signature, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

const cloudinaryWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/assets/_webhooks/cloudinary', async (request, reply) => {
    const secret = process.env.CLOUDINARY_API_SECRET ?? ''
    if (!secret) {
      request.log.warn(
        '[cloudinary-webhook] no CLOUDINARY_API_SECRET configured — refusing',
      )
      return reply.code(503).send({ error: 'Webhook secret not configured' })
    }

    const body = (request.body ?? {}) as CloudinaryNotification
    const headerTimestamp =
      (request.headers['x-cld-timestamp'] as string | undefined) ??
      body.timestamp
    const headerSignature = request.headers['x-cld-signature'] as
      | string
      | undefined

    // Match the project pattern from sendcloud-webhooks.routes: re-
    // stringify the parsed body. Cloudinary emits whitespace-free
    // canonical JSON, which round-trips cleanly through JSON.stringify.
    const bodyString =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body ?? {})

    if (!verifySignature(bodyString, headerTimestamp, headerSignature, secret)) {
      request.log.warn(
        { type: body.notification_type, requestId: body.request_id },
        '[cloudinary-webhook] signature mismatch',
      )
      return reply.code(401).send({ error: 'invalid signature' })
    }

    const notificationType = body.notification_type ?? 'unknown'
    const publicId = body.public_id ?? null

    if (notificationType === 'delete' && publicId) {
      try {
        await prisma.digitalAsset.updateMany({
          where: {
            storageProvider: 'cloudinary',
            storageId: publicId,
          },
          data: {
            metadata: {
              cloudinaryDeletedAt: new Date().toISOString(),
              cloudinaryDeletedRequestId: body.request_id ?? null,
            } as never,
          },
        })
      } catch (err) {
        request.log.error(
          { err, publicId },
          '[cloudinary-webhook] failed to flag DigitalAsset on delete',
        )
      }
    }

    try {
      await prisma.auditLog.create({
        data: {
          action: `CLOUDINARY_WEBHOOK_${notificationType.toUpperCase()}`,
          entityType: 'DigitalAsset',
          entityId: publicId ?? body.asset_id ?? body.request_id ?? 'unknown',
          metadata: {
            notificationType,
            requestId: body.request_id,
            resourceType: body.resource_type,
            type: body.type,
            bytes: body.bytes,
            format: body.format,
            secureUrl: body.secure_url,
          } as never,
        },
      })
    } catch (err) {
      request.log.error(
        { err, type: notificationType },
        '[cloudinary-webhook] failed to write AuditLog row',
      )
    }

    return reply.code(200).send({ ok: true })
  })
}

export default cloudinaryWebhookRoutes
