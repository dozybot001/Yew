#!/bin/bash
# Creates the signing key of Yew for Android. Run once, on the development Mac.
#
# The key cannot be replaced: an update signed with another key does not install over the app.
# The password is made here, goes straight into the login keychain and is never shown; it is not
# written to a file, a command's arguments or a log.
set -euo pipefail
umask 077

KEY_DIR="$HOME/.tenon-keys/android/yew"
KEYSTORE="$KEY_DIR/yew-release.p12"
KEY_ALIAS="yew"
KEYCHAIN_SERVICE="tenon-android-signing"
KEYCHAIN_ACCOUNT="yew"
# The comma in the company name is escaped so keytool does not read " Ltd." as another field.
DNAME='CN=Yew, O=Changsha Tenon Artificial Intelligence Technology Co.\, Ltd., L=Changsha, C=CN'
FINGERPRINT_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/release/signing-certificate.sha256"
JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}"
KEYTOOL="$JAVA_HOME/bin/keytool"

fail() {
    echo "create-signing-key: $1" >&2
    exit 1
}

[ ! -e "$KEYSTORE" ] || fail "the keystore already exists and is not overwritten: $KEYSTORE"
if security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; then
    fail "the login keychain already has an item for service $KEYCHAIN_SERVICE, account $KEYCHAIN_ACCOUNT; find out what it is before going on"
fi

mkdir -p "$KEY_DIR"
chmod 700 "$HOME/.tenon-keys" "$HOME/.tenon-keys/android" "$KEY_DIR"

# 32 random bytes from the system, as 43 characters of URL-safe base64.
YEW_KS_PASS="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
[ "${#YEW_KS_PASS}" -eq 43 ] || fail "no password was generated"
export YEW_KS_PASS

# Stored before the key exists, so there is never a keystore whose password is lost. `security -i`
# reads its command from standard input and printf is part of the shell, so the password is in no
# process's arguments.
printf 'add-generic-password -s %s -a %s -l "Yew Android signing key" -w %s\n' \
    "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" "$YEW_KS_PASS" | security -i
[ "$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w)" = "$YEW_KS_PASS" ] ||
    fail "the password did not reach the keychain"

# RSA 4096, valid for 30 years. In a PKCS12 keystore the key uses the keystore's password.
"$KEYTOOL" -genkeypair \
    -keystore "$KEYSTORE" -storetype PKCS12 -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10950 \
    -dname "$DNAME" -storepass:env YEW_KS_PASS
chmod 600 "$KEYSTORE"

certificate() {
    "$KEYTOOL" -exportcert -rfc -keystore "$KEYSTORE" -storetype PKCS12 -alias "$KEY_ALIAS" -storepass:env YEW_KS_PASS
}
fingerprint() {
    certificate | openssl x509 -noout -fingerprint "-$1" | sed 's/^.*=//; s/://g'
}

# The company name has to be in the certificate whole, comma included; it cannot be corrected later.
SUBJECT="$(certificate | openssl x509 -noout -subject -nameopt RFC2253)"
case "$SUBJECT" in
    *'O=Changsha Tenon Artificial Intelligence Technology Co.\, Ltd.'*) ;;
    *) fail "the company name in the certificate is not whole: $SUBJECT. Do not use this key; delete the keystore and the keychain item and start again." ;;
esac

SHA256="$(fingerprint sha256)"
SHA1="$(fingerprint sha1)"
MD5="$(fingerprint md5)"
# What the App filing asks for besides the MD5 fingerprint: the public key's modulus (hex).
MODULUS="$(certificate | openssl x509 -noout -modulus | sed 's/^Modulus=//')"
unset YEW_KS_PASS

mkdir -p "$(dirname "$FINGERPRINT_FILE")"
umask 022
printf '%s\n' "$SHA256" >"$FINGERPRINT_FILE"

echo "keystore: $KEYSTORE"
echo "subject: $SUBJECT"
echo "certificate fingerprints (not secret):"
echo "  SHA-256  $SHA256"
echo "  SHA-1    $SHA1"
echo "  MD5      $MD5"
echo "public key: RSA 4096, exponent 65537, modulus:"
echo "$MODULUS"
echo "wrote $FINGERPRINT_FILE"
echo "next: back the key up outside this Mac before anything signed with it is given out: a lost key means no updates to the installed app."
