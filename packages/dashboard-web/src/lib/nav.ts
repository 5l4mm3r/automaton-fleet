/** The control centre's sections (master handoff §36/§49 + owner correction 2026-10-02). One entry = one route. */
export type NavItem = { href: string; label: string };
export const NAV: Array<{ group: string; items: NavItem[] }> = [
  { group: "Fleet", items: [
    { href: "/", label: "Overview" }, { href: "/agents/", label: "Agents" }, { href: "/treasury/", label: "Treasury" },
    { href: "/wallets/", label: "Wallets" }, { href: "/ventures/", label: "Ventures" } ] },
  { group: "Growth", items: [
    { href: "/replication/", label: "Replication" }, { href: "/births/", label: "Birth orders" }, { href: "/missions/", label: "Missions & roles" },
    { href: "/knowledge/", label: "Knowledge" }, { href: "/estate/", label: "Estate" } ] },
  { group: "Identity", items: [
    { href: "/identity/", label: "Identity" }, { href: "/credentials/", label: "Credentials" }, { href: "/owner-vault/", label: "Owner identity vault" },
    { href: "/email/", label: "Email" }, { href: "/sms/", label: "SMS" }, { href: "/browser/", label: "Browser & accounts" } ] },
  { group: "Control", items: [
    { href: "/alerts/", label: "Alerts" }, { href: "/security/", label: "Security" }, { href: "/audit/", label: "Audit logs" }, { href: "/settings/", label: "Settings" } ] },
];
