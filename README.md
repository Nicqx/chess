# Chess

Böngészős sakk Stockfish ellen vagy két játékossal. Kubernetes-erőforrások: `chess-game-deployment`, `chess-game-service:8099`; publikus útvonal: `/chess/`; Redis-prefix: `chess:session`.

## Telepítés és frissítés

Előfeltétel: Docker, Git, Bash, működő k3s, Redis és ingress.

```bash
cd ~/codes/chess
git pull --ff-only
KUBECTL='sudo k3s kubectl' ./update.sh --target nuc --dry-run
KUBECTL='sudo k3s kubectl' ./update.sh --target nuc
```

A script commitazonosítós natív image-et épít/importál, alkalmazza a manifestet és megvárja a rolloutot. Manifestmentések: `~/.local/state/nicqx-apps/nuc/chess-game/`.

## Ellenőrzés

```bash
sudo k3s kubectl get pod,service -n default -l app=chess-game -o wide
sudo k3s kubectl logs deployment/chess-game-deployment -n default --tail=50
curl -fsSI https://pmqxyz.hopto.org/chess/ | head -n 1
```

## Migráció

A konténer állapotmentes. Az új gépen előbb a `redis` repo eljárásával migráld a `chess:session*` kulcsokat, utána klónozd ezt a repót és futtasd az update-et. Külön PVC nincs.

## Leállítás, rollback, eltávolítás

```bash
sudo k3s kubectl scale deployment/chess-game-deployment -n default --replicas=0
sudo k3s kubectl scale deployment/chess-game-deployment -n default --replicas=1

sudo k3s kubectl apply -f /teljes/ut/korabbi-manifest.yaml
sudo k3s kubectl rollout status deployment/chess-game-deployment -n default --timeout=180s

# Az alkalmazást törli; Redis-adatot és ingress-szabályt nem.
sudo k3s kubectl delete deployment/chess-game-deployment service/chess-game-service -n default
```

Redis-kulcsot csak ellenőrzött mentés után törölj. Az ingress-szabályt az `ingress` repo kezeli.
