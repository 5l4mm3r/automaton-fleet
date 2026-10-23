#!/usr/bin/env bash
# The LOCAL inference stack (owner directive 2026-10-23): llama.cpp llama-server + a pinned open-weight model, on THIS
# machine, as its own locked-down service (deploy/systemd/automaton-fleet-inference.service: loopback only, no egress).
#
#   sudo scripts/fleet-local-inference-setup.sh <gpu16|cpu-diagnostic>            # DRY RUN: checks and prints, changes nothing
#   sudo scripts/fleet-local-inference-setup.sh <gpu16|cpu-diagnostic> --apply    # installs (idempotent)
#
# Every file comes from local-machine/inference.lock.json: downloaded once, verified against its sha256 (a mismatch stops
# everything), installed read-only. Nothing is re-downloaded in operation. No credential is created or read here.
# Afterwards point the controller at it: scripts/fleet-local-cognition.sh (service.env + registry tiers).
set -euo pipefail
PROFILE=${1:?profile: gpu16 or cpu-diagnostic}; APPLY=${2:-}
REPO=$(cd "$(dirname "$0")/.." && pwd); LOCK="$REPO/local-machine/inference.lock.json"
DEST=/opt/automaton-fleet/inference; ENVF=/etc/automaton-fleet/inference.env; UNIT=/etc/systemd/system/automaton-fleet-inference.service
CACHE=${FLEET_INFERENCE_DOWNLOADS:-/var/cache/automaton-fleet-inference}
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
# WSL2: the Windows NVIDIA driver provides nvidia-smi and libcuda in /usr/lib/wsl/lib, which sudo's PATH leaves out.
[[ -d /usr/lib/wsl/lib ]] && PATH="$PATH:/usr/lib/wsl/lib"
[[ -f "$LOCK" ]] || { echo "missing $LOCK" >&2; exit 2; }
J() { python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); p=d['profiles'][sys.argv[2]]; e=d['engine']['assets'][p['engine']]; exec(sys.argv[3])" "$LOCK" "$PROFILE" "$1"; }
J "pass" || { echo "unknown profile $PROFILE" >&2; exit 2; }
run() { if [[ "$APPLY" == --apply ]]; then echo "+ $*"; "$@"; else echo "(dry) $*"; fi; }

echo "== prerequisites ($PROFILE)"
read -r NEED_VRAM NEED_RAM NEED_DISK < <(J "r=p['requirements']; print(r['vramGiB'], r['ramGiB'], r['diskGiB'])")
RAM=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo); echo "  RAM ${RAM} GiB (need ${NEED_RAM})"
grep -q avx2 /proc/cpuinfo || { echo "  CPU lacks AVX2: unsupported" >&2; exit 1; }
DISK=$(df -BG --output=avail /opt 2>/dev/null | tail -1 | tr -dc 0-9); echo "  free disk on /opt ${DISK} GiB (need ${NEED_DISK})"
(( DISK >= NEED_DISK )) || { echo "  not enough disk" >&2; exit 1; }
(( RAM + 1 >= NEED_RAM )) || echo "  WARNING: less RAM than the profile states — expect swapping or a failed load"
if (( NEED_VRAM > 0 )); then
  command -v nvidia-smi >/dev/null || { echo "  no NVIDIA driver (nvidia-smi) — install the driver (>= $(J "print(p['requirements']['driverMin'])")) first, or use cpu-diagnostic" >&2; exit 1; }
  GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  VRAM=$(( $(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1 | tr -dc 0-9) / 1024 ))
  DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
  echo "  GPU ${GPU}, ${VRAM} GiB VRAM, driver ${DRV} (need ${NEED_VRAM} GiB)"
  (( VRAM >= NEED_VRAM )) || { echo "  not enough VRAM for $PROFILE" >&2; exit 1; }
fi

