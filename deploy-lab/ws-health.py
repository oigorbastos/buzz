#!/usr/bin/env python3
"""Acceptance check for a relay deploy: are real clients SUSTAINING connections?

Why this exists: on 04/ago a relay build passed every easy check — container
healthy, migrations green, `buzz_ws_connections_active` reporting 9 — while
every client was actually stuck in a reconnect loop (established -> NIP-42 auth
successful -> closed, ~1s, forever). The gauge lied because it counted sockets
in flight, not sockets that survived. The only signal that told the truth was
the log pattern per pubkey.

Healthy (measured on prod, 45min window, 07/ago): 4 established, 4 auths,
4 distinct pubkeys, 1 auth each, 0 closes.
Broken: the same few pubkeys re-authenticating over and over, with a close
following each auth — so auths/pubkey climbs well above 1 and closes ~= auths.

Reads `docker logs` JSON on stdin. Exits 0 if the window looks healthy, 1 if it
looks like the reconnect loop, 2 if there is not enough traffic to judge.
"""
import sys
import json
import collections

AUTH = "NIP-42 auth successful"
ESTABLISHED = "WebSocket connection established"
CLOSED = "WebSocket connection closed"

auth_by_pubkey = collections.Counter()
established = 0
closed = 0

for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        continue
    message = entry.get("message", "")
    if message == AUTH:
        auth_by_pubkey[entry.get("pubkey", "?")] += 1
    elif message == ESTABLISHED:
        established += 1
    elif message == CLOSED:
        closed += 1

total_auths = sum(auth_by_pubkey.values())
distinct = len(auth_by_pubkey)

print(f"  conexoes estabelecidas : {established}")
print(f"  auths totais           : {total_auths}")
print(f"  pubkeys distintos      : {distinct}")
print(f"  conexoes fechadas      : {closed}")
for pubkey, count in auth_by_pubkey.most_common():
    print(f"      {pubkey[:12]} -> {count} auth(s)")

if distinct == 0:
    print("\nVEREDITO: INCONCLUSIVO — nenhum cliente autenticou na janela.")
    print("Um relay sem cliente nenhum nao prova nada; espere mais ou reconecte um agente.")
    sys.exit(2)

auths_per_pubkey = total_auths / distinct
print(f"\n  auths por pubkey       : {auths_per_pubkey:.1f}  (saudavel ~1.0)")

# Two independent symptoms of the loop; either one condemns the build.
churning = auths_per_pubkey >= 3.0
closing = closed >= max(3, total_auths * 0.5)

if churning or closing:
    print("VEREDITO: RUIM — padrao de loop de reconexao (o modo de falha de 04/ago).")
    if churning:
        print(f"  - os mesmos pubkeys reautenticaram {auths_per_pubkey:.1f}x na janela")
    if closing:
        print(f"  - {closed} fechamentos para {total_auths} auths")
    print("  ACAO: rollback (rollback-0029.sql + voltar BUZZ_IMAGE).")
    sys.exit(1)

print("VEREDITO: BOM — clientes autenticaram e sustentaram a conexao.")
sys.exit(0)
