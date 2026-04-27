'use client';

import React from 'react';
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';

export interface PipelineItem {
  id: string;
  sku: string;
  name: string;
  basePrice: number;
  amazonAsin?: string;
  ebayItemId?: string;
  totalStock?: number;
  brand?: string;
  status?: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
}

interface PipelineColumnProps {
  title: string;
  subtitle?: string;
  items: PipelineItem[];
  isLoading?: boolean;
  onRetry?: (itemId: string) => void;
  emptyMessage?: string;
  columnColor?: 'blue' | 'yellow' | 'purple' | 'green';
}

const colorClasses = {
  blue: 'border-blue-200 bg-blue-50',
  yellow: 'border-yellow-200 bg-yellow-50',
  purple: 'border-purple-200 bg-purple-50',
  green: 'border-green-200 bg-green-50',
};

const headerColorClasses = {
  blue: 'bg-blue-100 border-blue-300',
  yellow: 'bg-yellow-100 border-yellow-300',
  purple: 'bg-purple-100 border-purple-300',
  green: 'bg-green-100 border-green-300',
};

const badgeColorClasses = {
  blue: 'bg-blue-200 text-blue-800',
  yellow: 'bg-yellow-200 text-yellow-800',
  purple: 'bg-purple-200 text-purple-800',
  green: 'bg-green-200 text-green-800',
};

export const PipelineColumn: React.FC<PipelineColumnProps> = ({
  title,
  subtitle,
  items,
  isLoading = false,
  onRetry,
  emptyMessage = 'No items',
  columnColor = 'blue',
}) => {
  return (
    <div className={`flex flex-col h-full border-2 rounded-lg ${colorClasses[columnColor]}`}>
      {/* Header */}
      <div className={`border-b-2 p-4 ${headerColorClasses[columnColor]}`}>
        <h3 className="font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-sm text-gray-600 mt-1">{subtitle}</p>}
        <div className={`mt-2 inline-block px-3 py-1 rounded-full text-sm font-medium ${badgeColorClasses[columnColor]}`}>
          {items.length} item{items.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <div className="flex items-center justify-center py-8 text-gray-500">
            <p className="text-sm">{emptyMessage}</p>
          </div>
        )}

        {!isLoading &&
          items.map((item) => (
            <div
              key={item.id}
              className="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-md transition-shadow"
            >
              {/* Item Header */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-gray-900 truncate">{item.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">SKU: {item.sku}</p>
                </div>
                {item.status === 'processing' && (
                  <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
                )}
                {item.status === 'completed' && (
                  <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                )}
                {item.status === 'failed' && (
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                )}
                {!item.status && (
                  <Clock className="w-4 h-4 text-gray-400 flex-shrink-0" />
                )}
              </div>

              {/* Item Details */}
              <div className="space-y-1 mb-2">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-600">Price:</span>
                  <span className="font-medium text-gray-900">${item.basePrice.toFixed(2)}</span>
                </div>
                {item.totalStock !== undefined && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Stock:</span>
                    <span className="font-medium text-gray-900">{item.totalStock}</span>
                  </div>
                )}
                {item.brand && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Brand:</span>
                    <span className="font-medium text-gray-900 truncate">{item.brand}</span>
                  </div>
                )}
              </div>

              {/* Error Message */}
              {item.error && (
                <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                  {item.error}
                </div>
              )}

              {/* Retry Button */}
              {item.status === 'failed' && onRetry && (
                <button
                  onClick={() => onRetry(item.id)}
                  className="w-full mt-2 px-2 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          ))}
      </div>
    </div>
  );
};

export default PipelineColumn;
