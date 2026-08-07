#!/usr/bin/env bash
# End-to-end exercise of `buzz lab` against the staging relay.
#
# Covers the four verbs plus the one behaviour the whole feature exists for:
# a stale-base write must be REJECTED, not silently applied. A run that creates
# and updates happily but does not prove the conflict case has not tested CAS
# at all.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="${SCRATCH:-/tmp/claude-1002/-home-ccdev-alis-bot/c0e167f4-8ed0-4c90-b0ef-e84b2ad55255/scratchpad}"
BUZZ="${BUZZ:-/home/ccdev/buzz/target/debug/buzz}"

# shellcheck disable=SC1091
source "$SCRATCH/staging-keys.env"
export BUZZ_RELAY_URL="${BUZZ_RELAY_URL:-http://127.0.0.1:3121}"
export BUZZ_PRIVATE_KEY="$STAGING_OWNER_PRIV"

fail() { echo "FALHOU: $*" >&2; exit 1; }

cd "$SCRATCH"
printf '# Quadro de Teste\n\nVersao um.\n'   > v1.md
printf '# Quadro de Teste\n\nVersao dois.\n' > v2.md

echo "=== 1. create ==="
$BUZZ lab create --title "Quadro de Teste" --summary "validacao" --content - < v1.md | tee create.out
BOARD=$(awk '/^board_id/{print $2}' create.out)
REV1=$(awk '/^event_id/{print $2}' create.out)
[ -n "$BOARD" ] || fail "create nao devolveu board_id"
echo "board=$BOARD rev1_event=$REV1"

echo
echo "=== 2. update (base resolvido automaticamente) ==="
$BUZZ lab update "$BOARD" --content - < v2.md | tee update.out
grep -q "^revision   2" update.out || fail "update nao chegou na revisao 2"

echo
echo "=== 3. CONFLITO DE CAS: update reusando a base JA CONSUMIDA da rev1 ==="
# Esta e a prova central: a rev1 nao e mais a cabeca, entao esta escrita tem
# que ser recusada. Se ela passar, o CAS nao esta protegendo nada.
if $BUZZ lab update "$BOARD" --base "$REV1" --content - < v1.md > conflict.out 2>&1; then
  cat conflict.out
  fail "escrita com base obsoleta foi ACEITA — o CAS nao esta protegendo nada"
fi
cat conflict.out
grep -qi "conflict\|BOARD_HEAD_MISMATCH\|nao e\|not this board" conflict.out \
  || fail "recusou, mas sem sinalizar conflito de CAS de forma reconhecivel"
echo "  -> recusado corretamente"

echo
echo "=== 4. history ==="
$BUZZ lab history "$BOARD" | tee history.out
python3 - "$BOARD" <<'PY'
import json, sys
rows = json.load(open("history.out"))
revs = [r["revision"] for r in rows]
ops  = [r["op"] for r in rows]
assert revs == [1, 2], f"esperava revisoes [1,2], veio {revs}"
assert ops == ["create", "update"], f"esperava [create,update], veio {ops}"
# A escrita conflitante NAO pode ter deixado rastro no historico.
assert len(rows) == 2, f"a escrita recusada vazou para o historico: {len(rows)} linhas"
print("  -> historico correto: 2 revisoes, conflito nao persistido")
PY

echo
echo "=== 5. restore para a revisao 1 ==="
$BUZZ lab restore "$BOARD" --revision 1 | tee restore.out
grep -q "^revision      3" restore.out || fail "restore nao criou a revisao 3"
grep -q "^restored_from 1" restore.out || fail "restore nao registrou restored_from=1"

echo
echo "=== 6. historico final (restore e uma revisao NOVA, nao reescreve o passado) ==="
$BUZZ lab history "$BOARD" > history2.out
python3 - <<'PY'
import json
rows = json.load(open("history2.out"))
revs = [r["revision"] for r in rows]
ops  = [r["op"] for r in rows]
assert revs == [1, 2, 3], f"esperava [1,2,3], veio {revs}"
assert ops == ["create", "update", "restore"], f"veio {ops}"
assert rows[2]["restored_from"] == 1, "revisao 3 deveria apontar restored_from=1"
print("  -> historico preservado e auditavel")
PY

echo
echo "TODOS OS PASSOS PASSARAM (board $BOARD)"
