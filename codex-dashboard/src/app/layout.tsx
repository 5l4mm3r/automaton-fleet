import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Automaton Fleet | Command Deck",
  description: process.env.NEXT_PUBLIC_FLEET_MODE === "live"
    ? "Automaton Fleet owner dashboard and military pixel headquarters."
    : "Automaton Fleet dashboard and military pixel headquarters - local simulation.",
};
/** A preview build (scripts/build.mjs preview) says so on every page; production builds have no badge. */
const PREVIEW = process.env.NEXT_PUBLIC_FLEET_PREVIEW ?? "";
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{PREVIEW && <div role="status" aria-label="Preview build" className="pointer-events-none fixed left-1/2 top-1 z-50 -translate-x-1/2 rounded border border-amber-400 bg-amber-950/90 px-3 py-0.5 font-mono text-xs tracking-widest text-amber-200">PREVIEW {PREVIEW}</div>}{children}</body></html>;
}
