/**
 * W7.1 — EU compliance certificate CRUD.
 *
 *   GET    /api/products/:id/certificates
 *     → ProductCertificate[]   (all certs for the product, newest first)
 *
 *   POST   /api/products/:id/certificates
 *     body: { certType, certNumber?, standard?, issuingBody?,
 *              issuedAt?, expiresAt?, fileUrl?, notes? }
 *     → ProductCertificate
 *
 *   PATCH  /api/products/:id/certificates/:certId
 *     body: same fields, partial
 *     → ProductCertificate
 *
 *   DELETE /api/products/:id/certificates/:certId
 *     → { deleted: true }
 *
 * certType values: CE | EN_13595 | EN_22_05 | REACH | ROHS | WEEE | ATEX | OTHER
 */

import type { FastifyInstance } from 'fastify';
import prisma from '../db.js';

const VALID_CERT_TYPES = new Set([
  'CE', 'EN_13595', 'EN_22_05', 'REACH', 'ROHS', 'WEEE', 'ATEX', 'OTHER',
]);

export default async function productCertificatesRoutes(app: FastifyInstance) {
  // ── GET /api/products/:id/certificates ──────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/products/:id/certificates',
    async (req, reply) => {
      const { id } = req.params;

      const certs = await prisma.productCertificate.findMany({
        where: { productId: id },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send(certs);
    },
  );

  // ── POST /api/products/:id/certificates ─────────────────────────────
  app.post<{
    Params: { id: string };
    Body: {
      certType: string;
      certNumber?: string;
      standard?: string;
      issuingBody?: string;
      issuedAt?: string;
      expiresAt?: string;
      fileUrl?: string;
      notes?: string;
    };
  }>('/products/:id/certificates', async (req, reply) => {
    const { id } = req.params;
    const {
      certType, certNumber, standard, issuingBody,
      issuedAt, expiresAt, fileUrl, notes,
    } = req.body ?? {};

    if (!certType || !VALID_CERT_TYPES.has(certType)) {
      return reply.status(400).send({
        error: 'INVALID_CERT_TYPE',
        validTypes: [...VALID_CERT_TYPES],
      });
    }

    // Confirm product exists (will throw 404-style if not)
    const product = await prisma.product.findUnique({ where: { id }, select: { id: true } });
    if (!product) return reply.status(404).send({ error: 'PRODUCT_NOT_FOUND' });

    const cert = await prisma.productCertificate.create({
      data: {
        productId: id,
        certType,
        certNumber: certNumber ?? null,
        standard: standard ?? null,
        issuingBody: issuingBody ?? null,
        issuedAt: issuedAt ? new Date(issuedAt) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        fileUrl: fileUrl ?? null,
        notes: notes ?? null,
      },
    });

    return reply.status(201).send(cert);
  });

  // ── PATCH /api/products/:id/certificates/:certId ─────────────────────
  app.patch<{
    Params: { id: string; certId: string };
    Body: {
      certType?: string;
      certNumber?: string | null;
      standard?: string | null;
      issuingBody?: string | null;
      issuedAt?: string | null;
      expiresAt?: string | null;
      fileUrl?: string | null;
      notes?: string | null;
    };
  }>('/products/:id/certificates/:certId', async (req, reply) => {
    const { id, certId } = req.params;
    const body = req.body ?? {};

    if (body.certType !== undefined && !VALID_CERT_TYPES.has(body.certType)) {
      return reply.status(400).send({ error: 'INVALID_CERT_TYPE' });
    }

    const existing = await prisma.productCertificate.findFirst({
      where: { id: certId, productId: id },
    });
    if (!existing) return reply.status(404).send({ error: 'CERT_NOT_FOUND' });

    const updated = await prisma.productCertificate.update({
      where: { id: certId },
      data: {
        ...(body.certType !== undefined && { certType: body.certType }),
        ...(body.certNumber !== undefined && { certNumber: body.certNumber }),
        ...(body.standard !== undefined && { standard: body.standard }),
        ...(body.issuingBody !== undefined && { issuingBody: body.issuingBody }),
        ...(body.issuedAt !== undefined && {
          issuedAt: body.issuedAt ? new Date(body.issuedAt) : null,
        }),
        ...(body.expiresAt !== undefined && {
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        }),
        ...(body.fileUrl !== undefined && { fileUrl: body.fileUrl }),
        ...(body.notes !== undefined && { notes: body.notes }),
      },
    });

    return reply.send(updated);
  });

  // ── DELETE /api/products/:id/certificates/:certId ───────────────────
  app.delete<{ Params: { id: string; certId: string } }>(
    '/products/:id/certificates/:certId',
    async (req, reply) => {
      const { id, certId } = req.params;

      const existing = await prisma.productCertificate.findFirst({
        where: { id: certId, productId: id },
      });
      if (!existing) return reply.status(404).send({ error: 'CERT_NOT_FOUND' });

      await prisma.productCertificate.delete({ where: { id: certId } });
      return reply.send({ deleted: true });
    },
  );
}
