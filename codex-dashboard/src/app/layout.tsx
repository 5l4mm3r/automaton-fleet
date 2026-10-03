import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Automaton Fleet | Command Deck",
  description: process.env.NEXT_PUBLIC_FLEET_MODE === "live"
    ? "Automaton Fleet owner dashboard and military pixel headquarters."
    : "Automaton Fleet dashboard and military pixel headquarters - local simulation.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
