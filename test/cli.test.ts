import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { run } from "../src/cli/run.ts";
import { VERSION } from "../src/shared/version.ts";
import { fakeIo } from "./helpers/io.ts";

const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

describe("yew cli", () => {
	test("--version prints version, publisher and website to stdout", async () => {
		const { io, stdout, stderr } = fakeIo();
		assert.equal(await run(["--version"], io), 0);
		assert.equal(stdout.text(), `Yew Harness ${VERSION}\nTenon AI · https://tenonai.cn/\n`);
		assert.equal(stderr.text(), "");
	});

	test("--version --json prints one JSON object", async () => {
		const { io, stdout } = fakeIo();
		assert.equal(await run(["-v", "--json"], io), 0);
		assert.deepEqual(JSON.parse(stdout.text()), {
			name: "yew",
			version: VERSION,
			publisher: "Tenon AI",
			website: "https://tenonai.cn/",
		});
	});

	test("no arguments and --help print the definition and usage", async () => {
		for (const argv of [[], ["--help"], ["-h"]]) {
			const { io, stdout } = fakeIo();
			assert.equal(await run(argv, io), 0);
			// The one-line definition, as everywhere else.
			assert.match(stdout.text(), /^Yew Harness \S+\nAn AI-native multi-agent workbench\.\n/);
			assert.match(stdout.text(), /Usage: yew <command>/);
		}
	});

	test("unknown command and unknown option exit with 2 and write to stderr", async () => {
		for (const argv of [["nope"], ["--nope"]]) {
			const { io, stdout, stderr } = fakeIo();
			assert.equal(await run(argv, io), 2);
			assert.equal(stdout.text(), "");
			assert.match(stderr.text(), /^yew: .+\nRun 'yew --help' for usage\.\n$/);
		}
	});

	test("no ANSI colors when NO_COLOR is set, even on a terminal", async () => {
		const { io, stdout } = fakeIo({ tty: true, env: { NO_COLOR: "1" } });
		await run(["--help"], io);
		assert.ok(!stdout.text().includes("\u001b["));
	});

	test("colors on a terminal without NO_COLOR", async () => {
		const { io, stdout } = fakeIo({ tty: true, env: {} });
		await run(["--help"], io);
		assert.ok(stdout.text().includes("\u001b["));
	});

	test("the entry point runs under plain node", async () => {
		const { stdout } = await promisify(execFile)(process.execPath, [main, "--version"]);
		assert.match(stdout, /^Yew Harness \d+\.\d+\.\d+/);
	});
});
