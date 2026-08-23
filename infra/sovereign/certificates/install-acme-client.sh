#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || {
  echo "ACME client installation must run as root" >&2
  exit 77
}

version=3.1.4
expected_commit=3661fd86b6304115e42f43910e6dd452ab9866d6
repository=https://github.com/acmesh-official/acme.sh.git
acme_home=/root/.acme.sh

if [ -x "$acme_home/acme.sh" ] &&
  "$acme_home/acme.sh" --version 2>&1 | grep -Fq "v$version"
then
  echo "acme.sh $version is already installed"
  exit 0
fi

for command_name in git openssl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command not found: $command_name" >&2
    exit 69
  }
done

work_dir=$(mktemp -d /var/tmp/t3-acme-client.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

git clone --quiet --depth 1 --branch "$version" "$repository" "$work_dir/source"
actual_commit=$(git -C "$work_dir/source" rev-parse HEAD)
[ "$actual_commit" = "$expected_commit" ] || {
  echo "acme.sh tag resolved to unexpected commit $actual_commit" >&2
  exit 65
}

(
  cd "$work_dir/source"
  ./acme.sh --install \
    --home "$acme_home" \
    --config-home "$acme_home" \
    --nocron \
    --no-profile
)

"$acme_home/acme.sh" --version 2>&1 | grep -F "v$version"
echo "installed acme.sh $version from $expected_commit"
