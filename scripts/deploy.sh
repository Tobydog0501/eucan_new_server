#!/usr/bin/env bash
# Production deploy, run by .github/workflows/deploy.yml on the self-hosted
# runner that lives on the production host. Can also be run by hand:
#
#   DEPLOY_DIR=/srv/eucan_new_server DEPLOY_SHA=<commit> scripts/deploy.sh
#
# Steps: fast-forward the production checkout to DEPLOY_SHA, back up the
# database, build the images (old containers keep serving meanwhile), recreate
# the containers, and wait for the backend to answer. If anything after the
# checkout fails, the checkout goes back to the previous commit and that is
# rebuilt and started again. Migrations only ever add (README, "資料庫
# migration"), so the previous code still runs on the migrated database.
set -euo pipefail

: "${DEPLOY_DIR:?DEPLOY_DIR must point at the production checkout}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
BACKUP_KEEP="${BACKUP_KEEP:-30}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

log() { printf '[deploy %s] %s\n' "$(date '+%F %T')" "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; exit 1; }

cd "$DEPLOY_DIR"
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# --- Preconditions -----------------------------------------------------------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$DEPLOY_DIR is not a git checkout"
[ -f backend/.env ] || fail "backend/.env is missing (it is mounted into the backend container)"

branch="$(git symbolic-ref --short -q HEAD || true)"
[ "$branch" = "$DEPLOY_BRANCH" ] || fail "production checkout is on '${branch:-detached HEAD}', expected '$DEPLOY_BRANCH'"

# Never overwrite edits made directly on the server; they have to be committed
# (or dropped) by a person first.
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short --untracked-files=no >&2
  fail "production checkout has uncommitted changes to tracked files (listed above)"
fi

git fetch --quiet origin "$DEPLOY_BRANCH"
target="${DEPLOY_SHA:-$(git rev-parse "origin/$DEPLOY_BRANCH")}"
target="$(git rev-parse --verify "${target}^{commit}")"
git merge-base --is-ancestor "$target" "origin/$DEPLOY_BRANCH" \
  || fail "$target is not on origin/$DEPLOY_BRANCH"

prev="$(git rev-parse HEAD)"
if [ "$prev" != "$target" ] && git merge-base --is-ancestor "$target" "$prev"; then
  log "checkout is already past $target (at $prev); nothing to do"
  exit 0
fi

# --- Health check ------------------------------------------------------------
backend_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if compose exec -T backend node -e \
        "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
        >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

all_running() {
  local svc
  for svc in $(compose config --services); do
    compose ps --status running --services | grep -qx "$svc" || { log "service '$svc' is not running"; return 1; }
  done
}

start_current() {
  compose build &&
    compose up -d --force-recreate --remove-orphans &&
    backend_healthy && all_running
}

# --- Database backup ---------------------------------------------------------
backup_db() {
  local db=backend/databases/loginDatabase.db
  local dir=backend/databases/backups
  local name
  name="loginDatabase-$(date '+%Y%m%d-%H%M%S')-${prev:0:7}.db"
  if [ ! -f "$db" ]; then
    log "no database at $db yet; skipping backup"
    return 0
  fi
  if compose ps --status running --services | grep -qx backend; then
    # Online backup through SQLite itself: consistent even while the backend
    # is writing (a plain copy could miss the -wal file's contents). Done in
    # the container, which owns the data directory, and so is the pruning
    # down to the newest BACKUP_KEEP backups.
    compose exec -T backend node -e "
      const fs = require('fs');
      const Database = require('better-sqlite3');
      const dir = 'databases/backups';
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const db = new Database('databases/loginDatabase.db', { readonly: true, fileMustExist: true });
      db.backup(dir + '/$name').then(() => {
        db.close();
        fs.readdirSync(dir).filter(f => /^loginDatabase-.*\.db$/.test(f)).sort().reverse()
          .slice($BACKUP_KEEP).forEach(f => fs.rmSync(dir + '/' + f, { force: true }));
      }, e => { console.error(e); process.exit(1); });
    "
  else
    mkdir -p "$dir"
    cp -p "$db" "$dir/$name"
    for ext in -wal -shm; do
      if [ -f "$db$ext" ]; then cp -p "$db$ext" "$dir/$name$ext"; fi
    done
  fi
  log "database backed up to $dir/$name"
}

rollback() {
  log "deploy of $target failed; rolling back to $prev"
  git reset --quiet --keep "$prev"
  if start_current; then
    log "rolled back to $prev and it is healthy"
  else
    compose ps >&2 || true
    compose logs --tail=100 backend >&2 || true
    printf '::error::ROLLBACK ALSO FAILED - production needs a person now\n' >&2
  fi
  exit 1
}

# --- Deploy ------------------------------------------------------------------
log "deploying $target (currently at $prev)"
backup_db

git merge --quiet --ff-only "$target" || fail "cannot fast-forward $prev to $target"

trap rollback ERR
# Build first: the running containers keep serving while images build, and a
# failed build leaves them untouched (the rollback rebuild is then cached).
compose build
compose up -d --force-recreate --remove-orphans
if ! backend_healthy || ! all_running; then
  compose ps >&2 || true
  compose logs --tail=100 backend >&2 || true
  false
fi
trap - ERR

log "deployed $target; backend is answering"
compose ps
docker image prune -f >/dev/null || true
