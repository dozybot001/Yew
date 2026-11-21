#!/bin/bash
# Backs up the signing key of Yew for Android and proves the backup can be restored. Run before
# anything signed with the key is released or given to anyone else to install.
#
# Usage: backup-signing-key.sh <folder> [<another folder> ...]
#
# Each folder is a place for one copy of the backup; at least one must be off this Mac (a USB drive,
# or a folder in iCloud Drive that is not shared). Where they go is up to whoever keeps the key.
#
# Run it in a terminal you type into yourself. The image passphrase is read from the keyboard and
# must never be piped in, passed as an argument, or typed into an assistant's session.
#
# The backup is one AES-256 encrypted disk image holding the keystore, its password and a note of the
# fingerprints. The keystore password is written straight into the mounted image, so it never rests
# on the ordinary disk. The image's own passphrase is typed in by hand and stays nowhere on this Mac.
set -euo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/signing-common.sh"

[ $# -ge 1 ] || fail "用法：backup-signing-key.sh <放备份的文件夹> [<另一处的文件夹> ...]"
PLACES=()
for place in "$@"; do
    [ -d "$place" ] || fail "找不到文件夹：${place}"
    real="$(cd "$place" && pwd -P)"
    case "${real}/" in "$HOME/.tenon-keys/"*) fail "备份不能放在密钥目录里：${real}" ;; esac
    for seen in ${PLACES[@]+"${PLACES[@]}"}; do
        [ "$seen" != "$real" ] || fail "同一个文件夹写了两次：${real}"
    done
    PLACES+=("$real")