echo "== files (pinned, verified)"
run install -d -m 755 "$CACHE"
mapfile -t FILES < <(J "
for a in e: print(a['file'], a['sha256'], a['url'], 'engine')
for k in ('model','mmproj'): print(p[k]['file'], p[k]['sha256'], p[k]['url'], k)")
for line in "${FILES[@]}"; do
  read -r f sha url kind <<<"$line"
  if [[ -f "$CACHE/$f" ]] && echo "$sha  $CACHE/$f" | sha256sum -c --quiet 2>/dev/null; then echo "  $f: present, verified"; continue; fi
  run curl -fL --retry 3 -o "$CACHE/$f.part" "$url"
  if [[ "$APPLY" == --apply ]]; then
    echo "$sha  $CACHE/$f.part" | sha256sum -c --quiet || { echo "  CHECKSUM MISMATCH for $f — removed; nothing installed" >&2; rm -f "$CACHE/$f.part"; exit 1; }
    mv "$CACHE/$f.part" "$CACHE/$f"; echo "  $f: downloaded, verified"
  fi
done

echo "== install"
id -u automaton-fleet-inference >/dev/null 2>&1 || run useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin automaton-fleet-inference
if (( NEED_VRAM > 0 )) && getent group video >/dev/null; then run usermod -aG video automaton-fleet-inference; fi
run install -d -m 755 -o root -g root "$DEST" "$DEST/bin" "$DEST/models"
if [[ "$APPLY" == --apply ]]; then
  T=$(mktemp -d); for line in "${FILES[@]}"; do read -r f _ _ kind <<<"$line"; [[ $kind == engine ]] && tar -xzf "$CACHE/$f" -C "$T"; done
  # The archives unpack into a llama-b<build>/ directory: its binaries and shared libraries go to bin/.
  # The libraries' versioned names (libllama.so.0 -> libllama.so.0.7.0) are symlinks: copy them too, as links.
  find "$T" -maxdepth 2 \( -type f -o -type l \) \( -name 'llama-server' -o -name '*.so*' \) -exec cp -a {} "$DEST/bin/" \;
  rm -rf "$T"
  for line in "${FILES[@]}"; do read -r f _ _ kind <<<"$line"; [[ $kind != engine ]] && install -m 444 -o root -g root "$CACHE/$f" "$DEST/models/$f"; done
  chmod 755 "$DEST/bin/llama-server"; chown -R root:root "$DEST"
  "$DEST/bin/llama-server" --version 2>&1 | tail -2 | sed 's/^/  /'
fi
read -r ALIAS MODEL MMPROJ CTX NGL < <(J "s=p['server']; print(p['alias'], p['model']['file'], p['mmproj']['file'], s['ctx'], s['gpuLayers'])")
ENV_CONTENT="# written by fleet-local-inference-setup.sh ($PROFILE) — no secret here
FLEET_INFERENCE_PROFILE_NAME=$PROFILE
FLEET_INFERENCE_ALIAS=$ALIAS
FLEET_INFERENCE_MODEL=$DEST/models/$MODEL
FLEET_INFERENCE_MMPROJ=$DEST/models/$MMPROJ
FLEET_INFERENCE_CTX=$CTX
FLEET_INFERENCE_GPU_LAYERS=$NGL
FLEET_INFERENCE_EXTRA="
if [[ "$APPLY" == --apply ]]; then
  install -d -m 755 /etc/automaton-fleet; printf '%s\n' "$ENV_CONTENT" > "$ENVF"; chmod 644 "$ENVF"
  install -m 644 "$REPO/deploy/systemd/automaton-fleet-inference.service" "$UNIT"
  systemctl daemon-reload; systemctl enable --now automaton-fleet-inference.service
  for i in $(seq 1 120); do curl -sf -m 3 http://127.0.0.1:8090/v1/models >/dev/null && break; sleep 2; done
  curl -sf -m 5 http://127.0.0.1:8090/v1/models | python3 -I -c "import json,sys; d=json.load(sys.stdin); print('  serving:', [m['id'] for m in d.get('data', [])])" \
    || { echo "  the model server did not come up: journalctl -u automaton-fleet-inference" >&2; exit 1; }
  ss -ltnp | grep -E ':8090\b' | sed 's/^/  /'
else
  echo "(dry) write $ENVF:"; printf '%s\n' "$ENV_CONTENT" | sed 's/^/      /'; echo "(dry) install $UNIT; systemctl enable --now automaton-fleet-inference"
fi
echo "== done ($PROFILE). Next: sudo scripts/fleet-local-cognition.sh $ALIAS [--apply]"
