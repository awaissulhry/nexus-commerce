/** F1 — the Inbox IS the home page in an email-born workflow (F0-IA). */
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/inbox");
}
