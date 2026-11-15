/**
 * Every function the controller's public pages may call (PUBLIC_PAGE_FUNCTIONS) must be granted to the service role
 * (SERVICE_API_FUNCTIONS): the pages run as that role. 2026-10-19: v89's svc_repo_requests / svc_repo_consent were added
 * to the first list only, so every live order and enquiry page answered "Temporarily unavailable".
 */
import { describe, it, expect } from "vitest";
import { PUBLIC_PAGE_FUNCTIONS } from "../../fleet/postgres/store.js";
import { SERVICE_API_FUNCTIONS } from "../../fleet/postgres/migrations.js";

describe("public page functions are granted to the service role", () => {
  it("each PUBLIC_PAGE_FUNCTIONS entry has a SERVICE_API_FUNCTIONS signature", () => {
    const granted = new Set(SERVICE_API_FUNCTIONS.map((s) => s.slice(0, s.indexOf("(")).trim()));
    expect(PUBLIC_PAGE_FUNCTIONS.filter((f) => !granted.has(f))).toEqual([]);
  });
});
