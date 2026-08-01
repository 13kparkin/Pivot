#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEVICE_ID="${T3_SWIFT_DEVICE_ID:-${1:-}}"
DEVELOPMENT_TEAM="${T3_SWIFT_DEVELOPMENT_TEAM:-${2:-}}"
CONFIGURATION="${T3_SWIFT_CONFIGURATION:-Debug}"
BUNDLE_IDENTIFIER="${T3_SWIFT_BUNDLE_IDENTIFIER:-com.t3tools.t3code.swiftui}"
DERIVED_DATA_PATH="${T3_SWIFT_DERIVED_DATA_PATH:-${APP_DIR}/.derivedData/device}"

die() {
  printf '[swift-ios-device] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd xcodebuild
require_cmd xcrun

[[ -n "${DEVICE_ID}" ]] || die \
  "set T3_SWIFT_DEVICE_ID to an identifier from 'xcrun devicectl list devices'"
[[ -n "${DEVELOPMENT_TEAM}" ]] || die \
  "set T3_SWIFT_DEVELOPMENT_TEAM to your Apple Developer team ID"
[[ "${CONFIGURATION}" == "Debug" || "${CONFIGURATION}" == "Release" ]] || die \
  "T3_SWIFT_CONFIGURATION must be Debug or Release"

build_settings=(
  "DEVELOPMENT_TEAM=${DEVELOPMENT_TEAM}"
  "PRODUCT_BUNDLE_IDENTIFIER=${BUNDLE_IDENTIFIER}"
)

for key in \
  T3CODE_CLERK_PUBLISHABLE_KEY \
  T3CODE_CLERK_JWT_TEMPLATE \
  T3CODE_RELAY_URL; do
  value="${!key:-}"
  if [[ -n "${value}" ]]; then
    build_settings+=("${key}=${value}")
  fi
done

if [[ -n "${T3_SWIFT_VERSION:-}" ]]; then
  build_settings+=("MARKETING_VERSION=${T3_SWIFT_VERSION}")
fi
if [[ -n "${T3_SWIFT_BUILD_NUMBER:-}" ]]; then
  build_settings+=("CURRENT_PROJECT_VERSION=${T3_SWIFT_BUILD_NUMBER}")
fi

printf '[swift-ios-device] building %s for %s\n' "${BUNDLE_IDENTIFIER}" "${DEVICE_ID}"
xcodebuild build \
  -project "${APP_DIR}/T3Code.xcodeproj" \
  -scheme T3Code \
  -configuration "${CONFIGURATION}" \
  -destination "platform=iOS,id=${DEVICE_ID}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -allowProvisioningUpdates \
  "${build_settings[@]}"

APP_PATH="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphoneos/T3Code.app"
[[ -d "${APP_PATH}" ]] || die "built app was not found at ${APP_PATH}"

printf '[swift-ios-device] installing %s\n' "${APP_PATH}"
xcrun devicectl device install app --device "${DEVICE_ID}" "${APP_PATH}"

printf '[swift-ios-device] launching %s\n' "${BUNDLE_IDENTIFIER}"
xcrun devicectl device process launch --device "${DEVICE_ID}" "${BUNDLE_IDENTIFIER}"
