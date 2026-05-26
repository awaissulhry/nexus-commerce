import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import {
  planPropagation,
  type PropagationMember,
} from "../services/field-resolution/propagation.js";
import { translateProductCopy } from "../services/ai/translate.service.js";

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
}
