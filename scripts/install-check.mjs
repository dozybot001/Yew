// The release check for what a person installs.
// npm applies `overrides` in this repository only, so the audit of its lock file says nothing about a
// global install. This packs Yew as `npm publish` does and checks:
// - the sandbox-runtime bundled in the package is the one the registry publishes, file for file, so
//   nothing changed in node_modules after `npm ci` goes out with it;
// - installed globally into a throwaway prefix (no install scripts run), the system sandbox gets the
//   zod the lock file pins, and no high or critical advisory remains in what was installed;
// - packed on macOS, it carries the Mac app's program (dist/mac/Yew, both architectures), so
//   `yew app install` makes the window app and not the launcher that opens the browser.
//
//   npm run audit:install
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		console.error(`install-check: ${command} ${args.join(" ")} failed\n${result.stderr}`);
		process.exit(1);
	}
	return result.stdout;
}

/** Every file under a folder, by its path inside it, with the SHA-256 of its content. */
function files(folder) {
	const found = new Map();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else
				found.set(
					relative(folder, path),
					createHash("sha256").update(readFileSync(path)).digest("hex"),
				);
		}
	};
	walk(folder);
	return found;
}

/** Unpacks a tarball into a new folder of `work`; returns the folder. */
function unpack(work, tarball, name) {
	const folder = join(work, name);
	mkdirSync(folder);
	run("tar", ["-xzf", join(work, tarball), "-C", folder]);
	return folder;
}

const work = mkdtempSync(join(tmpdir(), "yew-install-check-"));
try {
	const tarball = run("npm", ["pack", "--pack-destination", work, "--silent"], root)
		.trim()
		.split("\n")
		.pop();
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

	// The bundled sandbox-runtime against the registry's tarball of the version the lock file pins.
	const runtime = "@anthropic-ai/sandbox-runtime";
	const version = lock.packages[`node_modules/${runtime}`]?.version;
	const upstream = run(
		"npm",
		["pack", `${runtime}@${version}`, "--pack-destination", work, "--ignore-scripts", "--silent"],
		work,
	)
		.trim()
		.split("\n")
		.pop();
	const theirs = files(join(unpack(work, upstream, "upstream"), "package"));
	const ours = files(join(unpack(work, tarball, "ours"), "package", "node_modules", runtime));
	const differ = [...new Set([...theirs.keys(), ...ours.keys()])].filter(
		(path) => theirs.get(path) !== ours.get(path),
	);
	if (differ.length > 0) {
		console.error(
			`install-check: the bundled ${runtime} differs from the registry's ${version} in ${differ.length} file(s): ${differ.slice(0, 10).join(", ")}`,
		);
		process.exit(1);
	}

	if (process.platform === "darwin") {
		const program = join(work, "ours", "package", "dist", "mac", "Yew");
		const kinds = existsSync(program)
			? run("lipo", ["-archs", program], work).trim().split(" ")
			: [];
		if (!kinds.includes("arm64") || !kinds.includes("x86_64")) {
			console.error(
				"install-check: the package has no Mac app program for arm64 and x86_64 (dist/mac/Yew); run npm run build:mac",
			);
			process.exit(1);
		}
	}

	const prefix = join(work, "prefix");
	run(
		"npm",
		[
			"install",
			"-g",
			"--prefix",
			prefix,
			join(work, tarball),
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
		],
		work,
	);
	const installed = join(prefix, "lib", "node_modules", "@tenonai", "yew");

	const pinned = lock.packages["node_modules/zod"]?.version;
	const sandbox = createRequire(
		join(installed, "node_modules", "@anthropic-ai", "sandbox-runtime", "package.json"),
	);
	const got = JSON.parse(readFileSync(sandbox.resolve("zod/package.json"), "utf8")).version;
	if (got !== pinned) {
		console.error(`install-check: the sandbox gets zod ${got}; the lock file pins ${pinned}`);
		process.exit(1);
	}

	// npm audit needs a lock file: one written from what was installed, bundled packages included.
	run(
		"npm",
		["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
		installed,
	);
	const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
		cwd: installed,
		encoding: "utf8",
	});
	const report = JSON.parse(audit.stdout || "{}");
	if (!report.metadata) {
		console.error(`install-check: npm audit gave no report\n${audit.stderr}`);
		process.exit(1);
	}
	const severe = Object.entries(report.vulnerabilities ?? {}).filter(([, entry]) =>
		["high", "critical"].includes(entry.severity),
	);
	if (severe.length > 0) {
		for (const [name, entry] of severe) console.error(`install-check: ${entry.severity}: ${name}`);
		process.exit(1);
	}
	console.log(
		`install-check: ${tarball}: the bundled ${runtime} matches the registry's ${version} (${ours.size} files); installed, the sandbox gets zod ${got}; no high or critical advisory in what was installed`,
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
