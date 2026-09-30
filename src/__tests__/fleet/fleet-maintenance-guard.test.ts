/**
 * Living-founder restart protection (2026-09-28 incident: unattended-upgrade → apt DPkg::Post-Invoke → needrestart
 * restarted Founder 1's unit). The guard is a needrestart conf.d snippet; needrestart's automatic mode defers any
 * service whose override_rc entry is 0 (/usr/sbin/needrestart: "unless($restart) { push(@skipped_services…) }").
 *
 * Deterministic here: the shipped snippet is evaluated by perl exactly as needrestart loads conf.d (on top of the
 * stock override_rc), and every unit name gets needrestart's decision. The live proof with the real needrestart and
 * systemd is `sudo scripts/fleet-maintenance-guard.sh rehearse` on the controller host.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const CONF = path.resolve("deploy/needrestart/50-automaton-fleet-founders.conf");

/** needrestart's decision per unit: 0/1 from override_rc (all matching keys must agree), or "default". */
function decisions(units: string[]): Record<string, string> {
  const script = `
    our %nrconf = (restart => 'a', defno => 0, blacklist_rc => [], blacklist_mappings => [],
      override_rc => { qr(^dbus) => 0, qr(^getty\\@.+\\.service) => 0, qr(^docker) => 0 });
    my %before = %nrconf; my @beforeKeys = sort keys %{$nrconf{override_rc}};
    do $ARGV[0]; die "config error: $@" if $@;
    # The snippet may only ADD founder entries: restart mode, blacklists and stock overrides are untouched.
    die "restart mode changed" unless $nrconf{restart} eq 'a' && $nrconf{defno} == 0;
    die "blacklists changed" if @{$nrconf{blacklist_rc}} || @{$nrconf{blacklist_mappings}};
    for my $k (@beforeKeys) { die "stock override changed" unless exists $nrconf{override_rc}{$k}; }
    shift @ARGV;
    for my $u (@ARGV) {
      my @v = map { $nrconf{override_rc}{$_} } grep { $u =~ /$_/ } keys %{$nrconf{override_rc}};
      my %d = map { ($_ ? 1 : 0) => 1 } @v;
      print "$u ", (!@v ? "default" : keys(%d) > 1 ? "conflict" : (keys %d)[0]), "\\n";
    }`;
  const out = execFileSync("perl", ["-e", script, CONF, ...units], { encoding: "utf8" });
  return Object.fromEntries(out.trim().split("\n").map((l) => l.split(" ") as [string, string]));
}

describe("living-founder restart protection (needrestart guard)", () => {
  it("defers every founder unit, including the rehearsal instance, and nothing else", () => {
    const d = decisions([
      "automaton-fleet-founder@01M3F50SH7PNX2E3GST13J52AS.service",
      "automaton-fleet-founder@NRREHEARSAL.service",
      "automaton-fleet.service",
      "automaton-fleet-operator-api.service",
      "automaton-fleet-fetcher.service",
      "automaton-fleet-custody.service",
      "automaton-fleet-founder.service",
      "xautomaton-fleet-founder@X.service",
      "automaton-fleet-founder@X.service.bak",
      "fleet-nr-rehearsal-control.service",
      "unattended-upgrades.service",
      "dbus.service",
    ]);
    expect(d["automaton-fleet-founder@01M3F50SH7PNX2E3GST13J52AS.service"]).toBe("0");
    expect(d["automaton-fleet-founder@NRREHEARSAL.service"]).toBe("0");
    for (const u of ["automaton-fleet.service", "automaton-fleet-operator-api.service", "automaton-fleet-fetcher.service", "automaton-fleet-custody.service",
      "automaton-fleet-founder.service", "xautomaton-fleet-founder@X.service", "automaton-fleet-founder@X.service.bak", "fleet-nr-rehearsal-control.service", "unattended-upgrades.service"]) {
      expect([u, d[u]]).toEqual([u, "default"]);
    }
    expect(d["dbus.service"]).toBe("0"); // stock override preserved
  });

  it("the snippet is valid perl and changes only override_rc (checked inside decisions)", () => {
    expect(() => execFileSync("perl", ["-c", CONF], { stdio: "pipe" })).not.toThrow();
    expect(fs.readFileSync(CONF, "utf8")).not.toMatch(/\$nrconf\{(restart|defno|blacklist|blacklist_rc|blacklist_mappings|kernelhints|ucodehints)\}\s*=/);
  });

  it("host setup installs it, deployment verification checks it, and the rehearsal can never touch a real service", () => {
    const setup = fs.readFileSync("scripts/fleet-os-setup.sh", "utf8");
    expect(setup).toContain('"$REPO/deploy/needrestart/50-automaton-fleet-founders.conf" /etc/needrestart/conf.d/50-automaton-fleet-founders.conf');
    const verify = fs.readFileSync("scripts/fleet-verify-deployment.sh", "utf8");
    expect(verify).toContain('/fleet-maintenance-guard.sh"');
    expect(verify).toContain('"$G" check');
    const guard = fs.readFileSync("scripts/fleet-maintenance-guard.sh", "utf8");
    // Unattended security updates are verified still ON; nothing disables them.
    expect(guard).toContain("APT::Periodic::Unattended-Upgrade");
    expect(guard).not.toMatch(/systemctl (disable|mask|stop) (apt-daily|unattended)/);
    // The automatic run is confined by a rehearsal-only blacklist, verified in list mode before -r a runs.
    expect(guard).toMatch(/blacklist_rc\} = \[ qr\(\^\(\?!\(automaton-fleet-founder\\\\@NRREHEARSAL\|fleet-nr-rehearsal-control\)/);
    expect(guard.indexOf("ABORT: rehearsal candidates")).toBeLessThan(guard.indexOf("-r a -l"));
    // No restart of anything but the rehearsal units; cleanup always runs.
    expect(guard).not.toMatch(/systemctl restart/);
    expect(guard).toContain("trap cleanup EXIT");
  });
});
