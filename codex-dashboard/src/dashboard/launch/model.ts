/**
 * 0.20.1: the plain-English model behind the guided Launch & channels page. Pure functions only (unit-tested in
 * src/__tests__/fleet/fleet-launch-guide.test.ts): the readiness checklist, the buyer-visible seller notice preview (the
 * same composition as the backend's fleet_seller_notice), the seller field checks (the backend's own rules, so a mistake is
 * explained before the step-up), the platform guides, the connection-check explanations and the proof-permission builder.
 * The builder only assembles the scope the backend already accepts; the backend still validates and enforces every field.
 */

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type LaunchAgent = { id: string; name: string; status?: string; paused?: boolean | null; pausedSince?: string | null };
export type Provider = "etsy" | "pinterest";

/** The Fleet's public address (deployed with the controller): offer and order pages are served here. */
export const FLEET_PUBLIC_ADDRESS = "https://api.agentfleet.vip";
export const OAUTH_REDIRECT = `${FLEET_PUBLIC_ADDRESS}/oauth/callback`;
export const RELEASE_MAX_HOURS = 72;

// ─────────────────────────────── Business details ───────────────────────────────

export type SellerDraft = { legalForm: "individual" | "company"; legalName: string; tradingName: string; postalAddress: string; vatNumber: string;
  companyNumber: string; registeredOffice: string };

export const emptySeller = (s?: Row | null): SellerDraft => ({ legalForm: s?.legalForm === "company" ? "company" : "individual", legalName: s?.legalName ?? "",
  tradingName: s?.tradingName ?? "", postalAddress: s?.postalAddress ?? "", vatNumber: s?.vatNumber ?? "", companyNumber: s?.companyNumber ?? "",
  registeredOffice: s?.registeredOffice ?? "" });

const vatOf = (v: string) => v.replace(/[\s.-]/g, "").toUpperCase();
const companyNoOf = (v: string) => v.replace(/\s/g, "").toUpperCase();

/** The backend's rules (fleet_admin_seller_set), worded for the owner. Empty object = it will be accepted. */
export function sellerProblems(d: SellerDraft): Partial<Record<keyof SellerDraft, string>> {
  const p: Partial<Record<keyof SellerDraft, string>> = {};
  const name = d.legalName.trim(), addr = d.postalAddress.trim(), trading = d.tradingName.trim(), vat = vatOf(d.vatNumber), co = companyNoOf(d.companyNumber), office = d.registeredOffice.trim();
  if (name.length < 2 || name.length > 140) p.legalName = d.legalForm === "company" ? "Enter the company’s registered name (2–140 characters)." : "Enter your full legal name (2–140 characters).";
  if (addr.length < 10 || addr.length > 400) p.postalAddress = "Enter a full postal address (10–400 characters): street, town, postcode and country.";
  if (trading && (trading.length < 2 || trading.length > 140)) p.tradingName = "A trading name is 2–140 characters, or leave it blank.";
  if (vat && !/^[A-Z]{2}[0-9A-Z]{5,13}$/.test(vat)) p.vatNumber = "Start with the two-letter country code, e.g. GB123456789, or leave it blank if you are not VAT-registered.";
  if (d.legalForm === "company") {
    if (!/^[0-9A-Z]{6,10}$/.test(co)) p.companyNumber = "Enter the company number (6–10 letters or digits, e.g. 12345678 or SC123456).";
    if (office.length < 10 || office.length > 400) p.registeredOffice = "Enter the registered office address (10–400 characters).";
  }
  return p;
}

/** The fields exactly as seller_set takes them (blank optional fields are cleared; individual drops the company fields). */
export function sellerFields(d: SellerDraft): Record<string, string | null> {
  const opt = (v: string) => (v.trim() === "" ? null : v.trim());
  return { legalForm: d.legalForm, legalName: d.legalName.trim(), tradingName: opt(d.tradingName), postalAddress: d.postalAddress.trim(), vatNumber: opt(d.vatNumber),
    companyNumber: d.legalForm === "company" ? opt(d.companyNumber) : null, registeredOffice: d.legalForm === "company" ? opt(d.registeredOffice) : null };
}

