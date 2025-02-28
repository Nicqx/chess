# chess
rm chess-game.tar
docker build --no-cache -t chess-game:latest .
docker save chess-game:latest -o chess-game.tar
sudo k3s ctr image import chess-game.tar
kubectl apply -f chess-game-deployment.yaml
kubectl rollout restart deployment/chess-game-deployment
