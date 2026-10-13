#!/bin/bash
# Signs a packaged macOS app with a SELF-SIGNED identity, to try how a signed build behaves on this machine. Usage:
#   scripts/sign-local-macos.sh <path to Escritoriio Runner.app>
# With CSC_NAME set to the name of an identity you already have, that one is used and nothing is generated.
#
# macOS refuses to sign with a certificate it does not trust, and a self-signed one is trusted only when somebody says so. This script does not change
# your trust settings on its own: with TRUST_TEMPORARY_CERT=1 it trusts the temporary certificate for code signing in your user domain (macOS asks for
# your password) and removes that trust when it ends. Without it, the script stops at the point where codesign would refuse, and says why.
#
# What a kill that cannot be caught (SIGKILL, a power cut) leaves behind: the folder in the temporary directory (with the temporary keychain and the
# password of its file, mode 0600) and, when TRUST_TEMPORARY_CERT=1 was given, the trust of the certificate in your user domain. The certificate lasts two
# days and is for code signing only; remove the trust in Keychain Access (it is named Escritoriio Runner Local Signing) or with
# `security remove-trusted-cert <cert.pem>` if the folder is still there. The search list of keychains may also need `security list-keychains -d user -s`.
#
# Without it the identity is made here, in a keychain of its own in a temporary folder: the login keychain is not opened, the search list of keychains
# is put back as it was, and the folder with the key is deleted on exit, whatever happens. No key is ever written inside the repository.
set -euo pipefail

cat <<'NOTICE'
A self-signed identity is only good for trying a signed build on this computer.
  - It CANNOT be notarized. Notarization needs a Developer ID certificate of a paid Apple Developer account.
  - Gatekeeper will still refuse the app on any other Mac, and here once it is quarantined.
  - Automatic updates (electron-updater) on macOS need an app signed with a real certificate: the updater checks that the new version is signed
    by the same identity as the running one, and a self-signed identity does not survive on another machine.
NOTICE

[ "$(uname)" = "Darwin" ] || { echo "This script is for macOS." >&2; exit 1; }
app="${1:-}"
[ -n "$app" ] && [ -d "$app/Contents" ] || { echo "Usage: $0 <path to the .app>" >&2; exit 2; }
app="$(cd "$app" && pwd)"

work="$(mktemp -d)"
chmod 700 "$work"
keychain="$work/local-signing.keychain-db"
keychains_before=()
while IFS= read -r line; do
  line="${line//\"/}"
  line="${line#"${line%%[![:space:]]*}"}"
  [ -n "$line" ] && keychains_before+=("$line")
done < <(security list-keychains -d user)
made_keychain=0

cleanup() {
  if [ -n "$trusted_cert" ]; then
    security remove-trusted-cert "$trusted_cert" >/dev/null 2>&1 || echo "Could not remove the trust of the temporary certificate: remove it in Keychain Access (it is named Escritoriio Runner Local Signing)." >&2
  fi
  if [ "$made_keychain" = 1 ]; then
    security delete-keychain "$keychain" >/dev/null 2>&1 || true
  fi
  # The search list is only ever touched by `security create-keychain`, which adds the new one to it; this puts it back exactly.
  security list-keychains -d user -s "${keychains_before[@]}" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trusted_cert=""

if [ -n "${CSC_NAME:-}" ]; then
  identity="$CSC_NAME"
  keychain_args=()
  echo "Using the identity you named: $identity"
else
  password="$(openssl rand -hex 16)"
  # For openssl the password is read from a file of the private folder, so that it is not in the command line, which any user of the machine can list.
  # The tools of `security` take it only as an argument (their -p and -P), so it is there for the few seconds of those calls: it opens a keychain that holds
  # a certificate valid for two days, in a folder only this user can open, and that is deleted when the script ends.
  (umask 077 && printf '%s' "$password" > "$work/password")
  config="$work/openssl.cnf"
  cat > "$config" <<'CONF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Escritoriio Runner Local Signing (self-signed)
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CONF
  # The system's own openssl (LibreSSL) writes a p12 that `security import` can read; a newer OpenSSL's default encryption it cannot.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$config" -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/identity.p12" -passout "file:$work/password" 2>/dev/null
  security create-keychain -p "$password" "$keychain"
  made_keychain=1
  security set-keychain-settings -lut 1800 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  security import "$work/identity.p12" -k "$keychain" -P "$password" -T /usr/bin/codesign >/dev/null
  # Lets codesign use the key without a dialog asking for the keychain's password.
  security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
  rm -f "$work/key.pem" "$work/identity.p12"
  if [ "${TRUST_TEMPORARY_CERT:-}" = 1 ]; then
    trusted_cert="$work/cert.pem"
    # -k names the keychain the certificate is added to: the temporary one, never the login keychain. The trust itself is a setting of the user domain,
    # kept for this certificate by its fingerprint and removed when the script ends.
    security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$trusted_cert"
  fi
  identity="$(security find-identity -v -p codesigning "$keychain" | awk '/[0-9A-F]{40}/ { print $2; exit }')"
  if [ -z "$identity" ]; then
    echo "The temporary certificate was made and imported, but macOS does not trust it, so codesign would answer \"no identity found\"." >&2
    echo "Run again with TRUST_TEMPORARY_CERT=1 to trust it for code signing while this script runs, or give the name of an identity you already trust in CSC_NAME." >&2
    exit 1
  fi
  keychain_args=(--keychain "$keychain")
  echo "Made a temporary self-signed identity ($identity) in a keychain that is deleted when this script ends."
fi

# What hardened Electron needs to start at all (the JIT of V8), plus no library validation: a self-signed identity has no team, and the framework and the
# helpers would otherwise be refused for coming from a different team than the app. A real Developer ID build does not need the last one.
entitlements="$work/entitlements.plist"
cat > "$entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
PLIST

sign() {
  codesign --force --sign "$identity" ${keychain_args[@]+"${keychain_args[@]}"} --options runtime --timestamp=none --entitlements "$entitlements" "$1"
}

# Inside out: code deep in the bundle first, then the bundles around it, so that each seal covers what is already signed. Deepest first.
by_depth() { awk -F/ '{ print NF, $0 }' | sort -rn | cut -d' ' -f2-; }

echo "Signing the code inside the app..."
find "$app/Contents" -type f ! -path "$app/Contents/MacOS/*" -print | while IFS= read -r file; do
  if file -b "$file" | grep -q "Mach-O"; then echo "$file"; fi
done | by_depth | while IFS= read -r file; do sign "$file"; done

echo "Signing the bundles..."
find "$app/Contents" -type d \( -name '*.framework' -o -name '*.app' \) -print | by_depth | while IFS= read -r bundle; do sign "$bundle"; done
sign "$app"

echo
echo "--- codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$app"
echo "--- identity and flags"
codesign -dv "$app" 2>&1 | grep -E "Identifier|Authority|flags|TeamIdentifier|Signature" || true
echo "--- spctl --assess (Gatekeeper)"
if spctl --assess --type execute -vv "$app"; then
  echo "Gatekeeper accepted the app."
else
  echo "Gatekeeper REJECTED the app, as expected: it is self-signed and not notarized."
fi