/**
 * The buyer-visible seller notice, composed exactly as the backend composes it (fleet_seller_notice): the brand and support
 * address belong to the agent's storefront; the extra line is the public site's optional notice.
 */
export function noticePreview(d: SellerDraft, opts: { brand?: string | null; supportEmail?: string | null; extra?: string | null; storefront?: boolean } = {}): string[] {
  const store = opts.storefront !== false; // false: the notice outside any venture (no brand, no support line), as fleet_seller_notice(NULL)
  const name = d.legalName.trim() || "[your legal name]", trading = d.tradingName.trim(), addr = d.postalAddress.trim() || "[your postal address]";
  const co = companyNoOf(d.companyNumber), office = d.registeredOffice.trim(), vat = vatOf(d.vatNumber);
  return [
    `Sold by ${name}${trading ? ` trading as ${trading}` : ""}${d.legalForm === "company" ? ` (company no. ${co || "[company number]"})` : ""}${store ? ` under the brand ${opts.brand || "[the agent’s brand]"}` : ""}.`,
    `Address: ${addr}`,
    ...(d.legalForm === "company" && office && office !== addr ? [`Registered office: ${office}`] : []),
    ...(store ? [`Customer support: ${opts.supportEmail || "[the brand’s support address]"}`] : []),
    ...(vat ? [`VAT no. ${vat}`] : []),
    ...(opts.extra?.trim() ? [opts.extra.trim()] : []),
  ];
}

// ─────────────────────────────── Platforms ───────────────────────────────

export type PlatformGuide = { provider: Provider; name: string; optional: string; agentManages: string[]; staysManual: string[]; youNeed: string[];
  accountSteps: string[]; appSteps: string[]; accountLabel: string; accountHelp: string; scopes: string };

export const PLATFORMS: PlatformGuide[] = [
  { provider: "etsy", name: "Etsy", optional: "Optional. Connect it only if an agent chooses Etsy to sell digital products. The agents can sell on the Fleet’s own pages without it.",
    agentManages: ["Writes listings (title, description, tags, price) and saves them as drafts", "Uploads the images and the download file", "Publishes and withdraws listings",
      "Reads its shop’s sales back into its books (Etsy delivers digital downloads to buyers itself)"],
    staysManual: ["Answering buyers’ Etsy messages: Etsy has no messaging API and does not allow automating its website, so a person answers them (the agent can draft replies for you to paste)",
      "Recording each Etsy payout: Etsy pays your bank; you record the bank line and your transfer into the treasury PayPal",
      "Etsy’s own identity checks and account notices"],
    youNeed: ["An Etsy seller account and shop in your own name (Etsy checks your identity with ID and a selfie and asks for bank details for payouts)",
      "Etsy’s fees are charged by Etsy to your shop: a fee per published listing, a fee per sale and, in some countries, a one-time shop set-up fee",
      "An Etsy developer app for your own shop (free)"],
    accountSteps: ["Go to etsy.com/sell and open a shop in your own name.", "Complete Etsy’s identity check (photo ID and a selfie) and add your bank account for payouts.",
      "You can leave the shop empty: the agent writes the listings."],
    appSteps: ["Signed in as the shop owner, open etsy.com/developers and choose “Create a new app”.",
      "Name: anything you recognise (e.g. your shop name + “Fleet”). Describe it as managing listings for your own shop.",
      `Callback URL: ${OAUTH_REDIRECT}`, "Submit it and wait until Etsy shows the app as active (Etsy reviews new apps).",
      "Keep the app’s keystring and shared secret in the Etsy developer page; you will give the keystring to the operator (the secret is entered on the server, never in chat)."],
    accountLabel: "Etsy user ID", accountHelp: "A number, e.g. 123456789. The operator reports it after the server setup step.", scopes: "listings_r listings_w shops_r transactions_r" },
  { provider: "pinterest", name: "Pinterest", optional: "Optional. Connect it only if an agent chooses Pinterest to bring visitors to its products. Nothing is sold on Pinterest itself.",
    agentManages: ["Creates boards", "Creates Pins with an image, title, description, alt text and a link to the product page or listing"],
    staysManual: ["Applying for Pinterest’s Standard access: a short screen recording of the app working, submitted by you. Until Pinterest approves it, Pins are visible only to you",
      "Pinterest’s account notices"],
    youNeed: ["A Pinterest business account in your own name (free; a personal account can be converted in its settings)", "A Pinterest developer app (free; it starts with Trial access)"],
    accountSteps: ["Go to pinterest.com/business/create (or convert your account: Settings → Account management → Convert to a business account).", "Fill in the business profile; the agent will create the boards and Pins."],
    appSteps: ["Signed in to the business account, open developers.pinterest.com → My apps → Connect app.", "Describe it as publishing Pins for your own business account.",
      `Redirect URI: ${OAUTH_REDIRECT}`, "Wait for Trial access. Keep the app ID and app secret in the developer page; you will give the app ID to the operator (the secret is entered on the server, never in chat).",
      "Later, for public Pins: request Standard access from the app page with a short video of the app working."],
    accountLabel: "Pinterest username", accountHelp: "Your Pinterest username, without the @. The operator reports it after the server setup step.",
    scopes: "boards:read boards:write pins:read pins:write user_accounts:read" },
];
export const platformGuide = (p: Provider) => PLATFORMS.find((x) => x.provider === p)!;

