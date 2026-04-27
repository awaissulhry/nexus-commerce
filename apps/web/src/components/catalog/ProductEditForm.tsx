"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Product {
  id: string;
  sku: string;
  name: string;
  basePrice: number;
  totalStock: number;
  productType: string;
  categoryAttributes: Record<string, any>;
}

interface ProductEditFormProps {
  product: Product;
}

export default function ProductEditForm({ product }: ProductEditFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const [formData, setFormData] = useState({
    name: product.name,
    basePrice: product.basePrice,
    totalStock: product.totalStock,
    categoryAttributes: product.categoryAttributes || {},
  });

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;

    if (name === "basePrice") {
      setFormData((prev) => ({
        ...prev,
        [name]: parseFloat(value) || 0,
      }));
    } else if (name === "totalStock") {
      setFormData((prev) => ({
        ...prev,
        [name]: parseInt(value) || 0,
      }));
    } else {
      setFormData((prev) => ({
        ...prev,
        [name]: value,
      }));
    }
  };

  const handleAttributeChange = (key: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      categoryAttributes: {
        ...prev.categoryAttributes,
        [key]: value,
      },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");
    setSuccess(false);

    try {
      const response = await fetch(`/api/products/${product.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: formData.name,
          basePrice: formData.basePrice,
          totalStock: formData.totalStock,
          categoryAttributes: formData.categoryAttributes,
          syncChannels: ["AMAZON", "EBAY"],
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error?.message || "Failed to update product");
        return;
      }

      setSuccess(true);

      // Show success message for 2 seconds then redirect
      setTimeout(() => {
        router.push("/outbound");
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  const attributeKeys = Object.keys(formData.categoryAttributes);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Error Message */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Success Message */}
      {success && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-800">
            ✅ Product updated successfully! Redirecting to sync dashboard...
          </p>
        </div>
      )}

      {/* Basic Information */}
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">
          Basic Information
        </h2>

        <div className="space-y-4">
          {/* SKU (Read-only) */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              SKU
            </label>
            <input
              type="text"
              value={product.sku}
              disabled
              className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-slate-50 text-slate-600 cursor-not-allowed"
            />
            <p className="text-xs text-slate-500 mt-1">Cannot be changed</p>
          </div>

          {/* Product Name */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Product Name
            </label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          {/* Base Price */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Base Price
            </label>
            <div className="relative">
              <span className="absolute left-3 top-2 text-slate-600">$</span>
              <input
                type="number"
                name="basePrice"
                value={formData.basePrice}
                onChange={handleInputChange}
                step="0.01"
                min="0"
                className="w-full pl-7 pr-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
          </div>

          {/* Total Stock */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Total Stock
            </label>
            <input
              type="number"
              name="totalStock"
              value={formData.totalStock}
              onChange={handleInputChange}
              min="0"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
        </div>
      </div>

      {/* Category Attributes */}
      {attributeKeys.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            Category Attributes ({product.productType})
          </h2>

          <div className="space-y-4">
            {attributeKeys.map((key) => (
              <div key={key}>
                <label className="block text-sm font-medium text-slate-700 mb-1 capitalize">
                  {key.replace(/([A-Z])/g, " $1").trim()}
                </label>
                <input
                  type="text"
                  value={formData.categoryAttributes[key] || ""}
                  onChange={(e) => handleAttributeChange(key, e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sync Information */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <div className="flex gap-3">
          <svg
            className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M18 5v8a2 2 0 01-2 2h-5l-5 4v-4H4a2 2 0 01-2-2V5a2 2 0 012-2h12a2 2 0 012 2zm-11-1a1 1 0 11-2 0 1 1 0 012 0z"
              clipRule="evenodd"
            />
          </svg>
          <div>
            <h3 className="font-medium text-blue-900">Auto-Sync to Marketplaces</h3>
            <p className="text-sm text-blue-800 mt-1">
              When you save this product, it will automatically be queued for synchronization to Amazon and eBay. You can monitor the sync status in the Outbound Sync Dashboard.
            </p>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isSubmitting || success}
          className={`px-6 py-2 rounded-lg font-medium transition-colors ${
            isSubmitting || success
              ? "bg-slate-100 text-slate-400 cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-700"
          }`}
        >
          {isSubmitting ? (
            <span className="flex items-center gap-2">
              <svg
                className="w-4 h-4 animate-spin"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Saving...
            </span>
          ) : success ? (
            "✓ Saved"
          ) : (
            "Save Changes"
          )}
        </button>

        <button
          type="button"
          onClick={() => router.back()}
          disabled={isSubmitting}
          className="px-6 py-2 rounded-lg font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
