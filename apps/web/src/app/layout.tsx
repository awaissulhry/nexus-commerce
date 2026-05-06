import type { Metadata } from "next";
import "./globals.css";
import AppSidebar from "@/components/layout/AppSidebar";
import CommandPalette from "@/components/CommandPalette";
import NotificationsBell from "@/components/NotificationsBell";
import MobileTopBar from "@/components/MobileTopBar";

export const metadata: Metadata = {
  title: "Nexus Commerce",
  description: "Master catalog and multi-channel listing platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="flex h-screen bg-slate-50 overflow-hidden">
          <AppSidebar />
          <div className="flex-1 flex flex-col overflow-hidden">
            <MobileTopBar />
            <main className="flex-1 overflow-auto">
              <div className="p-3 md:p-6">{children}</div>
            </main>
          </div>
        </div>
        <CommandPalette />
        <NotificationsBell />
      </body>
    </html>
  );
}
