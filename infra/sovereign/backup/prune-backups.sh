#!/usr/bin/env bash
set -euo pipefail

config_file=${SOVEREIGN_BACKUP_DESTINATION_CONFIG:-/etc/sovereign-backup/destination.env}
sources_file=${SOVEREIGN_BACKUP_SOURCES_FILE:-/etc/sovereign-backup/sources.tsv}
# shellcheck source=/dev/null
source "$config_file"
backup_root=${SOVEREIGN_BACKUP_ROOT:-/var/lib/sovereign-backups}
now=$(date -u +%s)

while IFS=$'\t' read -r source_id _; do
  if [[ -z $source_id ]] || [[ ${source_id:0:1} == '#' ]]; then
    continue
  fi
  if [[ ! $source_id =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
    printf 'Invalid backup source identifier: %s\n' "$source_id" >&2
    exit 1
  fi
  source_directory=$backup_root/$source_id
  [[ -d $source_directory ]] || continue

  declare -A keep=() day_seen=() week_seen=() month_seen=()
  daily_count=0
  weekly_count=0
  monthly_count=0
  mapfile -t files < <(find "$source_directory" -maxdepth 1 -type f \
    -name "$source_id-????????T??????Z.cms" -printf '%f\n' | sort -r)

  for basename in "${files[@]}"; do
    stamp=${basename#"$source_id-"}
    stamp=${stamp%.cms}
    if ! epoch=$(date -u -d "${stamp:0:8} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2} UTC" +%s 2>/dev/null); then
      printf 'Skipping unparseable backup name: %s\n' "$basename" >&2
      continue
    fi
    age=$((now - epoch))
    ((age < 0)) && age=0
    day_key=${stamp:0:8}
    week_key=$(date -u -d "@$epoch" +%G-W%V)
    month_key=${stamp:0:6}

    if ((age <= 172800)); then keep[$basename]=1; fi
    if [[ -z ${day_seen[$day_key]:-} ]] && ((daily_count < 14)); then
      day_seen[$day_key]=1
      daily_count=$((daily_count + 1))
      keep[$basename]=1
    fi
    if [[ -z ${week_seen[$week_key]:-} ]] && ((weekly_count < 8)); then
      week_seen[$week_key]=1
      weekly_count=$((weekly_count + 1))
      keep[$basename]=1
    fi
    if [[ -z ${month_seen[$month_key]:-} ]] && ((monthly_count < 12)); then
      month_seen[$month_key]=1
      monthly_count=$((monthly_count + 1))
      keep[$basename]=1
    fi
  done

  for basename in "${files[@]}"; do
    if [[ -z ${keep[$basename]:-} ]]; then
      backup_file=$source_directory/$basename
      checksum_file=$backup_file.sha256
      printf 'Pruning expired backup %s.\n' "$backup_file"
      rm -f -- "$backup_file"
      [[ -e $checksum_file ]] && rm -f -- "$checksum_file"
    fi
  done
  unset keep day_seen week_seen month_seen
done <"$sources_file"
