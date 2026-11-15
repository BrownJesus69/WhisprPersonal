#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  echo 'Docker is not running. Start Docker and re-run start.sh.' >&2
  exit 1
fi
if [[ ! -e .env ]]; then
  cp .env.example .env
  if command -v python3 >/dev/null; then
    generated_secret=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')
  else
    generated_secret=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
  fi
  sed -i.bak "s|^SERVER_SHARED_SECRET=.*|SERVER_SHARED_SECRET=$generated_secret|" .env
  rm -f -- .env.bak
  shopt -s nullglob
  credential_files=(../secrets/*.json)
  shopt -u nullglob
  if [[ ${#credential_files[@]} -eq 1 && -f "${credential_files[0]}" ]]; then
    credential_name=${credential_files[0]##*/}
    if [[ $credential_name =~ ^[A-Za-z0-9_.-]+\.json$ ]]; then
      sed -i.bak "s|^FIREBASE_CREDENTIALS_PATH=.*|FIREBASE_CREDENTIALS_PATH=/run/secrets/whisprpersonal/$credential_name|" .env
      rm -f -- .env.bak
    fi
  fi
  chmod 600 .env
  echo "Server key: $generated_secret"
  echo "Enter this in the app's Settings; it is NOT in the QR code. Store it privately."
  unset generated_secret
fi
mkdir -p models data
compose_files=(-f docker-compose.yml)
if command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1 &&
   docker info 2>/dev/null | grep -qi nvidia; then
  compose_files+=(-f docker-compose.gpu.yml)
fi
docker compose "${compose_files[@]}" up -d --build
port=${WHISPRPERSONAL_PORT:-}
if [[ -z $port ]]; then
  # Read only the numeric Compose port; never source a dotenv file as shell code.
  port=$(sed -n 's/^WHISPRPERSONAL_PORT=\([0-9][0-9]*\)[[:space:]]*$/\1/p' .env | tail -n 1)
  port=${port:-8000}
fi
health_ready=false
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  if curl --fail --silent --max-time 3 "http://127.0.0.1:$port/health" >/dev/null; then
    health_ready=true
    break
  fi
  sleep 2
done
if [[ $health_ready != true ]]; then
  echo 'Health check timed out. Recent server logs:' >&2
  docker compose "${compose_files[@]}" logs --tail 50 server
  exit 1
fi
deadline=$((SECONDS + 1200))
model_ready=false
while (( SECONDS < deadline )); do
  model_state=$(docker compose "${compose_files[@]}" exec -T server python -c \
    'import json,urllib.request; m=json.load(urllib.request.urlopen("http://127.0.0.1:8000/health",timeout=3))["model"]; print(m["status"]); print(m.get("error") or "")' || true)
  case "$model_state" in
    ready*) model_ready=true; break ;;
    error*) echo "Model error: $model_state" >&2
      docker compose "${compose_files[@]}" logs --tail 50 server; exit 1 ;;
  esac
  echo 'Model loading...'
  sleep 10
done
if [[ $model_ready != true ]]; then
  echo 'Model readiness timed out.' >&2
  docker compose "${compose_files[@]}" logs --tail 50 server
  exit 1
fi
docker compose "${compose_files[@]}" exec -T server python -m app.cli selftest
lan_ips=''
if [[ $(uname -s) == Darwin ]]; then
  lan_ips=$(ipconfig getifaddr en0 || true)
else
  lan_ips=$(hostname -I || true)
fi
lan_url=''
for ip in $lan_ips; do
  case "$ip" in
    127.*|169.254.*|100.*|*:* ) continue ;;
  esac
  echo "LAN URL: http://$ip:$port"
  if [[ -z $lan_url ]]; then lan_url="http://$ip:$port"; fi
done
if [[ -n $lan_url ]]; then
  docker compose "${compose_files[@]}" exec -T server python -m app.cli qr "$lan_url"
fi
if command -v tailscale >/dev/null; then
  tailscale_ip=$(tailscale ip -4 2>/dev/null || true)
  if [[ -n $tailscale_ip ]]; then echo "Tailscale URL: http://$tailscale_ip:$port"; fi
fi
docker compose "${compose_files[@]}" exec -T server python -c \
  'import json,urllib.request; h=json.load(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5)); print("Model: "+h["model"]["status"]+"; queue: "+h["queue"]["status"])'
if command -v xdg-open >/dev/null; then
  xdg-open "http://localhost:$port/docs" >/dev/null 2>&1 || true
elif command -v open >/dev/null; then
  open "http://localhost:$port/docs" || true
fi