done
IMAGE_NAME="yew-android-signing-key-$(date +%Y%m%d).dmg"
# Checked before anything is made, so a run never stops with one place written and another refused.
OFF_THIS_DISK=""
for place in "${PLACES[@]}"; do
    [ ! -e "${place}/${IMAGE_NAME}" ] || fail "那里已经有同名的文件，不覆盖：${place}/${IMAGE_NAME}"
    case "$place" in */Mobile\ Documents/*) OFF_THIS_DISK=1 ;; esac
    [ "$(stat -f %d "$place")" = "$(stat -f %d "$HOME")" ] || OFF_THIS_DISK=1
done
[ -n "$OFF_THIS_DISK" ] || echo "提醒：给出的文件夹都和主目录在同一块盘上，也不在 iCloud 云盘里。这台 Mac 之外至少要有一份备份。"
[ -t 0 ] || fail "要在能直接打字的终端里运行：备份口令从键盘读，不经管道。"
[ -f "$KEYSTORE" ] || fail "找不到密钥库：${KEYSTORE}"
[ -f "$FINGERPRINT_FILE" ] || fail "找不到登记的证书指纹：${FINGERPRINT_FILE}"
EXPECTED="$(tr -d '[:space:]' <"$FINGERPRINT_FILE")"

IMAGE="$KEY_DIR/$IMAGE_NAME"
[ ! -e "$IMAGE" ] || fail "今天的备份映像已经存在，不覆盖：${IMAGE}"

echo "请在密码管理器里生成一个备份口令（不少于 20 个字符），存好，再抄一份到纸上。"
# IFS is emptied so a space at either end of what is typed is kept.
IFS= read -r -s -p "备份口令：" BACKUP_PASS
echo
IFS= read -r -s -p "再输一次：" BACKUP_PASS_AGAIN
echo
[ "$BACKUP_PASS" = "$BACKUP_PASS_AGAIN" ] || fail "两次输入的不一样"
[ "${#BACKUP_PASS}" -ge 20 ] || fail "备份口令不少于 20 个字符"
unset BACKUP_PASS_AGAIN

MOUNT="$(mktemp -d)"
DRILL="$(mktemp -d)"
DONE=""
cleanup() {
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
    hdiutil detach "$DRILL" >/dev/null 2>&1 || true
    rmdir "$MOUNT" "$DRILL" 2>/dev/null || true
    # An image that did not pass the restore drill is not left behind to be mistaken for a backup.
    [ -n "$DONE" ] || rm -f "$IMAGE"
}
trap cleanup EXIT

# 1. An empty encrypted image, then the three files written into it while it is mounted.
printf '%s' "$BACKUP_PASS" | hdiutil create -size 16m -fs APFS -volname YewSigningKey -encryption AES-256 -stdinpass "$IMAGE" >/dev/null
printf '%s' "$BACKUP_PASS" | hdiutil attach "$IMAGE" -stdinpass -nobrowse -mountpoint "$MOUNT" >/dev/null

load_keystore_password
# Worked out before the note is written: a command that fails inside a here-document does not stop the script.
NOTE_TIME="$(date '+%Y-%m-%d %H:%M')"
CERT="$(certificate_of "$KEYSTORE")"
NOTE_SHA256="$(printf '%s\n' "$CERT" | fingerprint sha256)"
NOTE_SHA1="$(printf '%s\n' "$CERT" | fingerprint sha1)"
NOTE_MD5="$(printf '%s\n' "$CERT" | fingerprint md5)"
[ "$NOTE_SHA256" = "$EXPECTED" ] || fail "这台 Mac 上的密钥库和登记的指纹对不上：${NOTE_SHA256}。不要备份它，先弄清楚。"
cp "$KEYSTORE" "$MOUNT/$KEYSTORE_NAME"
printf '%s\n' "$YEW_KS_PASS" >"$MOUNT/keystore-password.txt"
cat >"$MOUNT/README.txt" <<NOTE
Yew 安卓版的应用签名密钥。备份于 ${NOTE_TIME}。

${KEYSTORE_NAME}        PKCS12 密钥库，别名 ${KEY_ALIAS}
keystore-password.txt   密钥库的口令

证书指纹：
SHA-256  ${NOTE_SHA256}
SHA-1    ${NOTE_SHA1}
MD5      ${NOTE_MD5}

恢复：把 ${KEYSTORE_NAME} 放回 ~/.tenon-keys/android/yew/（目录 0700，文件 0600），
把口令存进登录钥匙串（服务 ${KEYCHAIN_SERVICE}，账户 ${KEYCHAIN_ACCOUNT}），
再用 keytool -list -v 核对 SHA-256 指纹和上面一致。
NOTE
unset YEW_KS_PASS
hdiutil detach "$MOUNT" >/dev/null
chmod 600 "$IMAGE"

# 2. Restore drill: open the image again read-only and use what is inside it, both the certificate
#    and the private key. Reading the certificate alone would pass with a damaged private key.
printf '%s' "$BACKUP_PASS" | hdiutil attach "$IMAGE" -stdinpass -nobrowse -readonly -mountpoint "$DRILL" >/dev/null
unset BACKUP_PASS
YEW_KS_PASS="$(tr -d '\n' <"$DRILL/keystore-password.txt")"
export YEW_KS_PASS
RESTORED_CERT="$(certificate_of "$DRILL/$KEYSTORE_NAME")"
# The private key signs a certificate request.
REQUEST="$("$KEYTOOL" -certreq -keystore "$DRILL/$KEYSTORE_NAME" -storetype PKCS12 -alias "$KEY_ALIAS" -storepass:env YEW_KS_PASS)"
unset YEW_KS_PASS
hdiutil detach "$DRILL" >/dev/null

RESTORED="$(printf '%s\n' "$RESTORED_CERT" | fingerprint sha256)"
[ "$RESTORED" = "$EXPECTED" ] || fail "恢复演练没有通过：备份里的证书指纹是 ${RESTORED}，登记的是 ${EXPECTED}。不要用这份备份。"
# The request's signature has to verify. The system's openssl (LibreSSL) exits with 0 even when it
# does not, so the words it prints are what is checked.
REQUEST_CHECK="$(printf '%s\n' "$REQUEST" | openssl req -noout -verify 2>&1 || true)"
printf '%s\n' "$REQUEST_CHECK" | grep -q 'verify OK' || fail "恢复演练没有通过：备份里的私钥签出来的请求验签失败。不要用这份备份。"
# And the key that signed it has to be the one in the registered certificate.
REQUEST_KEY="$(printf '%s\n' "$REQUEST" | openssl req -noout -pubkey)"
CERT_KEY="$(printf '%s\n' "$RESTORED_CERT" | openssl x509 -noout -pubkey)"
[ -n "$REQUEST_KEY" ] && [ "$REQUEST_KEY" = "$CERT_KEY" ] || fail "恢复演练没有通过：备份里的私钥和证书不是一对。不要用这份备份。"
echo "恢复演练通过：从备份打开密钥库，用里面的私钥签名并验签成功；证书 SHA-256 指纹是 ${RESTORED}，和登记的一致。"

# 3. The same image to every place, each copy compared with the original byte for byte.
for place in "${PLACES[@]}"; do
    copy="${place}/${IMAGE_NAME}"
    cp "$IMAGE" "$copy"
    cmp -s "$IMAGE" "$copy" || fail "复制出去的映像和原件不一样：${copy}"
    echo "已复制到：${copy}"
done
DONE=1
echo "备份映像：${IMAGE_NAME}，SHA-256 $(shasum -a 256 "$IMAGE" | cut -d' ' -f1)"
echo "这台 Mac 上的原件留在 ${IMAGE}；它和密钥在同一块盘上，只防误删。"
echo "备份口令在密码管理器里，另有一份纸质的，和 U 盘分开放。用了 iCloud 云盘的话，那个文件夹不要设成共享，并等它上传完。"
