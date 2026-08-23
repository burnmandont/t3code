#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
status=0
"$script_directory/pull-backups.sh" || status=$?
"$script_directory/prune-backups.sh"
"$script_directory/validate-backup-set.sh" || status=$?
exit "$status"
