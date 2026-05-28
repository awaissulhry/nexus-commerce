import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import {
  planPropagation,
  type PropagationMember,
} from "../services/field-resolution/propagation.js";
import { translateProductCopy } from "../services/ai/translate.service.js";
import { auditLogService } from "../services/audit-log.service.js";

// Marketplace → ISO 639-1 language. Used to decide which linked members
// need translation. EU + a few global markets cover Xavia's footprint.
const MARKET_LANG: Record<string, string> = {
  IT: "it", DE: "de", FR: "fr", ES: "es", UK: "en", GB: "en", US: "en",
  NL: "nl", SE: "sv", PL: "pl", BE: "nl", IE: "en", AT: "de", CH: "de",
  PT: "pt", JP: "ja",
};

// fieldKey → the translateProductCopy field it maps to (only text copy is
// translatable; everything else propagates verbatim).
function translatableField(fieldKey: string): "name" | "description" | null {
  const k = fieldKey.toLowerCase();
  if (["title", "item_name", "name"].includes(k)) return "name";
  if (["description", "product_description"].includes(k)) return "description";
  return null;
}

function currentValueFor(
  listing: { title: string | null; description: string | null; platformAttributes: unknown } | undefined,
  fieldKey: string,
): string | null {
  if (!listing) return null;
  const k = fieldKey.toLowerCase();
  if (["title", "item_name", "name"].includes(k)) return listing.title ?? null;
  if (["description", "product_description"].includes(k)) return listing.description ?? null;
  const pa = (listing.platformAttributes ?? null) as Record<string, unknown> | null;
  const v = pa?.[fieldKey];
  return v == null ? null : String(v);
}

