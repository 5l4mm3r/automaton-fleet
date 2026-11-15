#!/usr/bin/env bash
# v87 — the office renderer (LibreOffice, headless) and OCR (Tesseract) for the agents' deliverable checks: rendering
# Word / Excel / PowerPoint files to images (inspector fleet-qa-2 render_office) and reading scanned pages (ocr_pages).
# The exec sandbox already reads and executes /usr (Landlock), so installing the OS packages is the whole connection; agents
# see it in `capabilities op check` (renderer / OCR "installed").
#
#   sudo scripts/fleet-office-tools-setup.sh check            read-only: installed or not, versions, a real conversion test
#   sudo scripts/fleet-office-tools-setup.sh install          print the plan (nothing changes)
#   sudo scripts/fleet-office-tools-setup.sh install --apply  apt-get install --no-install-recommends the packages below, then check
#
# An OS package install is an owner-approved host change (CLAUDE.md). Nothing here touches the Fleet's services or data.
# Undo: apt-get remove <the same packages>.
set -euo pipefail
MODE="${1:?usage: check | install [--apply]}"; shift || true
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 2; }
PKGS=(libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-dejavu-core fonts-liberation2 tesseract-ocr tesseract-ocr-eng)

check() {
  local bad=0 tmp
  for b in soffice tesseract; do
    if command -v "$b" >/dev/null; then printf '  %-10s %s\n' "$b" "$("$b" --version 2>&1 | head -1)"; else printf '  %-10s MISSING\n' "$b"; bad=1; fi
  done
  (( bad )) && return 1
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  printf 'Fleet office renderer check\n' > "$tmp/probe.txt"
  if HOME="$tmp" timeout 120 soffice --headless --norestore --convert-to pdf --outdir "$tmp" "$tmp/probe.txt" >/dev/null 2>&1 && [[ -s "$tmp/probe.pdf" ]]; then
    echo "  conversion: a text file rendered to PDF (headless, no profile outside $tmp)"
  else echo "  conversion: FAILED"; return 1; fi
  tesseract --list-langs 2>/dev/null | grep -qx eng && echo "  OCR: English language data present" || { echo "  OCR: English language data MISSING"; return 1; }
}

if [[ "$MODE" == check ]]; then check; exit $?; fi
[[ "$MODE" == install ]] || { echo "unknown mode $MODE" >&2; exit 2; }
echo "# packages: ${PKGS[*]}"
if (( ! APPLY )); then echo "(plan only — nothing changes without --apply)"; echo "  apt-get update && apt-get install -y --no-install-recommends ${PKGS[*]}"; exit 0; fi
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${PKGS[@]}"
check
