// Checks the libraries that go into the released app against the OSV vulnerability database
// (osv.dev): the release runtime classpath in app/gradle.lockfile, by name and version. Only library
// names and versions are sent. Run before every release; exits with 1 if anything is reported.
//   node android/scripts/check-vulnerabilities.ts
import { readFileSync } from "node:fs";

const lockfile = new URL("../app/gradle.lockfile", import.meta.url);
const packages = readFileSync(lockfile, "utf8")
	.split("\n")
	.filter((line) => !line.startsWith("#") && line.split("=")[1]?.split(",").includes("releaseRuntimeClasspath"))
	.map((line) => {
		const [group, name, version] = (line.split("=")[0] as string).split(":");
		return { name: `${group}:${name}`, version: version as string };
	});

const response = await fetch("https://api.osv.dev/v1/querybatch", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		queries: packages.map(({ name, version }) => ({ package: { ecosystem: "Maven", name }, version })),
	}),
	signal: AbortSignal.timeout(60_000),
});
if (!response.ok) {
	process.stderr.write(`check-vulnerabilities: OSV answered ${response.status}\n`);
	process.exit(2);
}
const { results } = (await response.json()) as { results: { vulns?: { id: string }[] }[] };
if (results.length !== packages.length) {
	process.stderr.write("check-vulnerabilities: OSV did not answer for every library\n");
	process.exit(2);
}
let found = 0;
results.forEach((result, index) => {
	for (const vulnerability of result.vulns ?? []) {
		found += 1;
		process.stdout.write(`${packages[index]?.name} ${packages[index]?.version}: ${vulnerability.id}\n`);
	}
});
process.stdout.write(`${packages.length} libraries checked, ${found} known vulnerabilities\n`);
process.exit(found > 0 ? 1 : 0);
