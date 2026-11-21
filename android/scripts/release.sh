#!/bin/bash
# Builds Yew for Android and signs it with the app signing key. It publishes nothing.
# Release packages are signed only here, on the Mac that holds the key.
#
# Signing happens here and not in Gradle, so the password never reaches the Gradle daemon or a build
# file. Without the real key this stops; it never falls back to another key.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/signing-common.sh"

PACKAGE="cn.tenonai.apps.yew"
[ -f "$KEYSTORE" ] || fail "找不到正式签名密钥：${KEYSTORE}。没有它不出正式包。"
[ -f "$FINGERPRINT_FILE" ] || fail "找不到登记的证书指纹：${FINGERPRINT_FILE}"
EXPECTED="$(tr -d '[:space:]' <"$FINGERPRINT_FILE")"

cd "$ANDROID_DIR"
# The package has to match one commit: the app, the version it reads and the policy text it copies.
[ -z "$(git status --porcelain -- . ../package.json ../src/shared/policy.ts)" ] ||
    fail "android/、package.json 或 src/shared/policy.ts 有没提交的改动。发布的包要对得上一个提交。"
VERSION="$(sed -n 's/^.*"version": *"\([0-9][0-9.]*\)".*$/\1/p' ../package.json | head -1)"
[ -n "$VERSION" ] || fail "读不到版本号"
# The privacy policy in the package must be the one that covers Android.
grep -q '安卓' app/src/main/res/values-zh-rCN/policy.xml && grep -q 'Android' app/src/main/res/values/policy.xml ||
    fail "应用里的隐私政策还没有安卓的内容。等它并进 src/shared/policy.ts 后跑 sync-policy.ts，再出包。"

# No library in the package has a known vulnerability (OSV); only names and versions are sent.
node scripts/check-vulnerabilities.ts || fail "进安装包的库里有已知漏洞，或者查不了 OSV。先处理再出包。"

./gradlew --console=plain clean :app:testDebugUnitTest :app:lintRelease :app:assembleRelease
UNSIGNED="app/build/outputs/apk/release/app-release-unsigned.apk"
[ -f "$UNSIGNED" ] || fail "没有生成未签名的正式包：${UNSIGNED}"

OUT_DIR="$ANDROID_DIR/build/release"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
APK="$OUT_DIR/Yew-$VERSION.apk"
# The package carries its real name only after every check has passed. Until then it is this file,
# which is removed however the script ends.
PENDING="$OUT_DIR/unverified.apk"
trap 'rm -f "$PENDING"' EXIT

# Signature schemes v2 and v3 only: the app needs Android 8.0, which does not use v1.
load_keystore_password
"$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" --ks-type PKCS12 --ks-key-alias "$KEY_ALIAS" --ks-pass env:YEW_KS_PASS \
    --min-sdk-version 26 \
    --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
    --out "$PENDING" "$UNSIGNED"
unset YEW_KS_PASS

# 1. The signature verifies and the certificate is the registered one.
VERIFY="$("$BUILD_TOOLS/apksigner" verify --verbose --print-certs --min-sdk-version 26 "$PENDING")" || fail "签名验证没有通过"
# Older build tools print "Signer #1 certificate SHA-256 digest", newer ones "V3.0 Signer: certificate SHA-256 digest".
ACTUAL="$(printf '%s\n' "$VERIFY" | sed -n 's/^.*Signer.*certificate SHA-256 digest: //p' | sort -u | tr 'a-f' 'A-F')"
[ "$ACTUAL" = "$EXPECTED" ] || fail "签名证书的 SHA-256 是 ${ACTUAL}，登记的是 ${EXPECTED}。"
printf '%s\n' "$VERIFY" | grep -q '^Number of signers: 1$' || fail "签名者不是恰好一个"
printf '%s\n' "$VERIFY" | grep -q '^Verified using v1 scheme (JAR signing): false' || fail "包里有 v1 签名"
printf '%s\n' "$VERIFY" | grep -q '^Verified using v2 scheme (APK Signature Scheme v2): true' || fail "包里没有 v2 签名"
printf '%s\n' "$VERIFY" | grep -q '^Verified using v3 scheme (APK Signature Scheme v3): true' || fail "包里没有 v3 签名"

# 2. The package is the app at this version, cannot be debugged, and connects over TLS only.
BADGING="$("$BUILD_TOOLS/aapt2" dump badging "$PENDING")" || fail "读不出包的信息"
printf '%s\n' "$BADGING" | grep -q "^package: name='${PACKAGE}' " || fail "包名不是 ${PACKAGE}"
printf '%s\n' "$BADGING" | grep -q "versionName='${VERSION}'" || fail "版本号不是 ${VERSION}"
if printf '%s\n' "$BADGING" | grep -q 'application-debuggable'; then fail "这个包可以调试"; fi
MANIFEST="$("$BUILD_TOOLS/aapt2" dump xmltree --file AndroidManifest.xml "$PENDING")" || fail "读不出包的清单"
printf '%s\n' "$MANIFEST" | grep -q 'usesCleartextTraffic.*=false' || fail "这个包没有关掉明文连接"
printf '%s\n' "$MANIFEST" | grep -q 'allowBackup.*=false' || fail "这个包没有关掉系统备份"

# 3. Its permissions are exactly the ones on this list.
OWN_PERMISSION="$PACKAGE.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
PERMISSIONS="$("$BUILD_TOOLS/aapt2" dump permissions "$PENDING")" || fail "读不出包的权限"
USED="$(printf '%s\n' "$PERMISSIONS" | sed -n "s/^uses-permission: name='\([^']*\)'.*$/\1/p" | sort)"
WANTED="$(printf '%s\n' \
    android.permission.INTERNET \
    android.permission.ACCESS_NETWORK_STATE \
    android.permission.CAMERA \
    android.permission.POST_NOTIFICATIONS \
    android.permission.FOREGROUND_SERVICE \
    android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING \
    android.permission.RECEIVE_BOOT_COMPLETED \
    android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS \
    "$OWN_PERMISSION" | sort)"
[ "$USED" = "$WANTED" ] || fail "这个包申请的权限和名单不一样：$(printf '%s' "$USED" | tr '\n' ' ')"
DECLARED="$(printf '%s\n' "$PERMISSIONS" | sed -n 's/^permission: //p' | sort)"
[ "$DECLARED" = "$OWN_PERMISSION" ] || fail "这个包声明的权限和名单不一样：$(printf '%s' "$DECLARED" | tr '\n' ' ')"
OTHER="$(printf '%s\n' "$PERMISSIONS" | grep -v -E '^(package: |uses-permission: |permission: )' || true)"
[ -z "$OTHER" ] || fail "权限清单里有没见过的内容：${OTHER}"

mv "$PENDING" "$APK"
(cd "$OUT_DIR" && shasum -a 256 "$(basename "$APK")" >SHA256SUMS)

echo
echo "正式包：${APK}"
echo "提交：$(git rev-parse HEAD)"
echo "证书 SHA-256：${ACTUAL}（和登记的一致）"
echo "权限："
printf '%s\n' "$PERMISSIONS" | sed 's/^/  /'
echo "SHA256SUMS："
sed 's/^/  /' "$OUT_DIR/SHA256SUMS"
echo
echo "这一步没有发布任何东西。对外放出前，要先做完签名密钥的备份和恢复演练，再对这个包做一次安全复核。"
