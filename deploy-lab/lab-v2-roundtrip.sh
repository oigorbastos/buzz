#!/usr/bin/env bash
# Real CLI round-trip for Lab Board V2 against an isolated relay.
#
# Required environment:
#   BUZZ       path to the CLI binary
#   BUZZ_RELAY_URL
#   BUZZ_PRIVATE_KEY
#
# This script intentionally uses a fresh private board and never points at a
# shared staging or production relay by itself.
set -euo pipefail

BUZZ="${BUZZ:?set BUZZ to the CLI binary}"
: "${BUZZ_RELAY_URL:?set BUZZ_RELAY_URL to the isolated relay}"
: "${BUZZ_PRIVATE_KEY:?set BUZZ_PRIVATE_KEY to a synthetic test identity}"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/buzz-lab-v2.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

printf '# V2 board\n\nVersion one.\n' >"$scratch/v1.md"
printf '# V2 board\n\nVersion two.\n' >"$scratch/v2.md"
printf '# V2 board\n\nVersion three.\n' >"$scratch/v3.md"

create_output="$scratch/create.out"
"$BUZZ" lab create \
  --access private \
  --tag "CLI V2" \
  --tag "roundtrip" \
  --title "CLI V2 board" \
  --summary "real relay proof" \
  --content - <"$scratch/v1.md" | tee "$create_output"

board_id="$(awk '$1 == "board_id" {print $2}' "$create_output")"
base_one="$(awk '$1 == "event_id" {print $2}' "$create_output")"
[[ "$board_id" =~ ^[0-9a-f-]{36}$ ]] || { echo "invalid board id" >&2; exit 1; }
[[ "$base_one" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid create event id" >&2; exit 1; }

"$BUZZ" lab get "$board_id" >"$scratch/get-one.out"
grep -q '^access     private$' "$scratch/get-one.out"
grep -q '^tags       cli-v2,roundtrip$' "$scratch/get-one.out"

"$BUZZ" lab update "$board_id" \
  --base "$base_one" \
  --tag "CLI V2 updated" \
  --content - <"$scratch/v2.md" | tee "$scratch/update.out"
base_two="$(awk '$1 == "event_id" {print $2}' "$scratch/update.out")"
grep -q '^revision   2$' "$scratch/update.out"

"$BUZZ" lab get "$board_id" >"$scratch/get-two.out"
grep -q '^tags       cli-v2-updated$' "$scratch/get-two.out"

# Omitting --tag is the compatibility-preserving form: the legacy update wire
# op may change Markdown without replacing the current tag set.
"$BUZZ" lab update "$board_id" \
  --base "$base_two" \
  --content - <"$scratch/v3.md" | tee "$scratch/update-three.out"
grep -q '^revision   3$' "$scratch/update-three.out"
"$BUZZ" lab get "$board_id" >"$scratch/get-three.out"
grep -q '^tags       cli-v2-updated$' "$scratch/get-three.out"

if "$BUZZ" lab update "$board_id" --base "$base_one" --content - <"$scratch/v1.md" >"$scratch/stale.out" 2>&1; then
  cat "$scratch/stale.out" >&2
  echo "stale CLI base was accepted" >&2
  exit 1
fi
grep -Eiq 'conflict|mismatch|not this board|not match' "$scratch/stale.out"

"$BUZZ" lab history "$board_id" >"$scratch/history.json"
python3 - "$scratch/history.json" <<'PY'
import json
import sys

rows = json.load(open(sys.argv[1], encoding="utf-8"))
assert [row["revision"] for row in rows] == [1, 2, 3], rows
assert [row["op"] for row in rows] == ["create_v2", "update_v2", "update"], rows
print("CLI V2 round-trip passed: private metadata, tag replacement/preservation, CAS, history")
PY
