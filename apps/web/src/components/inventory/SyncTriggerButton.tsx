'use client';

import { useState } from 'react';

interface SyncTriggerButtonProps {
  onSyncStart?: (syncId: string) => void;
  onSyncComplete?: (result: any) => void;
  disabled?: boolean;
  className?: string;
}

export function SyncTriggerButton({
  onSyncStart,
  onSyncComplete,
  disabled = false,
  className = '',
}: SyncTriggerButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showNotification = (title: string, message: string, type: 'success' | 'error' = 'success') => {
    console.log(`[${type.toUpperCase()}] ${title}: ${message}`);
    // In a real app, this would use a toast notification system
  };

  const handleSync = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Fetch products to sync
      const productsResponse = await fetch('/api/inventory?limit=1000');
      if (!productsResponse.ok) {
        throw new Error('Failed to fetch products');
      }

      const { data: products } = await productsResponse.json();

      if (!products || products.length === 0) {
        showNotification('No Products', 'No products available to sync', 'error');
        return;
      }

      // Prepare products for sync
      const productsToSync = products
        .filter((p: any) => p.amazonAsin || p.sku)
        .map((p: any) => ({
          asin: p.amazonAsin || '',
          parentAsin: p.parentId ? p.parentAsin : undefined,
          title: p.name,
          sku: p.sku,
          price: p.basePrice,
          stock: p.totalStock,
          fulfillmentChannel: p.fulfillmentChannel || 'FBA',
          shippingTemplate: p.shippingTemplate,
        }));

      if (productsToSync.length === 0) {
        showNotification('No Valid Products', 'No products with ASIN or SKU found to sync', 'error');
        return;
      }

      // Trigger sync
      const syncResponse = await fetch('/api/sync/amazon/catalog', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ products: productsToSync }),
      });

      if (!syncResponse.ok) {
        const errorData = await syncResponse.json();
        throw new Error(errorData.error || 'Sync failed');
      }

      const syncResult = await syncResponse.json();

      if (syncResult.success) {
        const syncId = syncResult.data.syncId;
        onSyncStart?.(syncId);

        showNotification('Sync Started', `Syncing ${productsToSync.length} products to Amazon`);

        // Poll for sync completion
        pollSyncStatus(syncId);
      } else {
        throw new Error(syncResult.error || 'Sync failed');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
      setError(errorMessage);
      showNotification('Sync Failed', errorMessage, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const pollSyncStatus = async (syncId: string) => {
    try {
      const response = await fetch(`/api/sync/amazon/catalog/${syncId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch sync status');
      }

      const result = await response.json();
      const syncStatus = result.data;

      if (syncStatus.status === 'success' || syncStatus.status === 'partial' || syncStatus.status === 'failed') {
        onSyncComplete?.(syncStatus);

        const statusMessage =
          syncStatus.status === 'success'
            ? `Sync completed successfully! ${syncStatus.successCount} items synced.`
            : syncStatus.status === 'partial'
              ? `Sync completed with errors. ${syncStatus.successCount} items synced, ${syncStatus.failureCount} failed.`
              : `Sync failed. ${syncStatus.failureCount} items failed.`;

        showNotification('Sync Complete', statusMessage, syncStatus.status === 'success' ? 'success' : 'error');
      } else {
        // Still processing, poll again
        setTimeout(() => pollSyncStatus(syncId), 2000);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to check sync status';
      console.error('Sync status check failed:', errorMessage);
    }
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button
        onClick={handleSync}
        disabled={disabled || isLoading}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <>
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Syncing...
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Sync to Amazon
          </>
        )}
      </button>
      {error && (
        <div className="flex items-center gap-1 text-sm text-red-600">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
