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
DMG_LAYOUT_MODE="headless"
SEA_BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
SEA_ARTIFACT="$SEA_BINARIES_DIR/desktop-runtime-$TARGET"
SEA_MANIFEST="$SEA_BINARIES_DIR/desktop-runtime-$TARGET.manifest.json"
SEA_ENTITLEMENTS="$PROJECT_ROOT/src-tauri/entitlements.release.plist"
KIMI_SOURCE_TAG=""
KIMI_SOURCE_COMMIT=""
DMG_REPACKAGED="false"

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

create_dmg() {
  # Script-owned DMG packaging (hdiutil): the .app built by `--bundles app`
  # stays in $MACOS_DIR (tauri's dmg pass would clean it after packaging), so
  # the fixed app can be packaged after the sidecar signature repair.
  local app_name="Kimi Code.app"
  local dmg_name="Kimi Code_${PACKAGE_VERSION}_aarch64.dmg"
  local rw_image="$DMG_DIR/rw.$$.$dmg_name"
  local mount_dir device

  # `--bundles app` never creates the dmg dir, so ensure it exists.
  mkdir -p "$DMG_DIR" || return 1
  # hdiutil's convert refuses to overwrite an existing target.
  rm -f "$DMG_DIR/$dmg_name" "$DMG_DIR"/rw.*.dmg || return 1
  echo "Creating disk image (script-owned packaging)…"
  hdiutil create -format UDRW -volname "Kimi Code" \
    -fs HFS+ -fsargs "-c c=64,a=16,e=16" \
    -srcfolder "$MACOS_DIR/$app_name" \
    "$rw_image" || return 1
  mount_dir="$(mktemp -d /tmp/kimi-dmg-mount.XXXXXX)" || return 1
  device="$(hdiutil attach -mountpoint "$mount_dir" -readwrite -noverify -noautoopen -nobrowse "$rw_image" \
    | grep -E '^/dev/' | sed -n 1p | awk '{print $1}')" || return 1
  ln -s /Applications "$mount_dir/Applications" || return 1
  if [[ -f "$PROJECT_ROOT/src-tauri/icons/icon.icns" ]]; then
    cp "$PROJECT_ROOT/src-tauri/icons/icon.icns" "$mount_dir/.VolumeIcon.icns" || return 1
    SetFile -c icnC "$mount_dir/.VolumeIcon.icns" 2>/dev/null || true
    SetFile -a C "$mount_dir" 2>/dev/null || true
  fi
  chmod -Rf go-w "$mount_dir" 2>/dev/null || true
  rm -rf "$mount_dir/.fseventsd" 2>/dev/null || true
  hdiutil detach "$device" >/dev/null || { echo "Failed to detach $device" >&2; return 1; }
  rmdir "$mount_dir" 2>/dev/null || true
  echo "Compressing disk image…"
  hdiutil convert "$rw_image" -format UDZO -imagekey zlib-level=9 -o "$DMG_DIR/$dmg_name" || return 1
  rm -f "$rw_image"
  DMG_LAYOUT_MODE="headless"
  echo "Disk image done: $DMG_DIR/$dmg_name"
}

build_dmg() {
  # One-shot per attempt: tauri builds + signs the .app (`--bundles app` keeps
  # the intermediate bundle, which tauri's dmg pass would otherwise clean),
  # the sidecar signature is normalized, then the DMG is packaged from the
  # fixed app.
  local identity="${1:--}"
  if ! npm run tauri -- build --bundles app --target "$TARGET"; then
    return 1
  fi
  finalize_bundle_signing "$identity" || return 1
  create_dmg || return 1
}

# --- Source Runtime SEA sidecar (M5) -----------------------------------------

