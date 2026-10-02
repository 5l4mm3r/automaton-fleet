"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { NAV } from "@/lib/nav";
import { csrf, post, setSignedOutHandler } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The signed-in frame: a session check, the sidebar, the page. Nothing renders until the session is confirmed. */
export function Console({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  React.useEffect(() => {
    const goLogin = () => { csrf.clear(); router.replace("/login/"); };
    setSignedOutHandler(goLogin);
    if (location.hash.startsWith("#enroll=")) { router.replace(`/login/${location.hash}`); return; }
    void fetch("/api/auth/state", { credentials: "same-origin", cache: "no-store" }).then((r) => r.json()).then((s) => {
      if (s.session === "full" && csrf.get()) setReady(true); else goLogin();
    }).catch(goLogin);
  }, [router]);
  if (!ready) return <div className="p-8 text-sm text-muted-foreground">Checking your session…</div>;
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href.replace(/\/$/, "")));
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className={cn("border-r bg-card lg:block lg:min-h-screen", menu ? "block" : "hidden")}>
        <div className="flex h-14 items-center border-b px-5 font-semibold">Automaton Fleet</div>
        <nav aria-label="Sections" className="flex flex-col gap-4 p-3">
          {NAV.map((g) => (
            <div key={g.group}>
              <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.group}</p>
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} onClick={() => setMenu(false)}
                  className={cn("block rounded-md px-2 py-1.5 text-sm", isActive(i.href) ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted")}>{i.label}</Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-card px-4 lg:px-8">
          <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>Menu</Button>
          <span className="hidden text-sm text-muted-foreground lg:inline">admin.agentfleet.vip</span>
          <Button id="sign-out" variant="outline" size="sm" onClick={async () => { await post("/api/auth/logout", {}); csrf.clear(); router.replace("/login/"); }}>Sign out</Button>
        </header>
        <main className="mx-auto w-full max-w-7xl p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
