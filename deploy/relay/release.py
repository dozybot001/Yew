"""Verifies the immutable relay bundle, tests a candidate, then replaces the running relay.

Run as root on the server by release-from-gitee.sh. The relay keeps no data, so there is nothing
to back up; a release swaps the container and, the first time, installs the Caddy site. A failure
at any step puts the previous container and ingress back.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

sha, image, bundle_path = sys.argv[1], sys.argv[2], sys.argv[3]
assert re.fullmatch("[0-9a-f]{40}", sha)

PORT = 7290
UID = 70980  # no account on the host has it, and no other container on the server uses it
HOST = "relay.tenonai.cn"
base = pathlib.Path("/opt/yew-relay")
config = base / "config"
env_file = config / "relay.env"
key_file = config / "apns.p8"
release = base / "releases" / sha
active = base / "active.json"
site = pathlib.Path("/etc/caddy/sites-enabled/yew-relay.caddy")
name = f"yew-relay-{sha[:12]}"
candidate = f"{name}-candidate"
prefix = "yew-relay-"


def run(args, **kw):
    return subprocess.run(args, check=True, **kw)


def quiet(args):
    return subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


def put(path, data):
    temp = path.with_suffix(".candidate")
    temp.write_bytes(data)
    os.replace(temp, path)


def health(url, hsts=False):
    with urllib.request.urlopen(url, timeout=5) as response:
        assert response.status == 200 and response.read() == b"ok", "The relay is not healthy"
        assert response.headers.get("X-Content-Type-Options") == "nosniff", "Security headers missing"
        if hsts:
            assert "max-age=31536000" in (response.headers.get("Strict-Transport-Security") or ""), "HSTS missing"


def retry(check, attempts, pause):
    for attempt in range(attempts):
        try:
            return check()
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(pause)


def container(container_name, publish):
    args = [
        "docker", "run", "-d", "--name", container_name,
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", f"{UID}:{UID}", "--memory", "512m", "--cpus", "0.5", "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        "--mount", f"type=bind,src={release}/app,dst=/app,readonly",
        "--workdir", "/app", "--env-file", str(env_file),
        "--env", "HOST=0.0.0.0", "--env", f"PORT={PORT}", "--env", "TRUST_PROXY=1",
    ]
    if key_file.exists():
        args += ["--mount", f"type=bind,src={key_file},dst=/run/secrets/apns.p8,readonly"]
    if publish:
        # Its own bridge network keeps it away from other containers; the port is on 127.0.0.1 only.
        args += [
            "--restart", "unless-stopped", "--network", "yew-relay",
            "--publish", f"127.0.0.1:{PORT}:{PORT}",
            "--log-driver", "journald", "--log-opt", "tag=yew-relay",
        ]
    else:
        args += ["--network", "none"]
    run(args + [image, "node", "relay/main.ts"], stdout=subprocess.DEVNULL)


def containers():
    return run(["docker", "ps", "-a", "--format", "{{.Names}}"], capture_output=True, text=True).stdout.split()


lock = base / ".publish-lock"
lock.mkdir()
previous = json.loads(active.read_text()) if active.exists() else {}
site_before = site.read_bytes() if site.exists() else None
started = previous_stopped = site_changed = False
try:
    # Private configuration: the environment file is root's, the signing key is readable by the
    # relay's user alone. Neither is in the repository or the release.
    config.mkdir(mode=0o700, exist_ok=True)
    if not env_file.exists():
        env_file.touch(mode=0o600)
    assert env_file.stat().st_mode & 0o777 == 0o600, "relay.env must be 0600"
    if key_file.exists():
        meta = key_file.stat()
        assert meta.st_uid == UID and meta.st_mode & 0o777 == 0o400, "apns.p8 must be 0400 and owned by the relay's user"

    if not release.exists():
        release.mkdir(parents=True)
        with tarfile.open(bundle_path) as bundle:
            bundle.extractall(release, filter="data")
    manifest = json.loads((release / "manifest.json").read_text())
    assert manifest["commit"] == sha
    actual = {
        str(p.relative_to(release)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in release.rglob("*")
        if p.is_file() and p != release / "manifest.json"
    }
    assert actual == manifest["files"], "Release checksum mismatch"
    for p in release.rglob("*"):
        p.chmod(0o555 if p.is_dir() else 0o444)
    release.chmod(0o555)

    if previous.get("commit") == sha and site.exists():
        health(f"https://{HOST}/health", hsts=True)
        print("This relay release is already active.")
        sys.exit()

    # The candidate runs without a network: it must start and answer on its own loopback.
    quiet(["docker", "rm", "-f", candidate])
    container(candidate, publish=False)
    probe = f"fetch('http://127.0.0.1:{PORT}/health').then(r=>r.text()).then(t=>process.exit(t==='ok'?0:1),()=>process.exit(1))"
    try:
        retry(lambda: run(["docker", "exec", candidate, "node", "-e", probe]), 20, 0.5)
        logs = subprocess.run(["docker", "logs", candidate], capture_output=True, text=True)
        wanted = "notifications on" if key_file.exists() else "notifications off"
        assert wanted in logs.stderr + logs.stdout, f"The candidate did not start with {wanted}"
    finally:
        quiet(["docker", "rm", "-f", candidate])

    # The new site file is checked through the root config, which defines the shared snippets,
    # with the sites as they will be.
    site_text = (release / site.name).read_text()
    sites = base / "candidate-sites"
    shutil.rmtree(sites, ignore_errors=True)
    shutil.copytree(site.parent, sites)
    (sites / site.name).write_text(site_text)
    line = "import /etc/caddy/sites-enabled/*.caddy"
    root = pathlib.Path("/etc/caddy/Caddyfile").read_text()
    assert root.count(line) == 1, "Unexpected Caddy root config"
    check = base / "candidate-Caddyfile"
    check.write_text(root.replace(line, f"import {sites}/*.caddy"))
    run(["caddy", "validate", "--config", str(check), "--adapter", "caddyfile"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # The relay holds only connections: the old one stops and the new one takes the port. Macs and
    # phones reconnect by themselves within seconds.
    if quiet(["docker", "network", "inspect", "yew-relay"]):
        run(["docker", "network", "create", "yew-relay"], stdout=subprocess.DEVNULL)
    if previous.get("container"):
        run(["docker", "stop", previous["container"]], stdout=subprocess.DEVNULL)
        previous_stopped = True
    quiet(["docker", "rm", "-f", name])
    container(name, publish=True)
    started = True
    retry(lambda: health(f"http://127.0.0.1:{PORT}/health"), 20, 0.5)

    if site_before != site_text.encode():
        site_changed = True
        put(site, site_text.encode())
        run(["systemctl", "reload", "caddy"])
    # The first time, Caddy gets the certificate before the public check can pass.
    retry(lambda: health(f"https://{HOST}/health", hsts=True), 30, 3)

    state = {
        "commit": sha, "previous": previous.get("commit"), "previous_container": previous.get("container"),
        "port": PORT, "container": name, "image": image,
    }
    put(active, json.dumps(state).encode())
    print(f"Yew relay deployed and the public health check passed: {sha}")
except BaseException:
    if started:
        quiet(["docker", "rm", "-f", name])
    if previous_stopped:
        run(["docker", "start", previous["container"]], stdout=subprocess.DEVNULL)
    if site_changed:
        if site_before is None:
            site.unlink(missing_ok=True)
        else:
            put(site, site_before)
        run(["systemctl", "reload", "caddy"])
    raise
finally:
    # The copies made for validation hold other products' site files; they do not stay.
    shutil.rmtree(base / "candidate-sites", ignore_errors=True)
    (base / "candidate-Caddyfile").unlink(missing_ok=True)
    lock.rmdir()

# Housekeeping after an accepted release never fails it: keep the current release, the previous
# one and the three newest; remove the containers of the rest.
try:
    keep = {sha, previous.get("commit")}
    releases = sorted((base / "releases").iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    keep |= {p.name for p in releases[:3]}
    kept = {prefix + commit[:12] for commit in keep if commit}
    for old in releases:
        if old.name in keep:
            continue
        quiet(["docker", "rm", "-f", prefix + old.name[:12]])
        run(["chmod", "-R", "u+w", str(old)])
        shutil.rmtree(old)
    for line in containers():
        if line.startswith(prefix) and line not in kept:
            quiet(["docker", "rm", "-f", line])
except Exception as error:  # noqa: BLE001
    print(f"Release retention skipped: {error}", file=sys.stderr)
