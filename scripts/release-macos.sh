#!/usr/bin/env bash
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER_TEMP="${RUNNER_TEMP:-$PROJECT_ROOT/src-tauri/target/tmp}"
TARGET="aarch64-apple-darwin"
BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/$TARGET/release/bundle"
DMG_DIR="$BUNDLE_ROOT/dmg"
MACOS_DIR="$BUNDLE_ROOT/macos"
MANIFEST="$DMG_DIR/release-manifest-macos-arm64.json"
CHECKSUMS="$DMG_DIR/SHA256SUMS-macos-arm64.txt"
PACKAGE_VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
SIGNING_MODE="unsigned"
NOTARIZATION_STATUS="not-attempted"
FALLBACK_REASON=""
DMG_LAYOUT_MODE="finder"

clean_bundle_outputs() {
  mkdir -p "$RUNNER_TEMP"
  local attempt_dir="$RUNNER_TEMP/kimi-code-bundle-$(date +%s)-$RANDOM"
  mkdir -p "$attempt_dir"
  if [[ -d "$DMG_DIR" ]]; then
    mv "$DMG_DIR" "$attempt_dir/dmg"
  fi
  if [[ -d "$MACOS_DIR" ]]; then
    mv "$MACOS_DIR" "$attempt_dir/macos"
  fi
}

build_headless_dmg() {
  local app_name="Kimi Code.app"
  local dmg_name="Kimi Code_${PACKAGE_VERSION}_aarch64.dmg"
  local bundle_script="$DMG_DIR/bundle_dmg.sh"
  local volume_icon="$DMG_DIR/icon.icns"

  [[ -f "$bundle_script" ]] || return 1
  [[ -f "$volume_icon" ]] || return 1
  [[ -d "$MACOS_DIR/$app_name" ]] || return 1

  echo "Retrying DMG packaging without Finder AppleScript layout."
  (
    cd "$MACOS_DIR" || exit 1
    "$bundle_script" \
      --skip-jenkins \
      --volname "Kimi Code" \
      --icon "$app_name" 180 170 \
      --app-drop-link 480 170 \
      --window-size 660 400 \
      --hide-extension "$app_name" \
      --volicon "$volume_icon" \
      "$DMG_DIR/$dmg_name" \
      "$app_name"
  ) || return 1
  DMG_LAYOUT_MODE="headless"
}

build_dmg() {
  if npm run tauri -- build --bundles dmg --target "$TARGET"; then
    return 0
  fi
  build_headless_dmg
}

prepare_notarization_key() {
  if [[ -n "${APPLE_API_KEY_CONTENT:-}" && -n "${APPLE_API_KEY:-}" ]]; then
    local key_dir="$RUNNER_TEMP/private_keys"
    mkdir -p "$key_dir"
    export APPLE_API_KEY_PATH="$key_dir/AuthKey_${APPLE_API_KEY}.p8"
    printf '%s' "$APPLE_API_KEY_CONTENT" > "$APPLE_API_KEY_PATH" || return 1
  fi
}

has_certificate() {
  [[ -n "${APPLE_CERTIFICATE:-}" &&
     -n "${APPLE_CERTIFICATE_PASSWORD:-}" &&
     -n "${APPLE_SIGNING_IDENTITY:-}" ]]
}

has_notarization_credentials() {
  [[ (-n "${APPLE_API_ISSUER:-}" &&
      -n "${APPLE_API_KEY:-}" &&
      (-n "${APPLE_API_KEY_PATH:-}" || -n "${APPLE_API_KEY_CONTENT:-}")) ||
     (-n "${APPLE_ID:-}" &&
      -n "${APPLE_PASSWORD:-}" &&
      -n "${APPLE_TEAM_ID:-}") ]]
}

prepare_signing_certificate() {
  local certificate_path="$RUNNER_TEMP/kimi-code-certificate.p12"
  local keychain_path="$RUNNER_TEMP/kimi-code-build.keychain-db"
  local keychain_password="${KEYCHAIN_PASSWORD:-kimi-code-ci-keychain}"

  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$certificate_path" || return 1
  security create-keychain -p "$keychain_password" "$keychain_path" || return 1
  security set-keychain-settings -lut 21600 "$keychain_path" || return 1
  security unlock-keychain -p "$keychain_password" "$keychain_path" || return 1
  security import "$certificate_path" \
    -P "$APPLE_CERTIFICATE_PASSWORD" \
    -A \
    -t cert \
    -f pkcs12 \
    -k "$keychain_path" || return 1
  security list-keychain -d user -s "$keychain_path" || return 1
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -s \
    -k "$keychain_password" \
    "$keychain_path" || return 1
  security find-identity -v -p codesigning "$keychain_path" || return 1
}

