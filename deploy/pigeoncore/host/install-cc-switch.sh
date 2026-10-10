#!/usr/bin/env bash
set -euo pipefail

# CC Switch's desktop project recommends this community CLI for SSH servers.
version=5.11.0
sha256=272a4d5414a1bc815752227d305c24d894b6c2f5d59bb5e39853041ff752a7af
target=/opt/t3/tools/cc-switch
stage=$(mktemp -d /tmp/t3-cc-switch-install.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT

curl --fail --location --silent --show-error \
  "https://github.com/SaladDay/cc-switch-cli/releases/download/v${version}/cc-switch-cli-linux-x64-musl.tar.gz" \
  --output "$stage/release.tar.gz"
printf '%s  %s\n' "$sha256" "$stage/release.tar.gz" | sha256sum --check --status
tar -xzf "$stage/release.tar.gz" -C "$stage"
install -d -m 755 "$target/$version"
install -m 755 "$stage/cc-switch" "$target/$version/cc-switch"
ln -sfn "$target/$version/cc-switch" /usr/local/bin/cc-switch
/usr/local/bin/cc-switch --version
