import type { FastifyInstance } from "fastify";
import prisma from "../db.js";

// FL.3b — FieldLinkGroup persistence.
//
//   GET  /api/products/:id/field-links            → groups for a product
//   PUT  /api/products/:id/field-links/:fieldKey  → upsert / clear a field's
//                                                    link group
//
// Defensive by design: if the FieldLinkGroup table isn't migrated yet,
// GET returns an empty list (`unavailable: true`) and PUT returns 503 so
// the cockpit degrades to "linking unavailable" instead of crashing.
//
// Scope mapping:
//   linked      → upsert a group with the chosen members
//   master      → clear any group (inherit the product master)
//   independent → clear any group; the per-cell pin is a
//                 ChannelListingOverride wired in FL.4 (not here)
//
// PARENT fields have one group per (productId, fieldKey); CHILD multi-group
// (per-variant) handling lands with FL.5b.

interface LinkMember {
  channel: string;
  marketplace: string;
  variantId?: string;
}

export async function fieldLinksRoutes(app: FastifyInstance) {
  app.get("/api/products/:id/field-links", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const groups = await prisma.fieldLinkGroup.findMany({
        where: { productId: id },
      });
      return reply.send({ groups });
    } catch (err) {
      request.log?.warn({ err }, "field-links list failed (table not migrated?)");
      return reply.send({ groups: [], unavailable: true });
    }
  });

  app.put("/api/products/:id/field-links/:fieldKey", async (request, reply) => {
    const { id, fieldKey } = request.params as { id: string; fieldKey: string };
    const body = (request.body ?? {}) as {
      scope?: "master" | "linked" | "independent";
      members?: LinkMember[];
      translatePolicy?: "TRANSLATE" | "VERBATIM" | "NONE";
      parentage?: "PARENT" | "CHILD";
      sourceLanguage?: string | null;
    };
    const scope = body.scope ?? "master";

    try {
      // Non-linked scopes share no canonical value → clear any group.
      if (scope !== "linked") {
        await prisma.fieldLinkGroup.deleteMany({ where: { productId: id, fieldKey } });
        return reply.send({ ok: true, scope, group: null });
      }

      const members = Array.isArray(body.members) ? body.members : [];
      const data = {
        members: members as unknown as object,
        translatePolicy: body.translatePolicy ?? "TRANSLATE",
        parentage: body.parentage ?? "PARENT",
        sourceLanguage: body.sourceLanguage ?? null,
      };

      // Upsert by (productId, fieldKey) — the PARENT case. There is no DB
      // unique on that pair (CHILD can have several), so look up first.
      const existing = await prisma.fieldLinkGroup.findFirst({
        where: { productId: id, fieldKey },
      });
      const group = existing
        ? await prisma.fieldLinkGroup.update({ where: { id: existing.id }, data })
        : await prisma.fieldLinkGroup.create({
            data: { productId: id, fieldKey, ...data },
          });

      return reply.send({ ok: true, scope, group });
    } catch (err) {
      request.log?.error({ err }, "field-links upsert failed");
      return reply
        .status(503)
        .send({ ok: false, error: "Field linking is not available yet." });
    }
  });
}
