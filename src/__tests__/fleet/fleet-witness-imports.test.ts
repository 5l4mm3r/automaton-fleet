/**
 * Fleet security (FLEET-KI-4): loading the root witness initialises no wallet,
 * inference, agent-loop or replication code. Each such module is replaced by
 * a mock that throws when it is loaded; importing the witness must still
 * succeed. A control proves the mocks are live. (Static import-graph checks
 * are in fleet-witness.test.ts; this file is separate because vi.mock is
 * file-scoped.)
 */

import { describe, it, expect, vi } from "vitest";

// Factories are hoisted, so each throws inline (vitest reports it as a mocking error).
vi.mock("../../identity/wallet.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: identity/wallet");
});
vi.mock("../../identity/provision.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: identity/provision");
});
vi.mock("../../conway/inference.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: conway/inference");
});
vi.mock("../../conway/client.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: conway/client");
});
vi.mock("../../conway/x402.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: conway/x402");
});
vi.mock("../../inference/inference-client.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: inference/inference-client");
});
vi.mock("../../inference/router.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: inference/router");
});
vi.mock("../../ollama/discover.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: ollama/discover");
});
vi.mock("../../agent/loop.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: agent/loop");
});
vi.mock("../../agent/tools.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: agent/tools");
});
vi.mock("../../replication/spawn.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: replication/spawn");
});
vi.mock("../../fleet/treasury/store.js", () => {
  throw new Error("FORBIDDEN MODULE LOADED: fleet/treasury/store");
});

describe("Fleet security: root witness loads no wallet, inference or replication module", () => {
  it("control: a mocked forbidden module refuses to load", async () => {
    await expect(import("../../conway/inference.js")).rejects.toThrow(/FORBIDDEN MODULE LOADED|error when mocking a module/);
    await expect(import("../../identity/wallet.js")).rejects.toThrow(/FORBIDDEN MODULE LOADED|error when mocking a module/);
  });

  it("the witness module and its whole dependency tree load without any of them", async () => {
    const m = await import("../../fleet/dry-run/root-witness.js");
    expect(typeof m.runRootWitness).toBe("function");
    expect(typeof m.rootWitnessPreflight).toBe("function");
  });
});