/** Channels on someone else's platform need the platform's rules recorded (v79 THIRD_PARTY_KINDS); own pages, email etc. do not. */
export const needsRules = (c: Row) => !["own_pages", "email", "referral", "direct"].includes(String(c.kind));
export const rulesMissing = (c: Row) => needsRules(c) && !c.rulesRecorded;

/** Which official-API platform a recorded channel is (its connection, else its address or name). */
export function providerOf(c: Row): Provider | null {
  const p = c.connection?.provider;
  if (p === "etsy" || p === "pinterest") return p;
  const hay = `${c.url ?? ""} ${c.name ?? ""}`.toLowerCase();
  return /etsy/.test(hay) ? "etsy" : /pinterest|pin\.it/.test(hay) ? "pinterest" : null;
}

/** The server vault name a connection uses (vault:<provider>/<name>, [a-z0-9_-]{1,40}); the default derives from the agent and channel. */
export function defaultVaultRef(provider: Provider, agentName: string, channelName: string): string {
  const slug = `${agentName}-${channelName}`.toLowerCase().normalize("NFKD").replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
  return `vault:${provider}/${slug || provider}`;
}

export type CheckExplanation = { what: string; fix: string; automatic?: boolean };
/** A failed connection check, in words, with what to do. Unknown errors keep the raw text for Advanced. */
export function explainCheck(error: string | null | undefined): CheckExplanation {
  const e = String(error ?? "");
  if (/different Etsy shop/i.test(e)) return { what: "The authorised Etsy account owns a different shop from the shop ID entered.", fix: "Use Connect again with the shop ID the operator reported, or re-authorise while signed in to the right Etsy account." };
  if (/business account/i.test(e)) return { what: "Pinterest allows this only for a business account.", fix: "Convert the account to a business account in Pinterest’s settings, then use Connect again to re-check." };
  if (/different account/i.test(e)) return { what: "The authorisation belongs to a different account from the one entered.", fix: "Use Connect again with the account the operator reported after the authorisation." };
  if (/other scopes/i.test(e)) return { what: "The authorisation carries different permissions from the ones the Fleet requires.", fix: "Ask the operator to authorise the app again (the request asks for exactly the right permissions), then Connect again." };
  if (/NO_TOKEN/.test(e)) return { what: "The server has no saved authorisation under this connection’s vault name.", fix: "Ask the operator to authorise the app (it uses the vault name shown under Advanced), or Connect again with the name the operator used." };
  if (/UNAUTHORIZED/.test(e)) return { what: "The platform refused the saved authorisation (it was revoked or has expired).", fix: "Ask the operator to authorise the app again, then use Connect again." };
  if (/REFRESH/.test(e)) return { what: "Renewing the platform login failed (Etsy, for example, stops renewing after 90 days without use).", fix: "Ask the operator to authorise the app again once; nothing else changes." };
  if (/RATE_LIMITED/.test(e)) return { what: "The platform asked the Fleet to slow down.", fix: "Nothing to do: the gateway checks again by itself within the hour.", automatic: true };
  if (/REJECTED/.test(e)) return { what: "The platform rejected the check request.", fix: "Check the developer app is approved and active on the platform, then use Connect again. If it repeats, ask the operator to read the channel gateway log." };
  return { what: "The connection check failed.", fix: "The gateway re-checks failed connections every hour. Use Connect again to re-check now, or ask the operator to read the channel gateway log." };
}

