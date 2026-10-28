#!/bin/sh
# Installs the named binaries (entire, git-remote-entire) from a pinned, checksum-verified Entire CLI release.
set -eux
version=0.12.2
arch="$(dpkg --print-architecture)"
case "$arch" in
  amd64) sha256=bfc5c8d5b599f328775b89b735db020c963e307b6a324fc30ce371fe8fa789e8 ;;
  arm64) sha256=f08a1b8c6352d3f78076268dc67b0b273d7f62dbab94b15aec028e7b4257ad0c ;;
  *) echo "unsupported Entire CLI architecture: $arch" >&2; exit 1 ;;
esac
archive="$(mktemp)"
curl -fsSL "https://github.com/entireio/cli/releases/download/v${version}/entire_linux_${arch}.tar.gz" -o "$archive"
echo "${sha256}  ${archive}" | sha256sum -c -
tar -xzf "$archive" -C /usr/local/bin "$@"
rm -f "$archive"
git-remote-entire --version
