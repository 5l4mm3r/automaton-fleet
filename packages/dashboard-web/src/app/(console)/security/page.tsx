"use client";
import { ActionButton } from "@/components/actions/action-form";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { when } from "@/lib/format";

export default function Security() {
  const s = useRead<any>("security");
  return (
    <>
      <PageHeader title="Security" description="How you sign in: passkeys, sessions, recovery." />
      <Loading loading={s.loading} error={s.error}>
        <div className="flex flex-col gap-4">
          <Section title="Passkeys" description="Add another passkey (e.g. a hardware key) with a new hub-dashboard-enroll link."><DataTable rows={s.data?.passkeys} rowKey={(p) => p.credentialId} columns={[
            { key: "name", label: "Name" }, { key: "createdAt", label: "Added", render: (p) => when(p.createdAt) }, { key: "lastUsedAt", label: "Last used", render: (p) => when(p.lastUsedAt) },
            { key: "revokedAt", label: "Revoked", render: (p) => when(p.revokedAt) },
            { key: "revoke", label: "", render: (p) => p.revokedAt ? null : <ActionButton op="passkey_revoke" args={{ credentialId: p.credentialId }} label="Revoke" variant="destructive" confirm="Revoke this passkey?" onDone={() => void s.reload()} /> }]} /></Section>
          <Section title="Sessions" actions={<ActionButton op="session_revoke_all" args={{}} label="Sign out everywhere else" variant="destructive" onDone={() => void s.reload()} />}>
            <DataTable rows={s.data?.sessions} columns={[{ key: "current", label: "This one" }, { key: "ip", label: "IP" }, { key: "userAgent", label: "Browser" },
              { key: "createdAt", label: "Started", render: (x) => when(x.createdAt) }, { key: "lastSeenAt", label: "Last seen", render: (x) => when(x.lastSeenAt) }]} /></Section>
          <Section title="Authenticator code"><ActionButton op="totp_reset" args={{}} label="Reset the TOTP factor" variant="destructive" confirm="Reset? You will need a new enrollment link to set a new one." /></Section>
        </div>
      </Loading>
    </>
  );
}
