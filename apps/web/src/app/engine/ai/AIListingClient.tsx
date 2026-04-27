"use client";

import { useState, useMemo } from "react";
import { generateAIListing } from "./actions";
import type { AIProduct } from "./page";

interface AIListingClientProps {
  products: AIProduct[];
}

interface GeneratedListing {
  ebayTitle: string;
  categoryId: string;
  itemSpecifics: Record<string, string>;
  htmlDescription: string;
}

export default function AIListingClient({ products }: AIListingClientProps) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedListing | null>(null);
  const [previewTab, setPreviewTab] = useState<"preview" | "html" | "specifics">("preview");

  const filteredProducts = useMemo(() => {
    if (!search) return products;
    const q = search.toLowerCase();
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.amazonAsin?.toLowerCase().includes(q) ||
        p.brand?.toLowerCase().includes(q)
    );
  }, [products, search]);

  const selectedProduct = products.find((p) => p.id === selectedId);

  const handleGenerate = async () => {
    if (!selectedId) return;
    setGenerating(true);
    setError(null);
    setResult(null);

    try {
      const res = await generateAIListing(selectedId);
      if (res.success && res.data) {
        setResult(res.data as GeneratedListing);
      } else {
        setError(res.error || "Generation failed");
      }
    } catch {
      setError("Failed to generate listing");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* ── Left Panel: Product Selector ─────────────────────── */}
      <div className="lg:col-span-4">
        <div className="bg-white rounded-lg shadow border border-gray-200">
          <div className="p-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Select a Product</h3>
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                placeholder="Search products…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              />
            </div>
          </div>

          <div className="max-h-[500px] overflow-y-auto divide-y divide-gray-100">
            {filteredProducts.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">No products found</div>
            ) : (
              filteredProducts.map((product) => (
                <button
                  key={product.id}
                  onClick={() => setSelectedId(product.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${
                    selectedId === product.id ? "bg-purple-50 border-l-4 border-purple-600" : ""
                  }`}
                >
                  <p className="text-sm font-medium text-gray-900 truncate">{product.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-gray-500 font-mono">{product.sku}</span>
                    {product.brand && (
                      <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {product.brand}
                      </span>
                    )}
                    {product.ebayItemId && (
                      <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                        eBay ✓
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                    <span>${product.basePrice.toFixed(2)}</span>
                    <span>{product.totalStock} in stock</span>
                    {product.hasImages && <span>📷</span>}
                    {product.hasVariations && <span>🔀</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Product Details Card */}
        {selectedProduct && (
          <div className="bg-white rounded-lg shadow border border-gray-200 mt-4 p-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-2">Product Details</h4>
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-gray-500">SKU</dt>
                <dd className="font-mono text-gray-900">{selectedProduct.sku}</dd>
              </div>
              {selectedProduct.amazonAsin && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">ASIN</dt>
                  <dd className="font-mono text-gray-900">{selectedProduct.amazonAsin}</dd>
                </div>
              )}
              {selectedProduct.brand && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Brand</dt>
                  <dd className="text-gray-900">{selectedProduct.brand}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-gray-500">Price</dt>
                <dd className="text-gray-900">${selectedProduct.basePrice.toFixed(2)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Stock</dt>
                <dd className="text-gray-900">{selectedProduct.totalStock}</dd>
              </div>
              {selectedProduct.bulletPoints.length > 0 && (
                <div className="pt-2 border-t border-gray-100">
                  <dt className="text-gray-500 mb-1">Bullet Points</dt>
                  <dd className="text-gray-700">
                    <ul className="list-disc list-inside space-y-0.5">
                      {selectedProduct.bulletPoints.slice(0, 3).map((bp, i) => (
                        <li key={i} className="truncate">{bp}</li>
                      ))}
                      {selectedProduct.bulletPoints.length > 3 && (
                        <li className="text-gray-400">+{selectedProduct.bulletPoints.length - 3} more</li>
                      )}
                    </ul>
                  </dd>
                </div>
              )}
              {selectedProduct.ebayTitle && (
                <div className="pt-2 border-t border-gray-100">
                  <dt className="text-gray-500">Current eBay Title</dt>
                  <dd className="text-gray-700 mt-0.5">{selectedProduct.ebayTitle}</dd>
                </div>
              )}
            </dl>

            <button
              onClick={handleGenerate}
              disabled={generating}
              className="mt-4 w-full px-4 py-2.5 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {generating ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Generating with Gemini AI…
                </span>
              ) : (
                "🤖 Generate eBay Listing"
              )}
            </button>
          </div>
        )}
      </div>

      {/* ── Right Panel: AI Output ───────────────────────────── */}
      <div className="lg:col-span-8">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-red-800">❌ {error}</p>
          </div>
        )}

        {!result && !generating && (
          <div className="bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
            <div className="text-5xl mb-4">🤖</div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">AI Listing Generator</h3>
            <p className="text-sm text-gray-500 max-w-md mx-auto">
              Select a product from the left panel and click &quot;Generate eBay Listing&quot; to create
              an optimized listing with Gemini AI. The AI will generate an SEO-optimized title,
              category mapping, item specifics, and a mobile-responsive HTML description.
            </p>
          </div>
        )}

        {generating && (
          <div className="bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
            <div className="flex flex-col items-center gap-4">
              <svg className="animate-spin w-10 h-10 text-purple-600" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Generating Listing…</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Gemini AI is analyzing the product data and creating an optimized eBay listing.
                  This may take 10-30 seconds.
                </p>
              </div>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-4">
            {/* Title Card */}
            <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                    Generated eBay Title
                  </p>
                  <h2 className="text-lg font-bold text-gray-900">{result.ebayTitle}</h2>
                  <p className="text-xs text-gray-400 mt-1">
                    {result.ebayTitle.length}/80 characters · Category ID: {result.categoryId}
                  </p>
                </div>
                <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-1 rounded-full">
                  ✅ Generated
                </span>
              </div>
            </div>

            {/* Tabbed Preview */}
            <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
              <div className="border-b border-gray-200 px-4">
                <nav className="flex gap-4">
                  {(
                    [
                      { key: "preview", label: "📱 Preview" },
                      { key: "html", label: "🔧 HTML Source" },
                      { key: "specifics", label: "📋 Item Specifics" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setPreviewTab(t.key)}
                      className={`py-3 text-sm font-medium border-b-2 transition-colors ${
                        previewTab === t.key
                          ? "border-purple-600 text-purple-700"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </nav>
              </div>

              <div className="p-5">
                {previewTab === "preview" && (
                  <div className="max-w-[800px] mx-auto">
                    <div
                      className="border border-gray-200 rounded-lg p-4 bg-white"
                      dangerouslySetInnerHTML={{ __html: result.htmlDescription }}
                    />
                  </div>
                )}

                {previewTab === "html" && (
                  <div className="relative">
                    <button
                      onClick={() => navigator.clipboard.writeText(result.htmlDescription)}
                      className="absolute top-2 right-2 px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
                    >
                      📋 Copy
                    </button>
                    <pre className="bg-gray-50 rounded-lg p-4 text-xs text-gray-800 overflow-x-auto max-h-[500px] overflow-y-auto font-mono leading-relaxed">
                      {result.htmlDescription}
                    </pre>
                  </div>
                )}

                {previewTab === "specifics" && (
                  <div className="overflow-hidden rounded-lg border border-gray-200">
                    <table className="w-full">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">
                            Attribute
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">
                            Value
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {Object.entries(result.itemSpecifics).map(([key, value]) => (
                          <tr key={key} className="hover:bg-gray-50">
                            <td className="px-4 py-2.5 text-sm font-medium text-gray-700">{key}</td>
                            <td className="px-4 py-2.5 text-sm text-gray-900">{value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
