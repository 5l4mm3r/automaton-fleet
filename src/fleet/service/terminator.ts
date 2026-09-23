/**
 * Sandbox termination (Phase 4)
 *
 * When an agent dies with a known sandbox, the registry enqueues a
 * termination (fleet_sandbox_terminations) and the fleet service works the
 * queue through a SandboxTerminator. Only the controller terminates
 * sandboxes; agents cannot.
 *
 * The Conway API currently offers no way to stop or delete a sandbox
 * (ConwayClient.deleteSandbox is a no-op upstream), so the default
 * terminator reports "unsupported" and the termination stays recorded as an
 * unresolved zombie. `pnpm fleet:doctor` treats that as a blocker for real
 * replication rather than pretending the sandbox is gone.
 */

export type TerminationOutcome = { status: "terminated" } | { status: "unsupported"; reason: string };

export interface SandboxTerminator {
  readonly name: string;
  /** Whether this terminator can actually stop sandboxes (doctor/readiness). */
  readonly guaranteed: boolean;
  terminate(sandboxId: string): Promise<TerminationOutcome>;
}

export const CONWAY_TERMINATION_UNSUPPORTED =
  "Conway API has no sandbox stop/delete endpoint (deleteSandbox is a no-op); the sandbox may still be running.";

export class UnsupportedSandboxTerminator implements SandboxTerminator {
  readonly name = "unsupported";
  readonly guaranteed = false;
  async terminate(): Promise<TerminationOutcome> {
    return { status: "unsupported", reason: CONWAY_TERMINATION_UNSUPPORTED };
  }
}