export const CONNECTION_STATE: Record<string, string> = { pending_check: "Connected — the gateway is checking the account and permissions (usually within a minute)",
  active: "Active — account and permissions checked", failed: "Check failed", disconnected: "Disconnected" };

// ─────────────────────────────── Proof permission ───────────────────────────────

export type PermissionDraft = { agentId: string; profile: boolean; profileSites: string; profileAccounts: string[]; draft: boolean; draftChannels: string[];
  publish: boolean; publishChannels: string[]; messages: boolean; mailTo: string; hours: number; note: string };
export const emptyPermission = (agentId = ""): PermissionDraft => ({ agentId, profile: false, profileSites: "", profileAccounts: [], draft: false, draftChannels: [],
  publish: false, publishChannels: [], messages: false, mailTo: "", hours: 24, note: "" });

const DRAFT_OPS: Record<Provider, string[]> = { etsy: ["etsy.listing.create", "etsy.listing.update", "etsy.listing.image", "etsy.listing.file"], pinterest: [] };
const PUBLISH_OPS: Record<Provider, string[]> = { etsy: [...DRAFT_OPS.etsy, "etsy.listing.activate", "etsy.listing.deactivate"], pinterest: ["pinterest.board.create", "pinterest.pin.create"] };
const OP_WORDS: Record<string, string> = { "etsy.listing.create": "save new draft listings", "etsy.listing.update": "edit listings", "etsy.listing.image": "add images",
  "etsy.listing.file": "add download files", "etsy.listing.activate": "publish listings (public)", "etsy.listing.deactivate": "withdraw listings",
  "pinterest.board.create": "create boards", "pinterest.pin.create": "create Pins (public once Pinterest grants Standard access)" };

/** "https://www.Etsy.com/sell, etsy.com" → ["https://www.etsy.com", "https://etsy.com"]; null when one is not a web address. */
export function originsOf(text: string): string[] | null {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    let u: URL;
    try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
    if (u.protocol !== "https:" || !/^[a-z0-9.-]{3,190}$/.test(u.hostname) || !u.hostname.includes(".")) return null;
    const o = `https://${u.hostname}${u.port ? `:${u.port}` : ""}`;
    if (!out.includes(o)) out.push(o);
  }
  return out;
}
export function recipientsOf(text: string): string[] | null {
  const xs = text.split(/[\s,;]+/).filter(Boolean).map((x) => x.toLowerCase());
  return xs.every((x) => /^([^@\s<>]{1,64})?@[a-z0-9.-]{3,190}$/.test(x)) ? [...new Set(xs)] : null;
}

