#!/usr/bin/env bash
# Server controller, run as root by deploy/relay/publish.sh. It fetches the public repository from
# Gitee over HTTPS without credentials, checks that main is exactly the commit asked for, and builds
# the release only from that checkout.
set -Eeuo pipefail
# The body is a function so bash reads it completely from the SSH stdin before running, and no
# child process can consume the rest of the script.
main() {
	release="${1:-}"
	[[ "$release" =~ ^[0-9a-f]{40}$ ]] || { echo 'usage: <commit>' >&2; exit 2; }
	base=/opt/yew-relay
	builder="$base/builder"
	source="$builder/source.git"
	repo=https://gitee.com/dozybot/yew.git
	node_image='docker.m.daocloud.io/library/node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7'
	install -d -m 0750 "$base"
	exec 9>"$base/.controller-lock"
	flock -n 9 || { echo 'Another Yew relay release is running.' >&2; exit 1; }
	install -d -m 0750 "$base" "$builder"

	[[ -d "$source" ]] || git clone -q --bare "$repo" "$source"
	git --git-dir="$source" remote set-url origin "$repo"
	# Bounded retries absorb short outages; a failure stops before production changes.
	for attempt in 1 2 3 4; do
		git --git-dir="$source" fetch -q origin +refs/heads/main:refs/heads/main && break
		(( attempt < 4 )) || { echo 'Unable to fetch Gitee main.' >&2; exit 1; }
		sleep $(( attempt * 3 ))
	done
	fetched="$(git --git-dir="$source" rev-parse refs/heads/main)"
	[[ "$fetched" == "$release" ]] || { echo "Gitee main is $fetched, not the requested $release." >&2; exit 1; }

	stage="$(mktemp -d)"
	trap 'rm -rf "$stage"' EXIT
	# The relay and the three protocol files it shares with Yew on the Mac; nothing else.
	git --git-dir="$source" archive "$release" relay src/remote/protocol.ts src/remote/push.ts \
		src/remote/noise.ts deploy/relay | tar -x -C "$stage"
	# Install the exact locked dependencies in the pinned runtime image, without host secrets.
	docker run --rm --cap-drop ALL --security-opt no-new-privileges \
		--mount "type=bind,src=$stage/relay,dst=/app" --workdir /app --env npm_config_cache=/tmp/npm-cache \
		"$node_image" npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
	bundle="$stage/bundle"
	mkdir -p "$bundle/app/src"
	cp -R "$stage/relay" "$bundle/app/relay"
	cp -R "$stage/src/remote" "$bundle/app/src/remote"
	cp "$stage/deploy/relay/yew-relay.caddy" "$bundle/"
	python3 - "$bundle" "$release" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]); files = {}
for p in root.rglob('*'):
    if p.is_symlink() or p.suffix == '.node': raise SystemExit('Only regular portable dependencies are supported')
    if p.is_file(): files[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
(root / 'manifest.json').write_text(json.dumps({'commit': sys.argv[2], 'files': files}))
PY
	# The bundle stays in the private staging folder, which is removed when this script ends.
	tar --no-xattrs -czf "$stage/bundle.tar.gz" -C "$bundle" app yew-relay.caddy manifest.json
	python3 "$stage/deploy/relay/release.py" "$release" "$node_image" "$stage/bundle.tar.gz"
}
main "$@" </dev/null
