#!/usr/bin/env bash
# Publishes Yew's relay. The exact clean main commit is pushed to Gitee first; the server then
# fetches that commit and builds the release itself. Nothing is uploaded from this Mac. Run it as:
# npm run relay:publish
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
[[ "$(git symbolic-ref --short HEAD)" == main ]] || { echo 'Publish from main.' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit the complete release before publishing.' >&2; exit 1; }
release="$(git rev-parse HEAD)"
# A secret scan over the whole history, a dependency audit and the checks block a release.
gitleaks git --no-banner --redact --log-level warn .
npm audit --prefix relay --omit=dev --audit-level=high
npm run check >/dev/null
# origin pushes to Gitee and GitHub. Only Gitee carries the release; GitHub is a mirror.
git push origin main || echo 'A push reported an error; checking Gitee.' >&2
gitee="$(git ls-remote https://gitee.com/dozybot/yew.git refs/heads/main | cut -f1)"
[[ "$gitee" == "$release" ]] || { echo "Gitee main is ${gitee:-unreadable}, not $release." >&2; exit 1; }
# The server's host key comes from the repository, never a scan. The server fetches the public
# repository from Gitee over HTTPS, so it holds no key for it.
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o HostKeyAlias=wesaid-prod \
	-o UserKnownHostsFile=deploy/relay/known_hosts \
	wesaid-prod sudo -n bash -s -- "$release" < deploy/relay/release-from-gitee.sh