/**
 * The release scope for the owner's choices (the backend's fields: actions, accounts, origins, mailTo, channels, apiOps,
 * expiresHours), or the problems to fix first. Research and building need no permission and add nothing.
 */
export function buildScope(d: PermissionDraft, channels: Row[], accountOrigins: Record<string, string[]> = {}): { scope: Row | null; problems: string[] } {
  const problems: string[] = [], actions = new Set<string>(), chans = new Set<string>(), ops = new Set<string>();
  let origins: string[] = [], mailTo: string[] = [];
  const mine = (id: string) => channels.find((c) => c.channelId === id && c.agentId === d.agentId);
  if (!d.agentId) problems.push("Choose the agent.");
  if (d.profile) {
    const o = originsOf(d.profileSites);
    if (!o) problems.push("Websites: enter web addresses such as etsy.com or https://www.example.com.");
    else if (o.length === 0 && d.profileAccounts.length === 0) problems.push("Create a profile: name at least one website.");
    else if (o.length > 10) problems.push("Create a profile: at most 10 websites at once.");
    else origins = o;
    // Registering records the account the agent is creating (account.register needs the site's origin). Browser work is
    // enforced per session account, so it is granted only inside accounts named here (a new one appears once recorded).
    if (o && o.length) actions.add("account_register");
    if (d.profileAccounts.length) {
      actions.add("browser"); actions.add("account_connector");
      for (const id of d.profileAccounts) for (const x of accountOrigins[id] ?? []) if (/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/.test(x) && !origins.includes(x)) origins.push(x);
      if (origins.length === 0) problems.push("Create a profile: name the website where these accounts are used.");
      if (origins.length > 10) problems.push("Create a profile: at most 10 websites at once.");
    }
  }
  for (const [on, list, words, table] of [[d.draft, d.draftChannels, "Save a draft", DRAFT_OPS], [d.publish, d.publishChannels, "Publish publicly", PUBLISH_OPS]] as const) {
    if (!on) continue;
    if (list.length === 0) { problems.push(`${words}: choose at least one connected platform.`); continue; }
    for (const id of list) {
      const c = mine(id), p = c ? providerOf(c) : null;
      if (!c || !p) { problems.push(`${words}: that platform is not one of this agent’s channels.`); continue; }
      if (table[p].length === 0) { problems.push(`${words}: ${c.name} has no drafts (Pinterest publishes directly).`); continue; }
      actions.add("channel_api"); chans.add(id); table[p].forEach((x) => ops.add(x));
    }
  }
  if (d.messages) {
    const r = recipientsOf(d.mailTo);
    if (!r || r.length === 0) problems.push("Send messages: enter the email addresses (or @domains) the agent may write to.");
    else { mailTo = r; actions.add("mail"); }
  }
  if (!(d.hours >= 1 && d.hours <= RELEASE_MAX_HOURS)) problems.push(`Duration: 1 to ${RELEASE_MAX_HOURS} hours.`);
  if (actions.size === 0 && problems.length === 0) problems.push("Choose at least one outward action. Research and building need no permission.");
  if (problems.length) return { scope: null, problems };
  const scope: Row = { actions: [...actions], expiresHours: d.hours };
  if (origins.length) scope.origins = origins;
  if (d.profile && d.profileAccounts.length) scope.accounts = [...d.profileAccounts];
  if (chans.size) { scope.channels = [...chans]; scope.apiOps = [...ops]; }
  if (mailTo.length) scope.mailTo = mailTo;
  return { scope, problems: [] };
}