read_kimi_source_identity() {
  # Frozen source identity is read from runtime/UPSTREAM.md (the canonical
  # freeze record); the commit is cross-checked against the KIMI_SOURCE_COMMIT
  # constant the artifact itself reports. Never hand-copied.
  local upstream="$PROJECT_ROOT/runtime/UPSTREAM.md"
  local protocol="$PROJECT_ROOT/runtime/kimi-code/apps/desktop-runtime/src/protocol.ts"
  KIMI_SOURCE_TAG="$(sed -nE 's/^\| Tag \| `([^`]+)` \|.*/\1/p' "$upstream" | head -n 1)"
  KIMI_SOURCE_COMMIT="$(sed -nE 's/^\| Commit \| `([0-9a-f]{40})` \|.*/\1/p' "$upstream" | head -n 1)"
  local protocol_commit
  protocol_commit="$(sed -nE "s/^export const KIMI_SOURCE_COMMIT = '([0-9a-f]{40})';.*/\1/p" "$protocol" | head -n 1)"
  if [[ -z "$KIMI_SOURCE_TAG" || -z "$KIMI_SOURCE_COMMIT" ]]; then
    echo "Cannot read the frozen Kimi source identity from $upstream." >&2
    return 1
  fi
  if [[ "$KIMI_SOURCE_COMMIT" != "$protocol_commit" ]]; then
    echo "Source commit drift: UPSTREAM.md=$KIMI_SOURCE_COMMIT, protocol.ts=$protocol_commit." >&2
    return 1
  fi
}

build_runtime_sidecar() {
  # Source Runtime SEA sidecar: frozen install -> build -> single-executable
  # artifact in src-tauri/binaries (Tauri externalBin picks it up). Fail-fast:
  # no runtime, no release.
  npm run runtime:install || return 1
  npm run runtime:build || return 1
  npm run runtime:sea || return 1
  if [[ ! -x "$SEA_ARTIFACT" ]]; then
    echo "Source Runtime sidecar missing after build: $SEA_ARTIFACT" >&2
    return 1
  fi
  echo "Source Runtime sidecar ready: $SEA_ARTIFACT"
}

write_runtime_manifest() {
  # Release manifest consumed by readiness::check_manifest (kimiSource
  # identity plus build provenance). Naming convention — sibling of the SEA
  # artifact:
  #   src-tauri/binaries/desktop-runtime-<target-triple>.manifest.json
  # (see src-tauri/src/runtime/readiness.rs).
  read_kimi_source_identity || return 1
  local built_at
  built_at="$(node -p 'new Date().toISOString()')" || return 1
  local tmp_manifest="${SEA_MANIFEST}.tmp"
  {
    echo '{'
    echo '  "kimiSource": {'
    echo "    \"tag\": \"$KIMI_SOURCE_TAG\","
    echo "    \"commit\": \"$KIMI_SOURCE_COMMIT\""
    echo '  },'
    echo "  \"builtAt\": \"$built_at\","
    echo '  "builder": "release-macos.sh"'
    echo '}'
  } > "$tmp_manifest" || return 1
  mv "$tmp_manifest" "$SEA_MANIFEST" || return 1
  echo "Source Runtime release manifest written: $SEA_MANIFEST"
}

sign_runtime_artifact() {
  # build:sea leaves the artifact ad-hoc signed as a development fallback. The
  # release pipeline re-signs the sidecar with the same identity the app
  # bundle uses, so `Contents/MacOS/desktop-runtime` ships properly signed.
  # arm64 requires at least an ad-hoc signature to exec, so the unsigned
  # fallback also ad-hoc signs the sidecar.
  local identity="${1:--}"
  if [[ ! -f "$SEA_ARTIFACT" ]]; then
    echo "Source Runtime sidecar missing (cannot sign): $SEA_ARTIFACT" >&2
    return 1
  fi
  codesign --force --sign "$identity" "$SEA_ARTIFACT" || return 1
  codesign --verify --verbose=2 "$SEA_ARTIFACT" || return 1
  echo "Source Runtime sidecar signed: $SEA_ARTIFACT ($identity)"
}

