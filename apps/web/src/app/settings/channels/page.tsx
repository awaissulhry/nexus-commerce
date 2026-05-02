/**
 * Marketplace Channels Settings Page
 * Manage connections to various marketplace platforms (eBay, Amazon, Shopify, etc.)
 */

import PageHeader from "@/components/layout/PageHeader";
import { ChannelsClient } from "./ChannelsClient";

export default function ChannelsPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Channel Connections"
        description="Connect and manage your marketplace accounts"
      />
      <ChannelsClient />
    </div>
  );
}
