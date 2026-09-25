/**
 * Phase C: the ChatGPT adapter's whole module graph loads without any
 * database driver, fleet store, treasury, wallet, SSH-tunnel or CLI module.
 * Each is replaced by a mock that throws when loaded; a control proves the
 * mocks are live. (vi.mock is file-scoped, hence a separate file.)
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("pg", () => {
  throw new Error("FORBIDDEN MODULE LOADED: pg");
});
vi.mock("../../fleet/postgres/store.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: fleet/postgres/store");
});
vi.mock("../../fleet/operator/gateway.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: fleet/operator/gateway");
});
vi.mock("../../fleet/operator/admin.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: fleet/operator/admin");
});
vi.mock("../../fleet/treasury/store.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: fleet/treasury/store");
});
vi.mock("../../identity/wallet.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: identity/wallet");
});
vi.mock("../../fleet/bridge/tunnel.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: fleet/bridge/tunnel (ssh)");
});
vi.mock("../../fleet/bridge/cli.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: fleet/bridge/cli");
});

describe("Phase C: the ChatGPT adapter loads no DB, store, treasury, wallet, SSH or CLI module", () => {
  it("control: a mocked forbidden module refuses to load", async () => {
    await expect(import("../../fleet/bridge/tunnel.js")).rejects.toThrow(/FORBIDDEN MODULE LOADED|error when mocking a module/);
    await expect(import("../../fleet/postgres/store.js")).rejects.toThrow(/FORBIDDEN MODULE LOADED|error when mocking a module/);
  });

  it("the adapter entry point and its whole dependency tree load without any of them", async () => {
    const m = await import("../../fleet/chatgpt-adapter/main.js");
    expect(typeof m.startAdapter).toBe("function");
    const core = await import("../../fleet/bridge/mcp-core.js");
    expect(core.CHATGPT_TOOL_NAMES).toEqual(["fleet_whoami", "fleet_status", "fleet_list_agents", "fleet_get_agent"]);
  });
});
