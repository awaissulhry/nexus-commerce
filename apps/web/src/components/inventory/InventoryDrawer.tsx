"use client";

import { useState, useEffect, useCallback } from "react";
import {
  X,
  Package,
  ShoppingCart,
  Image as ImageIcon,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";
import type { InventoryItem, ChannelData } from "@/types/inventory";

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

type DrawerTab = "master" | "amazon" | "ebay" | "images";

interface InventoryDrawerProps {
  item: InventoryItem | null;
  onClose: () => void;
}

/* ================================================================== */
/*  Sync Status Icon                                                   */
/* ================================================================== */
function SyncStatusIcon({ status }: { status?: string }) {
  if (status === "SUCCESS") {
    return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
  }
  if (status === "FAILED") {
    return <AlertCircle className="w-4 h-4 text-red-500" />;
  }
  return <Clock className="w-4 h-4 text-amber-500" />;
}

/* ================================================================== */
/*  Field Row                                                          */
/* ================================================================== */
function FieldRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-b-0">
      <span className="text-[11px] font-medium text-slate-500 uppercase tracking-tight">
        {label}
      </span>
      <span
        className={`text-[13px] text-slate-900 ${mono ? "font-mono" : ""}`}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}

/* ================================================================== */
/*  Channel Sync Card                                                  */
/* ================================================================== */
function ChannelSyncCard({
  channelName,
  data,
  listed,
}: {
  channelName: string;
  data?: ChannelData;
  listed: boolean;
}) {
  if (!listed) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-slate-300" />
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-tight">
            {channelName}
          </span>
        </div>
        <p className="text-xs text-slate-400">
          Not listed on {channelName}. Create a listing to start selling.
        </p>
        <button className="mt-3 px-3 py-1.5 text-[11px] font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors">
          + Create Listing
        </button>
      </div>
    );
  }

  const price = data
    ? new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
      }).format(data.price)
    : "—";

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <SyncStatusIcon status={data?.syncStatus} />
          <span className="text-xs font-semibold text-slate-900 uppercase tracking-tight">
            {channelName}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded hover:bg-slate-100 transition-colors text-slate-400 hover:text-blue-600"
            title="Sync Now"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            className="p-1 rounded hover:bg-slate-100 transition-colors text-slate-400 hover:text-blue-600"
            title="View on Marketplace"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-0">
        <FieldRow label="Listing ID" value={data?.listingId} mono />
        <FieldRow label="Channel Price" value={price} />
        <FieldRow label="Channel Stock" value={data?.stock} />
        <FieldRow
          label="Sync Status"
          value={data?.syncStatus || "PENDING"}
        />
        <FieldRow
          label="Last Synced"
          value={
            data?.lastSyncedAt
              ? new Date(data.lastSyncedAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Never"
          }
        />
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Tab: Master Data                                                   */
/* ================================================================== */
function MasterDataTab({ item }: { item: InventoryItem }) {
  const price = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(item.price);

  return (
    <div className="space-y-4">
      {/* Product Info */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
          Product Information
        </h4>
        <FieldRow label="SKU" value={item.sku} mono />
        <FieldRow label="Name" value={item.name} />
        <FieldRow label="Brand" value={item.brand} />
        <FieldRow label="Condition" value={item.condition} />
        <FieldRow label="Status" value={item.status} />
      </div>

      {/* Pricing & Inventory */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
          Pricing & Inventory
        </h4>
        <FieldRow label="Base Price" value={price} />
        <FieldRow label="Global Stock" value={item.stock} />
        <FieldRow label="Fulfillment" value={item.fulfillment} />
      </div>

      {/* Identifiers */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
          Marketplace Identifiers
        </h4>
        <FieldRow label="Amazon ASIN" value={item.asin} mono />
        <FieldRow label="eBay Item ID" value={item.ebayItemId} mono />
      </div>

      {/* Variations Summary */}
      {item.subRows && item.subRows.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
            Variations ({item.subRows.length})
          </h4>
          <div className="space-y-2">
            {item.subRows.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-[12px] text-slate-900 font-medium truncate">
                    {v.variationName && v.variationValue
                      ? `${v.variationName}: ${v.variationValue}`
                      : v.sku}
                  </p>
                  <p className="text-[10px] text-slate-400 font-mono">
                    {v.sku}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[12px] shrink-0">
                  <span
                    className={`font-semibold tabular-nums ${
                      v.stock === 0
                        ? "text-red-600"
                        : v.stock <= 5
                          ? "text-amber-600"
                          : "text-slate-900"
                    }`}
                  >
                    {v.stock}
                  </span>
                  <span className="text-slate-500 tabular-nums">
                    {new Intl.NumberFormat("de-DE", {
                      style: "currency",
                      currency: "EUR",
                      minimumFractionDigits: 2,
                    }).format(v.price)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  Tab: Amazon Sync                                                   */
/* ================================================================== */
function AmazonSyncTab({ item }: { item: InventoryItem }) {
  const channels = item.channels || [];
  const channelData = item.channelData || [];
  const amazonData = channelData.find((c) => c.channel === "amazon");
  const amazonListed = channels.includes("amazon");

  return (
    <div className="space-y-4">
      <ChannelSyncCard
        channelName="Amazon"
        data={amazonData}
        listed={amazonListed}
      />

      {amazonListed && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
            Amazon Actions
          </h4>
          <div className="space-y-2">
            <button className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
              Sync Price to Amazon
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
              Sync Stock to Amazon
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
              Full Listing Sync
            </button>
          </div>
        </div>
      )}

      {/* Variation-level channel data */}
      {item.subRows && item.subRows.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
            Variation Channel Status
          </h4>
          <div className="space-y-2">
            {item.subRows.map((v) => {
              const vAmazon = v.channelData?.find(
                (c) => c.channel === "amazon"
              );
              return (
                <div
                  key={v.id}
                  className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-b-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <SyncStatusIcon status={vAmazon?.syncStatus} />
                    <span className="text-[12px] text-slate-700 truncate">
                      {v.variationName && v.variationValue
                        ? `${v.variationName}: ${v.variationValue}`
                        : v.sku}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono shrink-0">
                    {vAmazon?.listingId || "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  Tab: eBay Sync                                                     */
/* ================================================================== */
function EbaySyncTab({ item }: { item: InventoryItem }) {
  const channels = item.channels || [];
  const channelData = item.channelData || [];
  const ebayData = channelData.find((c) => c.channel === "ebay");
  const ebayListed = channels.includes("ebay");

  return (
    <div className="space-y-4">
      <ChannelSyncCard
        channelName="eBay"
        data={ebayData}
        listed={ebayListed}
      />

      {ebayListed && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
            eBay Actions
          </h4>
          <div className="space-y-2">
            <button className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
              Sync Price to eBay
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
              Sync Stock to eBay
            </button>
            <button className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
              Revise Listing
            </button>
          </div>
        </div>
      )}

      {/* Variation-level channel data */}
      {item.subRows && item.subRows.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
            Variation Channel Status
          </h4>
          <div className="space-y-2">
            {item.subRows.map((v) => {
              const vEbay = v.channelData?.find((c) => c.channel === "ebay");
              return (
                <div
                  key={v.id}
                  className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-b-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <SyncStatusIcon status={vEbay?.syncStatus} />
                    <span className="text-[12px] text-slate-700 truncate">
                      {v.variationName && v.variationValue
                        ? `${v.variationName}: ${v.variationValue}`
                        : v.sku}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono shrink-0">
                    {vEbay?.listingId || "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/*  Tab: Images                                                        */
/* ================================================================== */
function ImagesTab({ item }: { item: InventoryItem }) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
          Product Images
        </h4>

        {item.imageUrl ? (
          <div className="grid grid-cols-3 gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.imageUrl}
              alt={item.name}
              className="w-full aspect-square object-cover rounded-md border border-slate-200"
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-3">
              <ImageIcon className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-xs text-slate-500 mb-3">
              No images uploaded yet
            </p>
            <button className="px-3 py-1.5 text-[11px] font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors">
              + Upload Images
            </button>
          </div>
        )}
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-tight mb-3">
          Image Guidelines
        </h4>
        <ul className="space-y-1.5 text-[11px] text-slate-500">
          <li>• Main image: white background, 1000×1000px minimum</li>
          <li>• Up to 9 images per listing (Amazon)</li>
          <li>• JPEG, PNG, or GIF format</li>
          <li>• No watermarks, logos, or text overlays</li>
          <li>• Product must fill 85% of the frame</li>
        </ul>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Main Drawer Component                                              */
/* ================================================================== */
export default function InventoryDrawer({ item, onClose }: InventoryDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>("master");
  const isOpen = item !== null;

  // Reset tab when item changes
  useEffect(() => {
    if (item) setActiveTab("master");
  }, [item]);

  // Close on Escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  const tabs: { id: DrawerTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "master",
      label: "Master Data",
      icon: <Package className="w-3.5 h-3.5" />,
    },
    {
      id: "amazon",
      label: "Amazon",
      icon: <ShoppingCart className="w-3.5 h-3.5" />,
    },
    {
      id: "ebay",
      label: "eBay",
      icon: <ShoppingCart className="w-3.5 h-3.5" />,
    },
    {
      id: "images",
      label: "Images",
      icon: <ImageIcon className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer Panel */}
      <div
        className={`
          fixed top-0 right-0 h-full w-[480px] max-w-[90vw] bg-slate-50 shadow-2xl z-50
          transform transition-transform duration-300 ease-in-out
          ${isOpen ? "translate-x-0" : "translate-x-full"}
        `}
      >
        {item && (
          <div className="flex flex-col h-full">
            {/* ── Header ──────────────────────────────────────────── */}
            <div className="flex items-center justify-between px-5 py-4 bg-white border-b border-slate-200">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-slate-900 truncate tracking-tight">
                  {item.sku}
                </p>
                <p className="text-[11px] text-slate-500 truncate mt-0.5">
                  {item.name}
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-md hover:bg-slate-100 transition-colors text-slate-400 hover:text-slate-700 ml-3"
                title="Close (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* ── Tab Navigation ──────────────────────────────────── */}
            <div className="flex items-center gap-0 px-5 bg-white border-b border-slate-200">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`
                    flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-medium border-b-2 transition-colors tracking-tight
                    ${
                      activeTab === tab.id
                        ? "border-blue-600 text-slate-900"
                        : "border-transparent text-slate-500 hover:text-slate-700"
                    }
                  `}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ── Tab Content ─────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto p-5">
              {activeTab === "master" && <MasterDataTab item={item} />}
              {activeTab === "amazon" && <AmazonSyncTab item={item} />}
              {activeTab === "ebay" && <EbaySyncTab item={item} />}
              {activeTab === "images" && <ImagesTab item={item} />}
            </div>

            {/* ── Footer Actions ──────────────────────────────────── */}
            <div className="px-5 py-3 bg-white border-t border-slate-200 flex items-center justify-between">
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors tracking-tight"
              >
                Close
              </button>
              <div className="flex items-center gap-2">
                <button className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors tracking-tight">
                  <RefreshCw className="w-3.5 h-3.5 inline mr-1.5" />
                  Sync All Channels
                </button>
                <button className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors tracking-tight">
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
