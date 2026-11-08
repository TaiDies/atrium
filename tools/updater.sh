#!/bin/sh
# Atrium's updater (runs in its own small container, see docker-compose.yml).
#
# The app can't rebuild itself, so it leaves a request in the shared data folder (update/request.json)
# when someone clicks "Update now" in the admin panel, or when auto-update finds a new version. This
# checks out that release's tag (vX.Y.Z) in the project folder, rebuilds and restarts the app, and
# writes how it went to update/status.json. It only runs when started with --profile updater. Every few seconds it also says it's alive (update/updater.json) and
# whether this folder can be updated (a git clone of UPDATE_REPO).

set -u
D=/data/update
mkdir -p "$D"
apk add --no-cache git >/dev/null 2>&1 || true
git config --global --add safe.directory /project

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
status() {
  msg=$(printf '%s' "$2" | tr '\n"\\' "  /")
  printf '{"state":"%s","message":"%s","at":"%s"}' "$1" "$msg" "$(now)" > "$D/status.json"
}

while true; do
  remote=$(git -C /project remote get-url origin 2>/dev/null || true)
  case "$remote" in
    *"$UPDATE_REPO"*) ok=true ;;
    *) ok=false ;;
  esac
  printf '{"at":"%s","canUpdate":%s,"remote":"%s"}' "$(now)" "$ok" "$remote" > "$D/updater.json"

  if [ -f "$D/request.json" ]; then
    # The release asked for, e.g. {"version":"1.8.1"}: only that tag is installed, never the main branch.
    version=$(sed -n 's/.*"version":"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$D/request.json")
    rm -f "$D/request.json"
    if [ "$ok" != true ]; then
      status failed "This folder isn't a git clone of github.com/$UPDATE_REPO"
    elif [ -z "$version" ]; then
      status failed "No release version was given"
    else
      status updating "Downloading version $version"
      if git -C /project fetch --tags --force origin > "$D/log.txt" 2>&1 && git -C /project -c advice.detachedHead=false checkout --force "refs/tags/v$version" >> "$D/log.txt" 2>&1; then
        status updating "Rebuilding and restarting the app (a few minutes)"
        if docker compose --project-directory /project -f /project/docker-compose.yml up -d --build --no-deps app >> "$D/log.txt" 2>&1; then
          status done "Updated to $(git -C /project describe --tags --always 2>/dev/null)"
        else
          status failed "Rebuilding failed: $(tail -n 3 "$D/log.txt")"
        fi
      else
        status failed "Downloading failed: $(tail -n 3 "$D/log.txt")"
      fi
    fi
  fi
  sleep 10
done
