'use client';

import { useState } from 'react';
import {
  Download,
  Upload,
  Zap,
  ChevronDown,
  Package,
  AlertCircle,
} from 'lucide-react';

interface MarketplaceActionsDropdownProps {
  onImportAmazon?: () => Promise<void>;
  onImportEbay?: () => Promise<void>;
  onImportShopify?: () => Promise<void>;
  onSyncAmazon?: () => Promise<void>;
  onSyncEbay?: () => Promise<void>;
  onSyncShopify?: () => Promise<void>;
  onSyncAll?: () => Promise<void>;
}

export function MarketplaceActionsDropdown({
  onImportAmazon,
  onImportEbay,
  onImportShopify,
  onSyncAmazon,
  onSyncEbay,
  onSyncShopify,
  onSyncAll,
}: MarketplaceActionsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const handleImportAmazon = async () => {
    try {
      setIsSyncing(true);
      setSyncStatus('Importing from Amazon...');
      await onImportAmazon?.();
      setSyncStatus('✅ Amazon import complete!');
      setTimeout(() => {
        setSyncStatus(null);
        setIsOpen(false);
      }, 2000);
    } catch (error) {
      setSyncStatus('❌ Import failed');
      console.error('Import error:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleImportEbay = async () => {
    try {
      setIsSyncing(true);
      setSyncStatus('Importing from eBay...');
      await onImportEbay?.();
      setSyncStatus('✅ eBay import complete!');
      setTimeout(() => {
        setSyncStatus(null);
        setIsOpen(false);
      }, 2000);
    } catch (error) {
      setSyncStatus('❌ Import failed');
      console.error('Import error:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncAmazon = async () => {
    try {
      setIsSyncing(true);
      setSyncStatus('Syncing to Amazon...');
      await onSyncAmazon?.();
      setSyncStatus('✅ Amazon sync complete!');
      setTimeout(() => {
        setSyncStatus(null);
        setIsOpen(false);
      }, 2000);
    } catch (error) {
      setSyncStatus('❌ Amazon sync failed');
      console.error('Sync error:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncEbay = async () => {
    try {
      setIsSyncing(true);
      setSyncStatus('Syncing to eBay...');
      await onSyncEbay?.();
      setSyncStatus('✅ eBay sync complete!');
      setTimeout(() => {
        setSyncStatus(null);
        setIsOpen(false);
      }, 2000);
    } catch (error) {
      setSyncStatus('❌ eBay sync failed');
      console.error('Sync error:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncShopify = async () => {
    try {
      setIsSyncing(true);
      setSyncStatus('Syncing to Shopify...');
      await onSyncShopify?.();
      setSyncStatus('✅ Shopify sync complete!');
      setTimeout(() => {
        setSyncStatus(null);
        setIsOpen(false);
      }, 2000);
    } catch (error) {
      setSyncStatus('❌ Shopify sync failed');
      console.error('Sync error:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncAll = async () => {
    try {
      setIsSyncing(true);
      setSyncStatus('Syncing to all channels...');
      await onSyncAll?.();
      setSyncStatus('✅ Sync complete!');
      setTimeout(() => {
        setSyncStatus(null);
        setIsOpen(false);
      }, 2000);
    } catch (error) {
      setSyncStatus('❌ Sync failed');
      console.error('Sync error:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="relative inline-block">
      {/* Main Dropdown Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isSyncing}
        className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 rounded-lg transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed border border-blue-500"
        title="Multi-channel marketplace actions"
      >
        <Package className="w-4 h-4" />
        Marketplace Hub
        <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Status Toast */}
      {syncStatus && (
        <div className="absolute top-full mt-2 left-0 bg-gray-900 text-white px-4 py-2 rounded-lg text-sm whitespace-nowrap z-50 border border-gray-700">
          {syncStatus}
        </div>
      )}

      {/* Dropdown Menu */}
      {isOpen && !isSyncing && (
        <div className="absolute top-full mt-2 left-0 bg-white border border-gray-200 rounded-lg shadow-xl z-50 min-w-64">
          {/* Section 1: Import (Pull) */}
          <div className="border-b border-gray-200 p-3">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
              <Download className="w-3 h-3" />
              Import from Marketplaces
            </div>
            <div className="space-y-1">
              <button
                onClick={handleImportAmazon}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-orange-50 rounded transition-colors flex items-center gap-2 group"
              >
                <span className="text-lg">🔶</span>
                <span className="group-hover:text-orange-600">Import from Amazon</span>
              </button>
              <button
                onClick={handleImportEbay}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-red-50 rounded transition-colors flex items-center gap-2 group"
              >
                <span className="text-lg">🔴</span>
                <span className="group-hover:text-red-600">Import from eBay</span>
              </button>
              <button
                disabled
                className="w-full text-left px-3 py-2 text-sm text-gray-400 hover:bg-green-50 rounded transition-colors flex items-center gap-2 opacity-50 cursor-not-allowed"
                title="Coming soon"
              >
                <span className="text-lg">🟢</span>
                <span>Import from Shopify</span>
                <span className="ml-auto text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded">Soon</span>
              </button>
            </div>
          </div>

          {/* Section 2: Push to Marketplaces */}
          <div className="border-b border-gray-200 p-3">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
              <Upload className="w-3 h-3" />
              Sync to Marketplaces
            </div>
            <div className="space-y-1">
              <button
                onClick={handleSyncAmazon}
                disabled={isSyncing}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-orange-50 rounded transition-colors flex items-center gap-2 group disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="text-lg">🔶</span>
                <span className="group-hover:text-orange-600">Sync All to Amazon</span>
              </button>
              <button
                onClick={handleSyncEbay}
                disabled={isSyncing}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-red-50 rounded transition-colors flex items-center gap-2 group disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="text-lg">🔴</span>
                <span className="group-hover:text-red-600">Sync All to eBay</span>
              </button>
              <button
                onClick={handleSyncShopify}
                disabled={isSyncing}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-green-50 rounded transition-colors flex items-center gap-2 group disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="text-lg">🟢</span>
                <span className="group-hover:text-green-600">Sync All to Shopify</span>
              </button>
            </div>
          </div>

          {/* Master Button */}
          <div className="p-3 bg-gradient-to-r from-blue-50 to-purple-50">
            <button
              onClick={handleSyncAll}
              className="w-full px-3 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 rounded-lg transition-all flex items-center justify-center gap-2 border border-blue-500"
            >
              <Zap className="w-4 h-4" />
              🚀 Sync All to All Channels
            </button>
            <p className="text-xs text-gray-600 mt-2 flex items-start gap-1">
              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              Syncs all products to every configured marketplace
            </p>
          </div>
        </div>
      )}

      {/* Overlay to close dropdown */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}
