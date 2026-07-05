/** F1 — all app pages live inside the factory shell; /login stays outside. */
import { FactoryShell } from "@/components/FactoryShell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <FactoryShell>{children}</FactoryShell>;
}
