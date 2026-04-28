import { GoogleGenerativeAI } from "@google/generative-ai";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Variation attached to a product (matches Prisma ProductVariation). */
export interface ProductVariationInput {
  sku: string;
  name: string; // e.g. "Color", "Size"
  value: string; // e.g. "Red", "XL"
  price: number;
  stock: number;
}

/** Image attached to a product (matches Prisma ProductImage). */
export interface ProductImageInput {
  url: string;
  alt: string | null;
  type: string; // "MAIN" | "ALT" | "LIFESTYLE"
}

/**
 * Full product payload fed into the AI enrichment layer.
 * Mirrors the Prisma Product model with its `variations` and `images`
 * relations already included.
 */
export interface ProductInput {
  sku: string;
  name: string;
  basePrice: number;
  totalStock: number;

  // Identifiers
  upc?: string | null;
  ean?: string | null;
  brand?: string | null;
  manufacturer?: string | null;

  // Physical attributes
  weightValue?: number | null;
  weightUnit?: string | null;
  dimLength?: number | null;
  dimWidth?: number | null;
  dimHeight?: number | null;
  dimUnit?: string | null;

  // Content
  bulletPoints: string[];
  aPlusContent?: unknown | null; // JSON blob
  keywords: string[];

  // Relations
  variations: ProductVariationInput[];
  images: ProductImageInput[];
}

/** Category aspect from eBay Taxonomy API */
export interface CategoryAspect {
  name: string;
  required: boolean;
  recommended: boolean;
}

