'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, X, Eye, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { PipelineColumn } from './components/PipelineColumn';

interface Product {
  id: string;
  sku: string;
  name: string;
  basePrice: number;
  totalStock: number;
  images?: Array<{ url: string }>;
  ebayItemId?: string;
}

interface JobStatus {
  jobId: string;
  state: 'waiting' | 'active' | 'completed' | 'failed';
  progress?: {
    current: number;
    total: number;
    currentSku: string;
  };
  result?: {
    listed: number;
    skipped: number;
    failed: number;
    errors: Array<{ productId: string; reason: string }>;
    totalProcessed: number;
    duration: number;
  };
  failedReason?: string;
}

interface InProgressItem {
  productId: string;
  sku: string;
  current: number;
  total: number;
}

interface AmazonToEbayClientProps {
  initialProducts: Product[];
  initialPublished: Product[];
}

const MARKETPLACE_OPTIONS = [
  { value: 'EBAY_IT', label: 'eBay Italy' },
  { value: 'EBAY_US', label: 'eBay USA' },
  { value: 'EBAY_DE', label: 'eBay Germany' },
  { value: 'EBAY_FR', label: 'eBay France' },
  { value: 'EBAY_UK', label: 'eBay UK' },
];

export const AmazonToEbayClient: React.FC<AmazonToEbayClientProps> = ({
  initialProducts,
  initialPublished,
}) => {
  // State
  const [amazonProducts, setAmazonProducts] = useState<Product[]>(initialProducts);
  const [publishedProducts, setPublishedProducts] = useState<Product[]>(initialPublished);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [inProgress, setInProgress] = useState<InProgressItem[]>([]);
  const [markup, setMarkup] = useState(15);
  const [marketplaceId, setMarketplaceId] = useState<'EBAY_IT' | 'EBAY_US' | 'EBAY_DE' | 'EBAY_FR' | 'EBAY_UK'>('EBAY_IT');
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [amazonChecked, setAmazonChecked] = useState<Set<string>>(new Set());
  const [jobResult, setJobResult] = useState<JobStatus['result'] | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Filter amazon products by search term and exclude already published
  const filteredAmazonProducts = amazonProducts.filter((p) => {
    const isPublished = publishedProducts.some((pub) => pub.id === p.id);
    const matchesSearch =
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.sku.toLowerCase().includes(searchTerm.toLowerCase());
    return !isPublished && matchesSearch;
  });

  // Polling logic
  const pollJobStatus = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`/api/listings/bulk-publish-to-ebay/${jobId}`);
      if (!response.ok) throw new Error('Failed to fetch job status');

      const data = await response.json();
      const status: JobStatus = data.data;

      // Update in-progress items
      if (status.progress) {
        setInProgress([
          {
            productId: status.progress.currentSku,
            sku: status.progress.currentSku,
            current: status.progress.current,
            total: status.progress.total,
          },
        ]);
      }

      // Handle job completion
      if (status.state === 'completed' && status.result) {
        setJobResult(status.result);
        setInProgress([]);
        setCurrentJobId(null);
        setSelectedIds(new Set());

        // Add successfully published products to published list
        if (status.result.listed > 0) {
          const newPublished = amazonProducts.filter((p) =>
            status.result!.errors.every((e) => e.productId !== p.id)
          );
          setPublishedProducts((prev) => [...prev, ...newPublished]);
          setAmazonProducts((prev) =>
            prev.filter((p) => !newPublished.some((np) => np.id === p.id))
          );
        }
      }

      // Handle job failure
      if (status.state === 'failed') {
        setInProgress([]);
        setCurrentJobId(null);
        setJobResult(null);
      }
    } catch (error) {
      console.error('Error polling job status:', error);
    }
  }, [amazonProducts]);

  // Setup polling interval
  useEffect(() => {
    if (!currentJobId) return;

    const interval = setInterval(() => {
      pollJobStatus(currentJobId);
    }, 2000);

    return () => clearInterval(interval);
  }, [currentJobId, pollJobStatus]);

  // Handlers
  const toggleAmazonSelect = (productId: string) => {
    const newChecked = new Set(amazonChecked);
    if (newChecked.has(productId)) {
      newChecked.delete(productId);
    } else {
      newChecked.add(productId);
    }
    setAmazonChecked(newChecked);
  };

  const toggleSelectAll = () => {
    if (amazonChecked.size === filteredAmazonProducts.length) {
      setAmazonChecked(new Set());
    } else {
      setAmazonChecked(new Set(filteredAmazonProducts.map((p) => p.id)));
    }
  };

  const handleAddSelected = () => {
    const newSelected = new Set([...selectedIds, ...amazonChecked]);
    setSelectedIds(newSelected);
    setAmazonChecked(new Set());
  };

  const handleRemoveFromReady = (productId: string) => {
    const newSelected = new Set(selectedIds);
    newSelected.delete(productId);
    setSelectedIds(newSelected);
  };

  const handlePublishAll = async () => {
    if (selectedIds.size === 0) return;

    setIsLoading(true);
    try {
      const response = await fetch('/api/listings/bulk-publish-to-ebay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds: Array.from(selectedIds),
          marketplaceId,
          pricingMarkupPercent: markup,
          dryRun: false,
        }),
      });

      if (!response.ok) throw new Error('Failed to queue bulk job');

      const data = await response.json();
      setCurrentJobId(data.data.jobId);
      setInProgress([]);
      setJobResult(null);
    } catch (error) {
      console.error('Error publishing:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetry = async (productId: string) => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/listings/bulk-publish-to-ebay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds: [productId],
          marketplaceId,
          pricingMarkupPercent: markup,
          dryRun: false,
        }),
      });

      if (!response.ok) throw new Error('Failed to queue retry job');

      const data = await response.json();
      setCurrentJobId(data.data.jobId);
      setInProgress([]);
      setJobResult(null);
    } catch (error) {
      console.error('Error retrying:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const isMarkupValid = markup >= 0 && markup <= 500;
  const readyToListProducts = amazonProducts.filter((p) => selectedIds.has(p.id));

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Bar */}
      <div className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-bold text-gray-900">Amazon → eBay</h1>

            <div className="flex items-center gap-4">
              {/* Marketplace Dropdown */}
              <select
                value={marketplaceId}
                onChange={(e) =>
                  setMarketplaceId(
                    e.target.value as 'EBAY_IT' | 'EBAY_US' | 'EBAY_DE' | 'EBAY_FR' | 'EBAY_UK'
                  )
                }
                className="px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                {MARKETPLACE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              {/* Markup Input */}
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-700">Markup:</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    min="0"
                    max="500"
                    value={markup}
                    onChange={(e) => setMarkup(Number(e.target.value))}
                    className={`w-16 px-2 py-2 border rounded-md text-sm font-medium ${
                      isMarkupValid
                        ? 'border-gray-300 text-gray-900'
                        : 'border-red-300 text-red-900 bg-red-50'
                    }`}
                  />
                  <span className="ml-1 text-sm font-medium text-gray-700">%</span>
                </div>
              </div>

              {/* Refresh Button */}
              <button
                onClick={() => {
                  setAmazonProducts(initialProducts);
                  setPublishedProducts(initialPublished);
                }}
                className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md"
              >
                <RefreshCw className="w-5 h-5" />
              </button>
            </div>
          </div>

          {!isMarkupValid && (
            <div className="mt-2 text-sm text-red-600">
              Markup must be between 0 and 500%
            </div>
          )}
        </div>
      </div>

      {/* 4-Column Layout */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 min-h-96">
          {/* Column 1: Amazon Catalog */}
          <PipelineColumn
            title="Amazon"
            count={filteredAmazonProducts.length}
            footer={
              <button
                onClick={handleAddSelected}
                disabled={amazonChecked.size === 0}
                className="w-full px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                Add Selected →
              </button>
            }
          >
            {/* Search */}
            <div className="p-4 border-b bg-gray-50">
              <input
                type="text"
                placeholder="Search products..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            </div>

            {/* Select All */}
            <div className="p-4 border-b bg-gray-50 flex items-center gap-2">
              <input
                type="checkbox"
                checked={
                  amazonChecked.size === filteredAmazonProducts.length &&
                  filteredAmazonProducts.length > 0
                }
                onChange={toggleSelectAll}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-sm text-gray-600">Select All</span>
            </div>

            {/* Products */}
            {filteredAmazonProducts.map((product) => (
              <div
                key={product.id}
                className="p-4 hover:bg-gray-50 flex items-center gap-3"
              >
                <input
                  type="checkbox"
                  checked={amazonChecked.has(product.id)}
                  onChange={() => toggleAmazonSelect(product.id)}
                  className="w-4 h-4 rounded border-gray-300"
                />
                {product.images?.[0] && (
                  <img
                    src={product.images[0].url}
                    alt={product.name}
                    className="w-10 h-10 rounded object-cover"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {product.name}
                  </p>
                  <p className="text-xs text-gray-500">{product.sku}</p>
                  <p className="text-xs font-semibold text-gray-700">
                    €{product.basePrice.toFixed(2)}
                  </p>
                </div>
              </div>
            ))}
          </PipelineColumn>

          {/* Column 2: Ready to List */}
          <PipelineColumn
            title="Ready to List"
            count={selectedIds.size}
            footer={
              <div className="flex gap-2">
                <button
                  onClick={() => {}}
                  className="flex-1 px-3 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-md hover:bg-gray-50"
                >
                  <Eye className="w-4 h-4 inline mr-1" />
                  Preview
                </button>
                <button
                  onClick={handlePublishAll}
                  disabled={selectedIds.size === 0 || !isMarkupValid || isLoading}
                  className="flex-1 px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 inline mr-1 animate-spin" />
                      Publishing...
                    </>
                  ) : (
                    'Publish All →'
                  )}
                </button>
              </div>
            }
          >
            {readyToListProducts.map((product) => {
              const ebayPrice = product.basePrice * (1 + markup / 100);
              return (
                <div key={product.id} className="p-4 hover:bg-gray-50 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {product.name}
                    </p>
                    <p className="text-xs text-gray-500">{product.sku}</p>
                    <p className="text-xs font-semibold text-green-700">
                      €{ebayPrice.toFixed(2)}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRemoveFromReady(product.id)}
                    className="ml-2 p-1 text-gray-400 hover:text-red-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </PipelineColumn>

          {/* Column 3: In Progress */}
          <PipelineColumn
            title="In Progress"
            count={inProgress.length}
            footer={
              jobResult && (
                <div className="text-xs text-gray-600">
                  <p className="font-semibold mb-2">
                    {jobResult.listed} listed · {jobResult.failed} failed
                  </p>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-green-600 h-2 rounded-full"
                      style={{
                        width: `${(jobResult.listed / jobResult.totalProcessed) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              )
            }
          >
            {inProgress.map((item) => (
              <div key={item.productId} className="p-4 hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{item.sku}</p>
                    <p className="text-xs text-gray-500">
                      {item.current} / {item.total}
                    </p>
                  </div>
                </div>
              </div>
            ))}

            {jobResult?.errors && jobResult.errors.length > 0 && (
              <div className="p-4 border-t">
                <p className="text-xs font-semibold text-red-600 mb-2">Failed Items:</p>
                {jobResult.errors.map((error) => (
                  <div key={error.productId} className="mb-2 p-2 bg-red-50 rounded">
                    <p className="text-xs font-medium text-red-900">{error.productId}</p>
                    <p className="text-xs text-red-700">{error.reason}</p>
                    <button
                      onClick={() => handleRetry(error.productId)}
                      className="mt-1 text-xs text-red-600 hover:text-red-800 font-medium"
                    >
                      Retry
                    </button>
                  </div>
                ))}
              </div>
            )}
          </PipelineColumn>

          {/* Column 4: Live on eBay */}
          <PipelineColumn
            title="Live on eBay"
            count={publishedProducts.length}
            footer={
              <a
                href="/list/published"
                className="block text-center px-3 py-2 text-blue-600 text-sm font-medium hover:text-blue-800"
              >
                View All →
              </a>
            }
          >
            {publishedProducts.map((product) => (
              <div key={product.id} className="p-4 hover:bg-gray-50 flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {product.name}
                  </p>
                  <p className="text-xs text-gray-500">{product.sku}</p>
                </div>
                {product.ebayItemId && (
                  <a
                    href={`https://www.ebay.it/itm/${product.ebayItemId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800"
                  >
                    <Eye className="w-4 h-4" />
                  </a>
                )}
              </div>
            ))}
          </PipelineColumn>
        </div>
      </div>
    </div>
  );
};
