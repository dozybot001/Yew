// The release check for npm audit. Production dependencies get no waivers: any high or critical
// advisory there stops the release. One in a tool used only to build or test may be waived while no
// fixed release exists, for a month at most, recorded below with its advisory, the packages, why
// only the build or the tests reach it, and the day the waiver ends. Upgrade before that day; if
// there is still no fix, check again and set a new day. An expired waiver stops the release.
//
//   npm run audit:gate
import { spawnSync } from "node:child_process";

export const WAIVERS = {
	"GHSA-fc5q-39xc-vjpf": {
		packages: "picomatch <=4.0.7, through vite, tinyglobby, fdir and @vitejs/plugin-react",
		reason:
			"ReDoS through repeated extglobs, with no fixed release yet. Only vite reaches it, while it builds the web interface on our own computer, matching the patterns in our own configuration. None of these packages is in the npm package or the Android package.",
		until: "2026-12-18",
	},
};

const SEVERE = new Set(["high", "critical"]);

function audit(args) {
	const run = spawnSync("npm", ["audit", "--json", ...args], { encoding: "utf8" });
	try {
		const report = JSON.parse(run.stdout);
		if (report.error) throw new Error(report.error.summary ?? JSON.stringify(report.error));
		return report;
	} catch (error) {
		console.error(
			`audit-gate: npm audit ${args.join(" ")} gave no report: ${error.message}\n${run.stderr}`,
		);
		process.exit(1);
	}
}

/** The high and critical advisories in a report, by their GHSA id. */
function severe(report) {
	const found = new Map();
	for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
		for (const source of vulnerability.via) {
			if (typeof source !== "object" || !SEVERE.has(source.severity)) continue;
			const id = String(source.url ?? source.source)
				.split("/")
				.pop();
			found.set(id, `${source.name} ${source.range}: ${source.title} (${source.url})`);
		}
	}
	return found;
}

const production = severe(audit(["--omit=dev"]));
if (production.size > 0) {
	for (const line of production.values())
		console.error(`audit-gate: production dependency: ${line}`);
	console.error("audit-gate: production dependencies are never waived; fix these first");
	process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const blocking = [];
for (const [id, line] of severe(audit([]))) {
	const waiver = WAIVERS[id];
	if (waiver && today <= waiver.until)
		console.log(`audit-gate: waived until ${waiver.until}: ${line}`);
	else blocking.push(waiver ? `${line}; the waiver ended ${waiver.until}` : line);
}
for (const line of blocking) console.error(`audit-gate: ${line}`);
if (blocking.length > 0) process.exit(1);
console.log("audit-gate: no high or critical advisory left without a waiver");
