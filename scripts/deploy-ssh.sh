#!/usr/bin/env bash
# Build the image locally and ship it to a Docker host over SSH, then
# `docker compose up -d` there. No registry needed (useful for home labs).
#
#   DEPLOY_HOST=myserver DEPLOY_DIR=/opt/stacks/paper-perp ./scripts/deploy-ssh.sh
#
# The remote directory must contain compose.yaml and .env (see deploy/single-host).
# Set PLATFORM=linux/amd64 for x86 hosts.
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST (ssh alias)}"
: "${DEPLOY_DIR:?set DEPLOY_DIR (remote compose directory)}"
PLATFORM="${PLATFORM:-linux/arm64}"
TAG="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain)" ] || TAG="$TAG-dirty"
IMAGE="paperperp:$TAG"

echo "==> building $IMAGE for $PLATFORM"
docker buildx build --platform "$PLATFORM" --build-arg RELEASE="$TAG" \
  --build-arg VITE_CHAIN_ID="${VITE_CHAIN_ID:-421614}" -t "$IMAGE" --load .

echo "==> shipping image to $DEPLOY_HOST"
docker save "$IMAGE" | gzip -1 | ssh "$DEPLOY_HOST" "gunzip | docker load"

echo "==> rolling out"
ssh "$DEPLOY_HOST" "sh -c 'cd $DEPLOY_DIR && sed -i \"s/^IMAGE_TAG=.*/IMAGE_TAG=$TAG/\" .env && sed -i \"/^IMAGE_REPO=/d\" .env && docker compose up -d && sleep 5 && docker compose ps'"

echo "==> previous tags stay on the host; roll back by setting IMAGE_TAG in $DEPLOY_DIR/.env and running docker compose up -d"
