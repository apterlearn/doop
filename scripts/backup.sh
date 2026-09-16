#!/usr/bin/env bash
#
# doop backup - dump whichever store this deployment uses.
#
# Same switch server/db/index.ts makes at boot:
#   DATABASE_URL set   -> real Postgres: pg_dump, custom format, restorable with
#                         `pg_restore --clean --dbname "$DATABASE_URL" <file>`.
#   DATABASE_URL unset -> embedded PGlite cluster, tarred whole.
#
# No scheduler and no retention/pruning: doop ships neither, so scheduling these
# runs (cron, systemd timer) and rotating the files is the operator's job. Every
# run writes a new timestamped file and never deletes an old one.
#
# Usage: scripts/backup.sh [output-dir]     (default: <repo>/backups)

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [output-dir]" >&2
  echo "  Dumps the Postgres in \$DATABASE_URL, or the embedded PGlite cluster" >&2
  echo "  at <repo>/data/pg when \$DATABASE_URL is unset. Default output dir: <repo>/backups" >&2
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

if [ "$#" -gt 1 ]; then
  usage
  exit 2
fi

# Resolved from this script's own location, not the cwd, so a cron entry or a
# `bash /path/to/scripts/backup.sh` invocation works from anywhere.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${1:-$repo_root/backups}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

if [ -n "${DATABASE_URL:-}" ]; then
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "backup: \$DATABASE_URL is set but pg_dump is not installed (Debian/Ubuntu: postgresql-client)" >&2
    exit 1
  fi
  file="$out_dir/doop-$stamp.dump"
else
  # server/db/index.ts resolves the embedded cluster from the process cwd
  # (`path.join(process.cwd(), 'data', 'pg')`) - there is no data-dir env var -
  # and every documented deployment starts the server from the repo root, which
  # is what `repo_root` is here.
  data_dir="$repo_root/data"
  cluster="$data_dir/pg"
  if ! command -v tar >/dev/null 2>&1; then
    echo "backup: tar is not installed, cannot archive $cluster" >&2
    exit 1
  fi
  if [ ! -d "$cluster" ]; then
    echo "backup: no embedded cluster at $cluster - nothing to archive (is this deployment using \$DATABASE_URL?)" >&2
    exit 1
  fi
  file="$out_dir/doop-$stamp.tar.gz"
fi

mkdir -p -- "$out_dir"

if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump "$DATABASE_URL" --format=custom --file="$file"
else
  tar -czf "$file" -C "$data_dir" pg
fi

if [ ! -s "$file" ]; then
  echo "backup: $file is missing or empty" >&2
  exit 1
fi

echo "$file"
