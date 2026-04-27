'use client';

import { useState, useEffect } from 'react';

interface SyncStatus {
  syncId: string;
  status: 'pending' | 'processing' | 'success' | 'partial' | 'failed';
  totalItems: number;
  successCount: number;
  failureCount: number;
  duration?: number;
  details?: {
    parentsCreated?: number;
    childrenCreated?: number;
    parentsUpdated?: number;
    childrenUpdated?: number;
    errors?: Array<{ sku: string; error: string }>;
  };
}

interface SyncStatusModalProps {
  isOpen: boolean;
  syncId?: string;
  onClose: () => void;
  onRetry?: (syncId: string) => void;
}

export function SyncStatusModal({ isOpen, syncId, onClose, onRetry }: SyncStatusModalProps) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !syncId) return;

    const fetchStatus = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetch(`/api/sync/amazon/catalog/${syncId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch sync status');
        }

        const result = await response.json();
        setSyncStatus(result.data);

        // Continue polling if still processing
        if (result.data.status === 'processing' || result.data.status === 'pending') {
          setTimeout(fetchStatus, 2000);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch sync status';
        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStatus();
  }, [isOpen, syncId]);

  if (!isOpen) return null;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'bg-green-50 border-green-200';
      case 'partial':
        return 'bg-yellow-50 border-yellow-200';
      case 'failed':
        return 'bg-red-50 border-red-200';
      case 'processing':
      case 'pending':
        return 'bg-blue-50 border-blue-200';
      default:
        return 'bg-gray-50 border-gray-200';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return '✓';
      case 'partial':
        return '⚠';
      case 'failed':
        return '✕';
      case 'processing':
      case 'pending':
        return '⟳';
      default:
        return '○';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'success':
        return 'Completed Successfully';
      case 'partial':
        return 'Completed with Errors';
      case 'failed':
        return 'Failed';
      case 'processing':
        return 'Processing...';
      case 'pending':
        return 'Pending...';
      default:
        return 'Unknown';
    }
  };

  const progressPercentage = syncStatus
    ? Math.round(((syncStatus.successCount + syncStatus.failureCount) / syncStatus.totalItems) * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Sync Status</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {isLoading && !syncStatus && (
          <div className="flex items-center justify-center py-12">
            <svg className="w-8 h-8 animate-spin text-blue-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="ml-3 text-gray-600">Loading sync status...</span>
          </div>
        )}

        {syncStatus && (
          <>
            {/* Status Card */}
            <div className={`border rounded-lg p-6 mb-6 ${getStatusColor(syncStatus.status)}`}>
              <div className="flex items-center gap-4">
                <div className="text-4xl">{getStatusIcon(syncStatus.status)}</div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900">
                    {getStatusText(syncStatus.status)}
                  </h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Sync ID: <code className="bg-gray-100 px-2 py-1 rounded text-xs">{syncStatus.syncId}</code>
                  </p>
                </div>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Progress</span>
                <span className="text-sm font-medium text-gray-700">{progressPercentage}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${progressPercentage}%` }}
                />
              </div>
            </div>

            {/* Statistics */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-sm text-gray-600">Total Items</p>
                <p className="text-2xl font-bold text-gray-900">{syncStatus.totalItems}</p>
              </div>
              <div className="bg-green-50 rounded-lg p-4">
                <p className="text-sm text-green-600">Successful</p>
                <p className="text-2xl font-bold text-green-700">{syncStatus.successCount}</p>
              </div>
              <div className="bg-red-50 rounded-lg p-4">
                <p className="text-sm text-red-600">Failed</p>
                <p className="text-2xl font-bold text-red-700">{syncStatus.failureCount}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-sm text-gray-600">Duration</p>
                <p className="text-2xl font-bold text-gray-900">
                  {syncStatus.duration ? `${(syncStatus.duration / 1000).toFixed(1)}s` : '-'}
                </p>
              </div>
            </div>

            {/* Details */}
            {syncStatus.details && (
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-3">Details</h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {syncStatus.details.parentsCreated !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Parents Created:</span>
                      <span className="font-medium text-gray-900">{syncStatus.details.parentsCreated}</span>
                    </div>
                  )}
                  {syncStatus.details.parentsUpdated !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Parents Updated:</span>
                      <span className="font-medium text-gray-900">{syncStatus.details.parentsUpdated}</span>
                    </div>
                  )}
                  {syncStatus.details.childrenCreated !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Children Created:</span>
                      <span className="font-medium text-gray-900">{syncStatus.details.childrenCreated}</span>
                    </div>
                  )}
                  {syncStatus.details.childrenUpdated !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Children Updated:</span>
                      <span className="font-medium text-gray-900">{syncStatus.details.childrenUpdated}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Errors */}
            {syncStatus.details?.errors && syncStatus.details.errors.length > 0 && (
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-3">
                  Errors ({syncStatus.details.errors.length})
                </h4>
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 max-h-48 overflow-y-auto">
                  <ul className="space-y-2">
                    {syncStatus.details.errors.slice(0, 10).map((err, idx) => (
                      <li key={idx} className="text-sm text-red-700">
                        <strong>{err.sku}:</strong> {err.error}
                      </li>
                    ))}
                    {syncStatus.details.errors.length > 10 && (
                      <li className="text-sm text-red-600 italic">
                        ... and {syncStatus.details.errors.length - 10} more errors
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Close
              </button>
              {syncStatus.status === 'partial' && onRetry && (
                <button
                  onClick={() => onRetry(syncStatus.syncId)}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Retry Failed Items
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