attempt_notarized_build() {
  has_certificate || return 1
  has_notarization_credentials || return 1
  prepare_notarization_key || return 1
  prepare_signing_certificate || return 1
  clean_bundle_outputs || return 1
  build_dmg
}

attempt_adhoc_build() {
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
  unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH APPLE_API_KEY_CONTENT
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  export APPLE_SIGNING_IDENTITY="-"
  clean_bundle_outputs || return 1
  build_dmg
}

attempt_unsigned_build() {
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
  unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH APPLE_API_KEY_CONTENT
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  clean_bundle_outputs || return 1
  build_dmg
}

if has_certificate && has_notarization_credentials; then
  if attempt_notarized_build; then
    SIGNING_MODE="notarized"
    NOTARIZATION_STATUS="succeeded"
  else
    FALLBACK_REASON="Developer ID signing or notarization failed; rebuilt with ad-hoc signing."
    NOTARIZATION_STATUS="failed"
  fi
else
  FALLBACK_REASON="Apple signing or notarization secrets were incomplete; built with ad-hoc signing."
fi

if [[ "$SIGNING_MODE" != "notarized" ]]; then
  if attempt_adhoc_build; then
    SIGNING_MODE="ad-hoc"
  else
    FALLBACK_REASON="${FALLBACK_REASON} Ad-hoc signing failed; rebuilt unsigned."
    if attempt_unsigned_build; then
      SIGNING_MODE="unsigned"
    else
      echo "All macOS DMG build attempts failed." >&2
      exit 1
    fi
  fi
fi

DMG_PATH="$(find "$DMG_DIR" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
if [[ -z "$DMG_PATH" ]]; then
  echo "No macOS DMG was produced under $DMG_DIR." >&2
  exit 1
fi

DMG_NAME="$(basename "$DMG_PATH")"
DMG_BYTES="$(stat -f '%z' "$DMG_PATH")"
DMG_SHA256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
printf '%s  %s\n' "$DMG_SHA256" "$DMG_NAME" > "$CHECKSUMS"

export KIMI_RELEASE_VERSION="$PACKAGE_VERSION"
export KIMI_RELEASE_DMG_NAME="$DMG_NAME"
export KIMI_RELEASE_DMG_BYTES="$DMG_BYTES"
export KIMI_RELEASE_DMG_SHA256="$DMG_SHA256"
export KIMI_RELEASE_SIGNING_MODE="$SIGNING_MODE"
export KIMI_RELEASE_NOTARIZATION_STATUS="$NOTARIZATION_STATUS"
export KIMI_RELEASE_FALLBACK_REASON="$FALLBACK_REASON"
export KIMI_RELEASE_DMG_LAYOUT_MODE="$DMG_LAYOUT_MODE"
node <<'NODE' > "$MANIFEST"
const manifest = {
  schema: 1,
  createdAt: new Date().toISOString(),
  buildCommand: "npm run release:macos",
  version: process.env.KIMI_RELEASE_VERSION,
  platform: "macos",
  arch: "aarch64",
  target: "aarch64-apple-darwin",
  commit: process.env.GITHUB_SHA || null,
  signingMode: process.env.KIMI_RELEASE_SIGNING_MODE,
  notarizationStatus: process.env.KIMI_RELEASE_NOTARIZATION_STATUS,
  dmgLayoutMode: process.env.KIMI_RELEASE_DMG_LAYOUT_MODE,
  fallbackReason: process.env.KIMI_RELEASE_FALLBACK_REASON || null,
  files: {
    dmg: {
      name: process.env.KIMI_RELEASE_DMG_NAME,
      bytes: Number(process.env.KIMI_RELEASE_DMG_BYTES),
      sha256: process.env.KIMI_RELEASE_DMG_SHA256,
    },
  },
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
NODE

{
  echo "### macOS ARM64 release"
  echo
  echo "- DMG: \`$DMG_NAME\`"
  echo "- Signing mode: \`$SIGNING_MODE\`"
  echo "- Notarization: \`$NOTARIZATION_STATUS\`"
  echo "- DMG layout: \`$DMG_LAYOUT_MODE\`"
  if [[ -n "$FALLBACK_REASON" ]]; then
    echo "- Fallback: $FALLBACK_REASON"
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "macOS ARM64 DMG ready: $DMG_PATH"
echo "Signing mode: $SIGNING_MODE; notarization: $NOTARIZATION_STATUS; DMG layout: $DMG_LAYOUT_MODE"
