/**
 * v89 public pages (unit, fake registry port): a request for access to the customer's repository is shown on their own
 * enquiry page with the exact terms and a consent form (escaped; no script); the consent POST passes exactly what the
 * customer typed; after consent the page offers only the app install link; a cross-site POST is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { PublicPages, type PublicPagesPort } from "../../fleet/service/public-pages.js";

describe("v89 public pages: the customer's consent to repository access", () => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  let status = "requested";
  const AUTH = "11111111-2222-3333-4444-555555555555";
  const port: PublicPagesPort = {
    async publicCall(fn, args) {
      calls.push({ fn, args });
      if (fn === "svc_enquiry_page") return { ok: true, seller: "Sold by Test Owner.", enquiry: { status: "clarifying", brief: "Fix my add function", offer: { title: "Python fixes" } }, thread: [] };
      if (fn === "svc_repo_requests") return { ok: true, installUrl: "https://github.com/apps/automaton-fleet/installations/new", requests: [{ authorizationId: AUTH, repo: "acme/<calc>",
        status, wording: "I authorise Ledgerline <b>to read</b> acme/<calc>.", expiresAt: "2026-11-01T00:00:00Z" }] };
      if (fn === "svc_repo_consent") return args[3] === "acme/<calc>" ? { ok: true, status: "consented", installUrl: "https://github.com/apps/automaton-fleet/installations/new" }
        : { ok: false, code: "FLEET_REPO_MISMATCH", reason: "type the repository name exactly as shown" };
      return { ok: false };
    },
  };
  const pages = new PublicPages(port);
  let server: http.Server;
  let base = "";
  const token = "e".repeat(64);
  beforeAll(async () => {
    server = http.createServer((req, res) => void pages.handle(req, res, (req.url ?? "/").split("?")[0], "127.0.0.1"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });

  it("shows the request with its exact terms (escaped) and a consent form; the POST passes what the customer typed", async () => {
    const html = await (await fetch(`${base}/enquiry/${token}`)).text();
    expect(html).toContain("Access to your code: acme/&lt;calc&gt;");
    expect(html).toContain("I authorise Ledgerline &lt;b&gt;to read&lt;/b&gt;");
    expect(html).toContain(`action="/enquiry/${token}/repo-consent"`);
    expect(html).toContain("Never send passwords, tokens or keys");
    const post = (repo: string, origin = base) => fetch(`${base}/enquiry/${token}/repo-consent`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ authorizationId: AUTH, repo, name: "Ada Customer" }).toString() });
    const bad = await post("acme/calc");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("type the repository name exactly as shown");
    const good = await post("acme/<calc>");
    expect(good.status).toBe(200);
    expect(await good.text()).toContain(`href="https://github.com/apps/automaton-fleet/installations/new"`);
    expect(calls.filter((c) => c.fn === "svc_repo_consent").at(-1)!.args).toEqual(["enquiry", token, AUTH, "acme/<calc>", "Ada Customer", expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect((await post("acme/<calc>", "https://evil.example.com")).status).toBe(403);
  });

  it("after consent the page offers the install link; once active, how to end it", async () => {
    status = "consented";
    expect(await (await fetch(`${base}/enquiry/${token}`)).text()).toContain("Install the GitHub App");
    status = "active";
    const html = await (await fetch(`${base}/enquiry/${token}`)).text();
    expect(html).toContain("Access is active");
    expect(html).toContain("uninstall the app");
    expect(html).not.toContain("repo-consent");
  });
});
