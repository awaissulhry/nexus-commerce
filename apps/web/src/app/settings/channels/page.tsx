/**
 * Marketplace Channels Settings Page
 * Manage connections to various marketplace platforms (eBay, Amazon, Shopify, etc.)
 */

import PageHeader from "@/components/layout/PageHeader";
import { ChannelsClient } from "./ChannelsClient";

export default function ChannelsPage() {
  return (
    <div>
      <PageHeader
        title="Marketplace Channels"
        subtitle="Connect and manage your marketplace accounts"
      />
      <ChannelsClient />
    </div>
  );
}
