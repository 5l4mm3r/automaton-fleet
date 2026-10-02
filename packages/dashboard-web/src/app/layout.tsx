import type { Metadata } from "next";
import { ToastProvider } from "@/components/shell/toast";
import "./globals.css";

export const metadata: Metadata = { title: "Automaton Fleet — Admin", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased"><ToastProvider>{children}</ToastProvider></body>
    </html>
  );
}
