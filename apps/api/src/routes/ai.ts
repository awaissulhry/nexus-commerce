import type { FastifyInstance } from "fastify";
import prisma from "../db.js";
import {
  GeminiService,
  type ProductInput,
} from "../services/ai/gemini.service.js";

const gemini = new GeminiService();

export async function aiRoutes(app: FastifyInstance) {
  /**
   * POST /ai/generate-listing
   * Accepts { productId } and returns AI-generated eBay listing data.
   */
  app.post<{ Body: { productId: string } }>(
    "/ai/generate-listing",
    async (request, reply) => {
      const { productId } = request.body;

      if (!productId) {
        return reply.status(400).send({ error: "productId is required" });
      }

      const product: any = await (prisma as any).product.findUnique({
        where: { id: productId },
        include: {
          variations: true,
          images: true,
        },
      });

      if (!product) {
        return reply.status(404).send({ error: "Product not found" });
      }

      const productInput: ProductInput = {
        sku: product.sku,
        name: product.name,
        basePrice: Number(product.basePrice),
        totalStock: product.totalStock,
        upc: product.upc,
        ean: product.ean,
        brand: product.brand,
        manufacturer: product.manufacturer,
        weightValue: product.weightValue ? Number(product.weightValue) : null,
        weightUnit: product.weightUnit,
        dimLength: product.dimLength ? Number(product.dimLength) : null,
        dimWidth: product.dimWidth ? Number(product.dimWidth) : null,
        dimHeight: product.dimHeight ? Number(product.dimHeight) : null,
        dimUnit: product.dimUnit,
        bulletPoints: product.bulletPoints ?? [],
        aPlusContent: product.aPlusContent,
        keywords: product.keywords ?? [],
        variations: (product.variations ?? []).map((v: any) => ({
          sku: v.sku,
          name: v.name,
          value: v.value,
          price: Number(v.price),
          stock: v.stock,
        })),
        images: (product.images ?? []).map((img: any) => ({
          url: img.url,
          alt: img.alt,
          type: img.type,
        })),
      };

      try {
        const ebayData = await gemini.generateEbayListingData(productInput);
        return reply.send({
          success: true,
          data: ebayData,
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
          },
        });
      } catch (error: any) {
        app.log.error(error, "AI generation failed");
        return reply.status(500).send({
          error: error?.message || "AI generation failed",
        });
      }
    }
  );
}