sidecar_needs_repair() {
  # Decide whether the bundled sidecar must be re-signed after tauri's build.
  local app_path="$1"
  local sidecar="$2"
  # Already carries the JIT entitlement Node needs under hardened runtime →
  # healthy (Developer ID path with `bundle.macOS.entitlements`).
  if codesign -d --entitlements - "$sidecar" 2>/dev/null | grep -q 'allow-jit'; then
    return 1
  fi
  # Hardened runtime without the JIT entitlement → Node/V8 crashes at startup
  # ("Fatal process out of memory: Failed to reserve virtual memory for
  # CodeRange"), so the sidecar must be re-signed with the entitlements.
  if codesign -dv "$sidecar" 2>/dev/null | grep -q 'flags=.*runtime'; then
    return 0
  fi
  # No hardened runtime: the sidecar itself is exec-able, but if the app
  # bundle seal is broken (tauri skips signing entirely with an ad-hoc
  # identity + entitlements config), the app is not distributable → repair.
  if codesign --verify "$app_path" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

finalize_bundle_signing() {
  # Normalize the bundled sidecar signature so Node's V8 works under hardened
  # runtime: re-sign the sidecar and the main binary with the JIT
  # entitlements (same identity the app uses), re-seal the bundle, and
  # repackage the DMG from the fixed app. No-op when tauri's signing already
  # produced a healthy sidecar + valid app seal.
  local identity="${1:--}"
  local app_path="$MACOS_DIR/Kimi Code.app"
  local sidecar="$app_path/Contents/MacOS/desktop-runtime"
  local main_bin
  main_bin="$(find "$app_path/Contents/MacOS" -maxdepth 1 -type f ! -name 'desktop-runtime' -print -quit)"
  if [[ ! -f "$sidecar" ]]; then
    echo "Bundled sidecar missing at $sidecar" >&2
    return 1
  fi
  if ! sidecar_needs_repair "$app_path" "$sidecar"; then
    echo "Bundled sidecar signature is healthy (JIT entitlements present, app seal valid)."
    return 0
  fi
  echo "Re-signing the bundled sidecar with JIT entitlements (Node V8 under hardened runtime)…"
  codesign --force --options runtime --entitlements "$SEA_ENTITLEMENTS" \
    --sign "$identity" "$sidecar" || return 1
  if [[ -n "$main_bin" ]]; then
    codesign --force --options runtime --entitlements "$SEA_ENTITLEMENTS" \
      --sign "$identity" "$main_bin" || return 1
  fi
  codesign --force --sign "$identity" "$app_path" || return 1
  codesign --verify --deep --strict "$app_path" || return 1
  DMG_REPACKAGED="true"
  if [[ -n "$FALLBACK_REASON" ]]; then
    FALLBACK_REASON="${FALLBACK_REASON} Bundled sidecar was re-signed with JIT entitlements."
  else
    FALLBACK_REASON="Bundled sidecar was re-signed with JIT entitlements."
  fi
  echo "Bundled app re-signed (JIT entitlements); DMG packaging uses the fixed app."
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
  sign_runtime_artifact "$APPLE_SIGNING_IDENTITY" || return 1
  clean_bundle_outputs || return 1
  build_dmg "$APPLE_SIGNING_IDENTITY" || return 1
}

attempt_adhoc_build() {
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
  unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH APPLE_API_KEY_CONTENT
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  export APPLE_SIGNING_IDENTITY="-"
  sign_runtime_artifact "-" || return 1
  clean_bundle_outputs || return 1
  build_dmg "-" || return 1
}

attempt_unsigned_build() {
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
  unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH APPLE_API_KEY_CONTENT
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  sign_runtime_artifact "-" || return 1
  clean_bundle_outputs || return 1
  build_dmg "-" || return 1
}

# M5: build the Source Runtime SEA sidecar and its release manifest before any
# DMG attempt. Fail-fast — no runtime artifact, no release.
build_runtime_sidecar || exit 1
write_runtime_manifest || exit 1

if has_certificate && has_notarization_credentials; then
  if attempt_notarized_build; then
    SIGNING_MODE="notarized"
    if [[ "$DMG_REPACKAGED" == "true" ]]; then
      # The final DMG was repackaged after the sidecar signature repair, so
      # tauri's in-build notarization no longer covers the shipped artifact.
      NOTARIZATION_STATUS="stale-after-repackage"
    else
      NOTARIZATION_STATUS="succeeded"
    fi
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
export KIMI_RELEASE_DMG_REPACKAGED="$DMG_REPACKAGED"
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
  dmgRepackaged: process.env.KIMI_RELEASE_DMG_REPACKAGED === "true",
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
  echo "- DMG repackaged after sidecar signature repair: \`$DMG_REPACKAGED\`"
  echo "- Runtime sidecar: \`$SEA_ARTIFACT\` ($KIMI_SOURCE_TAG, manifest \`$SEA_MANIFEST\`)"
  if [[ -n "$FALLBACK_REASON" ]]; then
    echo "- Fallback: $FALLBACK_REASON"
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "macOS ARM64 DMG ready: $DMG_PATH"
echo "Signing mode: $SIGNING_MODE; notarization: $NOTARIZATION_STATUS; DMG layout: $DMG_LAYOUT_MODE; repackaged: $DMG_REPACKAGED"
echo "Source Runtime sidecar: $SEA_ARTIFACT ($KIMI_SOURCE_TAG)"
echo "Source Runtime release manifest: $SEA_MANIFEST"