// FL.4.4 — cap distinct-language translation calls per preview so a
// runaway group can't burn AI budget.
const MAX_TRANSLATE_LANGS = 12;

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
      variantId?: string | null;
    };
    const scope = body.scope ?? "master";
    // T3.1 — null variantId = PARENT (product-level) group; a set
    // variantId = CHILD group pinning that one variant. Identity is
    // (productId, fieldKey, variantId), so every query scopes by it and
    // a CHILD change never touches the PARENT group (or vice versa).
    const variantId = body.variantId ?? null;
    const coordKey = variantId ? `${id}:${fieldKey}:${variantId}` : `${id}:${fieldKey}`;

    try {
      // Non-linked scopes share no canonical value → clear this coordinate's group.
      if (scope !== "linked") {
        const prior = await prisma.fieldLinkGroup.findFirst({
          where: { productId: id, fieldKey, variantId },
        });
        await prisma.fieldLinkGroup.deleteMany({ where: { productId: id, fieldKey, variantId } });
        // Only audit a real change — clearing an already-unlinked field is a no-op.
        if (prior) {
          await auditLogService.write({
            ip: request.ip,
            entityType: "field_link",
            entityId: coordKey,
            action: scope === "independent" ? "field_link.independent" : "field_link.unlinked",
            before: { members: prior.members, translatePolicy: prior.translatePolicy },
            after: null,
            metadata: { productId: id, fieldKey, variantId, scope },
          });
        }
        return reply.send({ ok: true, scope, variantId, group: null });
      }

      const members = Array.isArray(body.members) ? body.members : [];
      const data = {
        members: members as unknown as object,
        translatePolicy: body.translatePolicy ?? "TRANSLATE",
        // A variant coordinate forces CHILD parentage regardless of the
        // client hint; product-level links stay PARENT.
        parentage: variantId ? ("CHILD" as const) : (body.parentage ?? "PARENT"),
        variantId,
        sourceLanguage: body.sourceLanguage ?? null,
      };

      // Upsert by (productId, fieldKey, variantId). No DB unique on the
      // triple (kept flexible), so look up first.
      const existing = await prisma.fieldLinkGroup.findFirst({
        where: { productId: id, fieldKey, variantId },
      });
      const group = existing
        ? await prisma.fieldLinkGroup.update({ where: { id: existing.id }, data })
        : await prisma.fieldLinkGroup.create({
            data: { productId: id, fieldKey, ...data },
          });

      await auditLogService.write({
        ip: request.ip,
        entityType: "field_link",
        entityId: coordKey,
        action: existing ? "field_link.updated" : "field_link.linked",
        before: existing
          ? { members: existing.members, translatePolicy: existing.translatePolicy }
          : null,
        after: { members, translatePolicy: data.translatePolicy },
        metadata: {
          productId: id,
          fieldKey,
          variantId,
          parentage: data.parentage,
          scope: "linked",
          memberCount: members.length,
          marketplaces: members.map((m) => `${m.channel}:${m.marketplace}`),
        },
      });

      return reply.send({ ok: true, scope, variantId, group });
    } catch (err) {
      request.log?.error({ err }, "field-links upsert failed");
      return reply
        .status(503)
        .send({ ok: false, error: "Field linking is not available yet." });
    }
  });

  // FL.4.2/4.3 — PREVIEW the propagation diff for a linked field. Plans
  // the fan-out, loads each member's current value, and fills cross-
  // language text via translateProductCopy (budget-capped). Read + AI
  // only — NO listing writes here; the cockpit writes confirmed members
  // through the editor's own PUT endpoint after the operator approves.
  app.post(
    "/api/products/:id/field-links/:fieldKey/propagate-preview",
    async (request, reply) => {
      const { id, fieldKey } = request.params as { id: string; fieldKey: string };
      const body = (request.body ?? {}) as {
        editedValue?: string;
        sourceChannel?: string;
        sourceMarketplace?: string;
        sourceLanguage?: string | null;
      };
      const editedValue = body.editedValue ?? "";
      try {
        const group = await prisma.fieldLinkGroup.findFirst({
          where: { productId: id, fieldKey },
        });
        if (!group) return reply.send({ entries: [], translatable: false });

        const groupMembers = (Array.isArray(group.members) ? group.members : []) as Array<{
          channel: string;
          marketplace: string;
          variantId?: string;
        }>;

        const listings = await prisma.channelListing.findMany({
          where: { productId: id },
          select: { channel: true, marketplace: true, title: true, description: true, platformAttributes: true },
        });
        const byCoord = new Map(listings.map((l) => [`${l.channel}:${l.marketplace}`, l]));

        const planMembers: PropagationMember[] = groupMembers.map((m) => ({
          channel: m.channel,
          marketplace: m.marketplace,
          variantId: m.variantId,
          currentValue: currentValueFor(byCoord.get(`${m.channel}:${m.marketplace}`), fieldKey),
          language: MARKET_LANG[m.marketplace?.toUpperCase()] ?? null,
        }));

        const entries = planPropagation({
          editedValue,
          sourceChannel: body.sourceChannel ?? "",
          sourceMarketplace: body.sourceMarketplace ?? "",
          sourceLanguage: body.sourceLanguage ?? null,
          translatePolicy: group.translatePolicy,
          members: planMembers,
        });

        // Fill cross-language entries via AI (budget-capped per language).
        const tf = translatableField(fieldKey);
        let aiBudgetExceeded = false;
        if (tf && group.translatePolicy === "TRANSLATE") {
          const byLang = new Map<string, typeof entries>();
          for (const e of entries) {
            if (e.action !== "translate" || !e.language) continue;
            const list = byLang.get(e.language) ?? [];
            list.push(e);
            byLang.set(e.language, list);
          }
          let calls = 0;
          for (const [lang, langEntries] of byLang) {
            if (calls >= MAX_TRANSLATE_LANGS) {
              aiBudgetExceeded = true;
              break;
            }
            calls++;
            try {
              const res = await translateProductCopy({
                source: { [tf]: editedValue } as { name?: string; description?: string },
                targetLanguage: lang,
                fields: [tf],
                productId: id,
                feature: "cockpit-propagate",
              });
              const translated = tf === "name" ? res.name : res.description;
              for (const e of langEntries) e.proposedValue = translated ?? null;
            } catch (err) {
              request.log?.warn({ err, lang }, "propagate translate failed");
            }
          }
        }

        return reply.send({ entries, translatable: !!tf, aiBudgetExceeded });
      } catch (err) {
        request.log?.error({ err }, "propagate-preview failed");
        return reply.status(503).send({ entries: [], error: "Propagation preview unavailable." });
      }
    },
  );

  // FL.6.2 — Smart link suggestions. Scans the product's listings for
  // fields whose value is already identical across >=2 coordinates and
  // that aren't linked yet, so the operator can one-click "link all".
  app.get("/api/products/:id/field-links/suggestions", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const [listings, groups] = await Promise.all([
        prisma.channelListing.findMany({
          where: { productId: id },
          select: { channel: true, marketplace: true, title: true, description: true, price: true },
        }),
        prisma.fieldLinkGroup.findMany({ where: { productId: id }, select: { fieldKey: true } }),
      ]);
      const linked = new Set(groups.map((g) => g.fieldKey));

      const comparable: Array<{
        fieldKey: string;
        label: string;
        get: (l: (typeof listings)[number]) => string | null;
      }> = [
        { fieldKey: "title", label: "Title", get: (l) => l.title },
        { fieldKey: "description", label: "Description", get: (l) => l.description },
        { fieldKey: "price", label: "Price", get: (l) => (l.price == null ? null : String(l.price)) },
      ];

      const suggestions: Array<{
        fieldKey: string;
        label: string;
        sampleValue: string;
        members: Array<{ channel: string; marketplace: string }>;
        count: number;
      }> = [];

      for (const f of comparable) {
        if (linked.has(f.fieldKey)) continue;
        const byValue = new Map<string, Array<{ channel: string; marketplace: string }>>();
        for (const l of listings) {
          const v = f.get(l);
          if (v == null || v.trim() === "") continue;
          const arr = byValue.get(v) ?? [];
          arr.push({ channel: l.channel, marketplace: l.marketplace });
          byValue.set(v, arr);
        }
        let best: { val: string; members: Array<{ channel: string; marketplace: string }> } | null = null;
        for (const [val, members] of byValue) {
          if (members.length >= 2 && (!best || members.length > best.members.length)) {
            best = { val, members };
          }
        }
        if (best) {
          suggestions.push({
            fieldKey: f.fieldKey,
            label: f.label,
            sampleValue: best.val.slice(0, 80),
            members: best.members,
            count: best.members.length,
          });
        }
      }

      return reply.send({ suggestions });
    } catch (err) {
      request.log?.warn({ err }, "field-link suggestions failed");
      return reply.send({ suggestions: [] });
    }
  });
}
