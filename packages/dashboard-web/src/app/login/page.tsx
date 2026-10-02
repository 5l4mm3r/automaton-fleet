"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ErrorBox } from "@/components/data/views";
import { csrf, post } from "@/lib/api";
import { passkeyCreate, passkeyGet } from "@/lib/webauthn";

type State = { enrolled: boolean; locked: boolean; session: string } | null;

export default function LoginPage() {
  const router = useRouter();
  const [st, setSt] = React.useState<State>(null);
  const [token, setToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback((enrolling: boolean) => {
    void fetch("/api/auth/state", { credentials: "same-origin", cache: "no-store" }).then((r) => r.json()).then((s) => {
      if (s.session === "full" && csrf.get() && !enrolling) router.replace("/"); else setSt(s);
    });
  }, [router]);
  React.useEffect(() => {
    const m = /^#enroll=([A-Za-z0-9_-]{20,})$/.exec(location.hash);
    if (m) setToken(m[1]);
    refresh(Boolean(m));
  }, [refresh]);
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        {token ? <Enroll token={token} onDone={() => { history.replaceState(null, "", "/login/"); setToken(null); setError(null); setSt(null); refresh(true); }} setError={setError} />
          : <SignIn st={st} onDone={() => router.replace("/")} setError={setError} />}
        <CardContent><ErrorBox error={error} /></CardContent>
      </Card>
    </div>
  );
}

function SignIn({ st, onDone, setError }: { st: State; onDone: () => void; setError: (e: string | null) => void }) {
  const [step, setStep] = React.useState<"passkey" | "totp">("passkey");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (!st) return <CardHeader><CardDescription>Loading…</CardDescription></CardHeader>;
  if (!st.enrolled) return <CardHeader><CardTitle>Not enrolled</CardTitle>
    <CardDescription>Run <code>pnpm fleet:admin hub-dashboard-enroll https://admin.agentfleet.vip</code> on the server and open the link it prints.</CardDescription></CardHeader>;
  if (st.locked) return <CardHeader><CardTitle>Sign-in locked</CardTitle><CardDescription>Too many failed attempts. Try again in 15 minutes.</CardDescription></CardHeader>;
  const passkey = async () => {
    setBusy(true); setError(null);
    try {
      const o = await post("/api/auth/login/options", {});
      if (!o.ok) throw new Error(o.code);
      const v = await post("/api/auth/login/verify", { response: await passkeyGet(o.options) });
      if (!v.ok) throw new Error("Passkey refused");
      csrf.set(v.csrf);
      setStep("totp");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const totp = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await post("/api/auth/login/totp", { code: code.trim() });
      if (!r.ok) { setStep("passkey"); throw new Error("Code refused"); }
      onDone();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); setCode(""); }
  };
  return (
    <>
      <CardHeader><CardTitle>Sign in</CardTitle><CardDescription>Your passkey, then your authenticator code.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {step === "passkey" ? <Button id="login-btn" onClick={passkey} disabled={busy}>Sign in with passkey</Button> : (
          <form onSubmit={totp} className="flex flex-col gap-2">
            <Label htmlFor="login-code">Authenticator code</Label>
            <Input id="login-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <Button id="login-totp-btn" type="submit" disabled={busy}>Verify</Button>
          </form>
        )}
      </CardContent>
    </>
  );
}

function Enroll({ token, onDone, setError }: { token: string; onDone: () => void; setError: (e: string | null) => void }) {
  const [name, setName] = React.useState("owner device");
  const [totp, setTotp] = React.useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const register = async () => {
    setBusy(true); setError(null);
    try {
      const o = await post("/api/auth/enroll/options", { token });
      if (!o.ok) throw new Error(o.code);
      const v = await post("/api/auth/enroll/verify", { token, name, response: await passkeyCreate(o.options) });
      if (!v.ok) throw new Error(v.code);
      if (v.next === "totp") setTotp({ secret: v.totpSecret, uri: v.otpauth }); else onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const confirm = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await post("/api/auth/enroll/totp", { code: code.trim() });
      if (!r.ok) throw new Error("Code refused");
      setTotp(null); onDone();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  return (
    <>
      <CardHeader><CardTitle>Enroll an Admin passkey</CardTitle>
        <CardDescription>One-time link. This device creates a passkey; then you add an authenticator code.</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!totp ? (
          <>
            <Label htmlFor="pk-name">Device name</Label>
            <Input id="pk-name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button id="enroll-btn" onClick={register} disabled={busy}>Register passkey</Button>
          </>
        ) : (
          <form onSubmit={confirm} className="flex flex-col gap-2">
            <p className="text-sm">Add this secret to your authenticator app, then enter the current code:</p>
            <pre id="totp-secret" className="rounded-md bg-muted p-2 font-mono text-sm">{totp.secret}</pre>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">{totp.uri}</pre>
            <Input id="totp-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
            <Button id="totp-confirm" type="submit" disabled={busy}>Confirm</Button>
          </form>
        )}
      </CardContent>
    </>
  );
}