/** What a scope lets the agent do, line by line, in words (for the confirmation and for active permissions). */
export function describeScope(scope: Row, look: { channel: (id: string) => Row | undefined; account?: (id: string) => Row | undefined }): string[] {
  const acts: string[] = scope.actions ?? [], out: string[] = [];
  const origins: string[] = scope.origins ?? [], host = (o: string) => o.replace(/^https:\/\//, "");
  const accs = ((scope.accounts ?? []) as string[]).map((id) => { const a = look.account?.(id); return a ? `${a.platform}${a.handle ? ` · ${a.handle}` : ""}` : "one of its accounts"; });
  if (acts.includes("account_register")) out.push(`Record new accounts it is creating on ${origins.map(host).join(", ") || "the named websites"} (the sign-up itself needs that account ticked in a permission once it is recorded)`);
  if (acts.includes("browser")) out.push(`Act in a browser (click, type, upload) on ${origins.map(host).join(", ") || "the named websites"}, only inside: ${accs.join(", ") || "the named accounts"}`);
  if (acts.includes("channel_api")) {
    for (const id of (scope.channels ?? []) as string[]) {
      const c = look.channel(id), p = c ? providerOf(c) : null;
      const ops = ((scope.apiOps ?? []) as string[]).filter((o) => !p || o.startsWith(`${p}.`)).map((o) => OP_WORDS[o] ?? o);
      out.push(`On ${c ? c.name : "a channel"}${p ? ` (${platformGuide(p).name})` : ""}: ${ops.length ? ops.join(", ") : "every API action"}`);
    }
  }
  if (acts.includes("mail")) out.push(`Send email to ${(scope.mailTo as string[] ?? []).join(", ")}`);
  if (acts.includes("sms")) out.push("Send text messages");
  if (acts.includes("account_connector") && !(scope.accounts ?? []).length) out.push("Operate accounts through their connectors");
  if (acts.includes("storefront")) out.push("Publish on its storefront");
  return out;
}

/** The consequences the owner reads before confirming. */
export function consequencesOf(scope: Row): string[] {
  const acts: string[] = scope.actions ?? [], ops: string[] = scope.apiOps ?? [], out: string[] = [];
  out.push("Anything the agent publishes, signs up for or sends is public or delivered at once, under its own brand, with your business details as the legal seller.");
  if (ops.includes("etsy.listing.activate")) out.push("Etsy charges your shop its listing fee for each listing published, and its sale fees if anything sells.");
  else if (ops.some((o) => o.startsWith("etsy."))) out.push("Etsy drafts are not visible to buyers and carry no listing fee until published.");
  if (ops.includes("pinterest.pin.create")) out.push("Pins stay visible only to you until Pinterest grants Standard access.");
  if (acts.includes("mail")) out.push("Emails are real and go only to the recipients named.");
  if (acts.includes("browser")) out.push("Profiles and pages it fills in on those sites are public as soon as the site shows them.");
  if (acts.includes("account_register")) out.push("New accounts are in the agent’s brand; each appears in its footprint (Money & identity) with a freeze link.");
  out.push("Spending is not part of this permission: card requests stay held until launch, and payments out stay under the treasury’s own money-out controls.");
  out.push("This replaces any permission the agent has now. It ends by itself when the time runs out, or when you choose End now.");
  return out;
}

// ─────────────────────────────── Readiness ───────────────────────────────

/** untracked: a fact the backend does not record (never shown as done, never counted; the operator verifies it). */
export type Check = { label: string; done: boolean; detail: string; blocker: boolean; go?: Section; untracked?: boolean };
export const UNTRACKED = "Not tracked — operator verification required";
export type Section = "business" | "platforms" | "agents" | "readiness";

/**
 * Whether the treasury PayPal can take buyers' payments, judged as the backend judges it before an offer may publish
 * (fleet_econ_offer_publish): an active PayPal rail with the receive_payments capability whose required checks are
 * verified. Only a LIVE rail is ready for real buyers; a sandbox rail is test-only; an unread status is unknown — and
 * neither is ever shown as ready.
 */
export type Receiving = { state: "ready" | "test_only" | "not_ready" | "unknown"; detail: string };
export function receivingState(paypal: Row | null, error?: string): Receiving {
  if (!paypal) return { state: "unknown", detail: error ? `Unknown: the PayPal status could not be read (${error}). Not counted as ready.` : "Unknown: the PayPal status is still being read. Not counted as ready." };
  const rails = ((paypal.rails ?? []) as Row[]).filter((r) => r.status === "active" && ((r.capabilities ?? []) as string[]).includes("receive_payments"));
  const verified = rails.filter((r) => ((r.readiness?.capabilitiesReady ?? []) as string[]).includes("receive_payments"));
  if (verified.some((r) => r.mode === "live")) return { state: "ready", detail: "Ready: a live PayPal rail with receiving verified (account access and sale ingestion)." };
  if (verified.length) return { state: "test_only", detail: "Test mode only: the receiving rail is a sandbox. Not ready for real buyers." };
  if (rails.length) return { state: "not_ready", detail: "Not ready: the rail’s receiving checks (account access and sale ingestion) are not all verified. See Money & identity." };
  return { state: "not_ready", detail: "Not ready: no active PayPal rail can receive payments. Set it up on Money & identity." };
}

/** A sales route the agents can use, with whether it is in use and ready. Each route is judged on its own requirements. */
export type Route = { key: "own_pages" | Provider; name: string; inUse: boolean; status: "ready" | "blocked" | "not_in_use" | "unknown"; detail: string; requirement: string };
export function routes(d: Row, receiving: Receiving): Route[] {
  const channels: Row[] = d.channels ?? [];
  const own: Route = { key: "own_pages", name: "The Fleet’s own offer pages (buyers pay the treasury PayPal)", inUse: true,
    requirement: "Treasury PayPal receiving payments (live)",
    status: receiving.state === "ready" ? "ready" : receiving.state === "unknown" ? "unknown" : "blocked", detail: receiving.detail };
  const api = PLATFORMS.map((g): Route => {
    const mine = channels.filter((c) => providerOf(c) === g.provider);
    const conns = mine.map((c) => c.connection).filter((x) => x && x.status !== "disconnected");
    const requirement = `${g.name} connection active (account and permissions checked)${g.provider === "etsy" ? "; PayPal is not used: Etsy pays your bank" : "; Pinterest sends visitors to an offer page or listing"}`;
    if (!mine.length) return { key: g.provider, name: g.name, inUse: false, status: "not_in_use", requirement, detail: "Not in use: no agent has chosen it. It blocks nothing." };
    if (conns.some((x) => x.status === "active")) return { key: g.provider, name: g.name, inUse: true, status: "ready", requirement, detail: "Ready: connection active." };
    if (conns.some((x) => x.status === "failed")) return { key: g.provider, name: g.name, inUse: true, status: "blocked", requirement, detail: `Blocked: the connection failed its check (${explainCheck(conns.find((x) => x.status === "failed")?.checkError).what}) Only this route waits.` };
    if (conns.some((x) => x.status === "pending_check")) return { key: g.provider, name: g.name, inUse: true, status: "blocked", requirement, detail: "Waiting: the gateway is checking the connection. Only this route waits." };
    return { key: g.provider, name: g.name, inUse: true, status: "blocked", requirement, detail: "Waiting for your connection (Connected platforms). Only this route waits." };
  });
  return [own, ...api];
}

export type Readiness = { prepare: Check[]; proof: Check[]; launch: Check[]; routes: Route[]; receiving: Receiving; complete: number; needsInput: number;
  next: { text: string; go: Section } };

export const agentRunning = (a: LaunchAgent) => a.status === "active" && a.paused !== true;

export function readiness(d: Row, agents: LaunchAgent[], receiving: Receiving): Readiness {
  const seller = d.seller?.seller, site = d.publicSite ?? {}, channels: Row[] = d.channels ?? [], salesOpen = site.salesOpen === true;
  const living = agents.filter((a) => a.status === "active"), running = living.filter(agentRunning);
  const api = channels.filter((c) => providerOf(c));
  const releases: Row[] = (d.releases ?? []).filter((r: Row) => r.active);
  const rs = routes(d, receiving), readyRoutes = rs.filter((r) => r.status === "ready");
  const sellerCheck: Check = { label: "Business details saved", done: Boolean(seller), blocker: true, go: "business",
    detail: seller ? `${seller.legalName}${seller.tradingName ? ` (trading as ${seller.tradingName})` : ""}` : "Your legal seller details: needed before anything is offered to buyers." };
  const siteCheck: Check = { label: "Fleet public address recorded", done: Boolean(site.url), blocker: true, go: "business",
    detail: site.url ? String(site.url) : seller ? "Not recorded yet: your business details are saved; record the address to finish (one confirmation)." : "Recorded when you save your business details." };
  const runCheck: Check = { label: "At least one agent running", done: running.length > 0, blocker: true, go: "agents",
    detail: running.length ? `${running.length} of ${living.length} running` : `${living.length ? `0 of ${living.length} running (paused by you)` : "No living agent"}: preparation starts when you resume one (your decision).` };
  const routeCheck: Check = { label: "At least one sales route ready", done: readyRoutes.length > 0, blocker: true, go: "readiness",
    detail: readyRoutes.length ? readyRoutes.map((r) => r.name).join("; ") : "None yet: see the routes below. A route that is not in use never blocks another." };
  // Preparing needs a running agent only; the owner's own set-up (business details, platform accounts) can happen any time.
  const prepare: Check[] = [runCheck, { ...sellerCheck, blocker: false, detail: seller ? sellerCheck.detail : "Recommended now; required before any live proof." }];
  const proof: Check[] = [sellerCheck, siteCheck, runCheck, routeCheck,
    { label: "Proof permission (the step itself, when an agent is ready)", done: releases.length > 0 || salesOpen, blocker: false, go: "readiness",
      detail: salesOpen ? "Not needed: sales are open." : releases.length ? `${releases.length} active` : "Given below when an agent is ready to show one real result (a listing, a profile, a message)." }];
  const launch: Check[] = [
    // The backend does not record proof completion, and open sales are a different fact: never derived from them.
    { label: "Live proofs completed and reviewed with the operator", done: false, untracked: true, blocker: false, go: "readiness",
      detail: `A real result on each route you will use, and one real payment end to end, verified by the operator in the release record. This page cannot see it, whether sales are open or not.` },
    { label: "Final activation (opens sales)", done: salesOpen, blocker: true, go: "readiness",
      detail: salesOpen ? "Done: sales are open." : "Your separate decision, carried out by the operator on the server together with the rest of final activation. Not a button on this page." }];
  const unique = [...new Map([...prepare, ...proof, ...launch].map((c) => [c.label, c])).values()];
  const complete = unique.filter((c) => c.done && !c.untracked).length;
  const needsInput = unique.filter((c) => !c.done && c.blocker && !c.untracked).length;
  const next = !seller ? { text: "Enter your business details", go: "business" as Section }
    : !site.url ? { text: "Record the Fleet public address (one confirmation)", go: "business" as Section }
    : running.length === 0 ? { text: "When you are ready, resume an agent so it can prepare (your decision)", go: "agents" as Section }
    : api.some((c) => c.connection?.status === "failed") ? { text: "Fix a platform connection that failed its check (Connected platforms, step 6)", go: "platforms" as Section }
    : api.some((c) => !c.connection || c.connection.status === "disconnected") ? { text: "Connect the platform an agent chose", go: "platforms" as Section }
    : salesOpen ? { text: "Launched: agents act on their own. Keep an eye on what stays with you", go: "readiness" as Section }
    : readyRoutes.length === 0 ? { text: "Make a sales route ready (see Launch readiness)", go: "readiness" as Section }
    : { text: "When an agent is ready, give it proof permission for one real result", go: "readiness" as Section };
  return { prepare, proof, launch, routes: rs, receiving, complete, needsInput, next };
}