/** Shape returned by the AI — consumed by EbayService. */
export interface EbayListingData {
  ebayTitle: string;
  categoryId: string;
  itemSpecifics: Record<string, string>;
  htmlDescription: string;
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class GeminiService {
  private genAI: GoogleGenerativeAI | null = null;

  constructor() {
    // Constructor does nothing — validation is deferred to getClient()
  }

  /**
   * Lazy-initialize the GoogleGenerativeAI client.
   * Validates env vars only when actually needed (first API call).
   * Throws if credentials are missing.
   */
  private getClient(): GoogleGenerativeAI {
    if (this.genAI) {
      return this.genAI;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not set");
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    return this.genAI;
  }

  /**
   * Check if Gemini API is configured.
   * Returns true if GEMINI_API_KEY is present.
   */
  isConfigured(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  /**
   * Accepts the full Product object (with variations & images) and
   * returns an optimised eBay listing with a mobile-responsive HTML
   * description that incorporates bullet points, A+ Content, and
   * available variations.
   *
   * @param product The product data to generate listing from
   * @param categoryId Real eBay category ID (resolved via Taxonomy API)
   * @param aspects Required and recommended aspects for the category
   */
  async generateEbayListingData(
    product: ProductInput,
    categoryId?: string,
    aspects?: CategoryAspect[]
  ): Promise<EbayListingData> {
    const model = this.getClient().getGenerativeModel({ model: "gemini-1.5-flash" });

    /* ── Build structured context blocks for the prompt ────────── */

    const bulletBlock =
      product.bulletPoints.length > 0
        ? product.bulletPoints.map((b, i) => `  ${i + 1}. ${b}`).join("\n")
        : "  (none provided)";

    const aPlusBlock = product.aPlusContent
      ? JSON.stringify(product.aPlusContent, null, 2)
      : "(none provided)";

    const variationsBlock =
      product.variations.length > 0
        ? product.variations
            .map(
              (v) =>
                `  - ${v.name}: ${v.value} | SKU ${v.sku} | $${v.price.toFixed(2)} | Stock ${v.stock}`
            )
            .join("\n")
        : "  (no variations)";

    const imagesBlock =
      product.images.length > 0
        ? product.images
            .map(
              (img) =>
                `  - [${img.type}] ${img.url}${img.alt ? ` (alt: "${img.alt}")` : ""}`
            )
            .join("\n")
        : "  (no images)";

    const physicalBlock = [
      product.weightValue != null
        ? `Weight: ${product.weightValue} ${product.weightUnit ?? ""}`
        : null,
      product.dimLength != null
        ? `Dimensions: ${product.dimLength} × ${product.dimWidth ?? "?"} × ${product.dimHeight ?? "?"} ${product.dimUnit ?? ""}`
        : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const identifiersBlock = [
      product.brand ? `Brand: ${product.brand}` : null,
      product.manufacturer ? `Manufacturer: ${product.manufacturer}` : null,
      product.upc ? `UPC: ${product.upc}` : null,
      product.ean ? `EAN: ${product.ean}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    /* ── Build category aspects block ────────────────────────── */

    const aspectsBlock =
      aspects && aspects.length > 0
        ? aspects
            .map((a) => {
              const status = a.required ? "[REQUIRED]" : "[RECOMMENDED]";
              return `  - ${a.name} ${status}`;
            })
            .join("\n")
        : "  (none provided)";

    /* ── Prompt ────────────────────────────────────────────────── */

    const prompt = `You are an **expert eBay template designer** and SEO specialist.
Your job is to transform the Amazon product data below into a high-converting,
mobile-responsive eBay listing.

═══════════════════════════════════════════════════════════════
PRODUCT DATA
═══════════════════════════════════════════════════════════════

Title: ${product.name}
SKU: ${product.sku}
Base Price: $${product.basePrice.toFixed(2)}
Total Stock: ${product.totalStock}
${identifiersBlock ? `Identifiers: ${identifiersBlock}` : ""}
${physicalBlock ? `Physical: ${physicalBlock}` : ""}
Keywords: ${product.keywords.length > 0 ? product.keywords.join(", ") : "(none)"}

── Bullet Points ──
${bulletBlock}

── A+ / Enhanced Content (JSON) ──
${aPlusBlock}

── Variations ──
${variationsBlock}

── Images ──
${imagesBlock}

═══════════════════════════════════════════════════════════════
eBay CATEGORY & ASPECTS (from Taxonomy API)
═══════════════════════════════════════════════════════════════

Category ID: ${categoryId || "(auto-detect)"}

Required & Recommended Aspects:
${aspectsBlock}

IMPORTANT: When generating itemSpecifics, prioritize the aspects listed above.
Use ONLY the aspect names provided. Do NOT invent aspect names.

═══════════════════════════════════════════════════════════════
OUTPUT REQUIREMENTS
═══════════════════════════════════════════════════════════════

Return ONLY a valid JSON object — no markdown fences, no commentary.
The JSON must have exactly these four keys:

1. "ebayTitle"  (string, max 80 chars)
   • SEO-optimised eBay title. Pack high-value keywords; drop filler words.

2. "categoryId"  (string)
   • Use the provided category ID: "${categoryId || "auto-detect"}"
   • NEVER use placeholder IDs like "12345".

3. "itemSpecifics"  (object of string→string)
   • MUST include the required aspects from the category above.
   • MUST use exact aspect names provided (case-sensitive).
   • Fill values from product data (Brand, Color, Size, Material, etc.).
   • Include at least 5 specifics total.

4. "htmlDescription"  (string — a single HTML fragment)
   Design rules for the HTML:
   • Mobile-first: use a single-column layout that looks great on phones
     and gracefully widens on desktop (max-width: 800px, margin: 0 auto).
   • Use **inline CSS only** (eBay strips <style> blocks and external sheets).
   • Structure:
     a) **Hero section** — product title in a styled <h1>, optional subtitle
        with brand / manufacturer.
     b) **Key Features** — render the bullet points as a clean <ul> with
        custom list-style icons (✔ or ✅ emoji).
     c) **A+ / Rich Content** — if A+ Content was provided, render it as a
        visually distinct section with a light background, padding, and
        rounded corners. Summarise or reformat the JSON into readable HTML.
     d) **Available Variations** — if variations exist, render a responsive
        table or card grid showing each variation's name, value, price, and
        stock status (In Stock / Low Stock / Out of Stock).
     e) **Specifications** — a two-column table for physical attributes,
        identifiers, and any other specs.
     f) **Footer** — a short trust / shipping note.
   • Use a cohesive colour palette: dark text (#222), accent (#0654BA —
     eBay blue), light backgrounds (#F7F7F7), and white cards.
   • Do NOT include <html>, <head>, <body>, or <script> tags.
   • Do NOT use JavaScript or external resources.
   • Keep the HTML under 4 000 characters if possible.

Respond with ONLY the JSON object.`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    try {
      // Strip any accidental markdown code fences the model might add
      const cleaned = text
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim();

      const parsed: EbayListingData = JSON.parse(cleaned);

      // Enforce the 80-character title limit
      if (parsed.ebayTitle && parsed.ebayTitle.length > 80) {
        parsed.ebayTitle = parsed.ebayTitle.substring(0, 80).trim();
      }

      return parsed;
    } catch (error) {
      throw new Error(
        `Failed to parse Gemini response as JSON: ${error instanceof Error ? error.message : String(error)}\nRaw response: ${text}`
      );
    }
  }
}
