#!/bin/bash
# Notarizes a packaged macOS app that was signed with a Developer ID, and staples the ticket to it. Usage:
#   APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... scripts/notarize-local-macos.sh <path to Escritoriio Runner.app>
# It refuses to run unless all three are in the environment: they are the owner's own, and nothing here stores or asks for them.
set -euo pipefail

missing=""
for name in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  [ -n "${!name:-}" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "Not notarizing: these are not set in the environment:$missing." >&2
  echo "Notarization needs the Apple ID of a paid Apple Developer account, an app-specific password made for it (appleid.apple.com) and the team id." >&2
  echo "Only the owner of that account can provide them. A self-signed build (sign-local-macos.sh) cannot be notarized." >&2
  exit 1
fi

[ "$(uname)" = "Darwin" ] || { echo "This script is for macOS." >&2; exit 1; }
app="${1:-}"
[ -n "$app" ] && [ -d "$app/Contents" ] || { echo "Usage: $0 <path to the .app>" >&2; exit 2; }

if ! codesign -dvv "$app" 2>&1 | grep -q "Authority=Developer ID Application"; then
  echo "Not notarizing: the app is not signed with a Developer ID Application certificate, which Apple requires." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
ditto -c -k --keepParent "$app" "$work/app.zip"
# notarytool takes the password as an argument; the other way to give it a password is a profile in a keychain, which this script would have to
# leave behind on the machine, so the argument it is.
xcrun notarytool submit "$work/app.zip" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$app"
spctl --assess --type execute -vv "$app"
