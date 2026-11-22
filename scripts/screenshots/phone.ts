import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { BUNDLE_ID, type Lang, log, pause, ROOT, type Theme } from "./shared.ts";
import type { Yew } from "./yew.ts";

// --- the phone ---

export interface Simulator {
	udid: string;
}

const SIMULATOR = "Yew screenshots";
const IPHONE_17_PRO = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";

export const simctl = (...args: string[]) =>
	execFileSync("xcrun", ["simctl", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

/**
 * A simulator of the script's own, so none of the person's simulators or the apps on them change: an
 * iPhone 17 Pro on the iOS version of theirs (or the newest), in US English so the status bar reads
 * 9:41 (in a 24-hour region it reads 09:41), showing full signal and a full battery. It is deleted at
 * the end.
 */
export function startSimulator(): Simulator {
	const list = JSON.parse(simctl("list", "--json")) as {
		devices: Record<string, { udid: string; name: string; isAvailable?: boolean }[]>;
		runtimes: {
			identifier: string;
			platform?: string;
			isAvailable: boolean;
			supportedDeviceTypes?: { identifier: string }[];
		}[];
	};
	// One left over from a run that was cut short.
	for (const device of Object.values(list.devices).flat()) {
		if (device.name === SIMULATOR) simctl("delete", device.udid);
	}
	const theirs = Object.entries(list.devices).find(([, devices]) =>
		devices.some((device) => device.name === "iPhone 17 Pro" && device.isAvailable !== false),
	)?.[0];
	const newest = list.runtimes
		.filter(
			(runtime) =>
				runtime.isAvailable &&
				runtime.platform === "iOS" &&
				runtime.supportedDeviceTypes?.some((type) => type.identifier === IPHONE_17_PRO),
		)
		.at(-1)?.identifier;
	const runtime = theirs ?? newest;
	if (!runtime)
		throw new Error("No iOS simulator runtime runs an iPhone 17 Pro. Add one in Xcode.");
	const udid = simctl("create", SIMULATOR, IPHONE_17_PRO, runtime).trim();
	const boot = () => {
		simctl("boot", udid);
		simctl("bootstatus", udid, "-b");
	};
	boot();
	simctl("spawn", udid, "defaults", "write", "-g", "AppleLocale", "-string", "en_US");
	simctl("spawn", udid, "defaults", "write", "-g", "AppleLanguages", "-array", "en");
	simctl("shutdown", udid);
	boot();
	const time = new Date();
	time.setHours(9, 41, 0, 0);
	simctl(
		"status_bar",
		udid,
		"override",
		"--time",
		time.toISOString(),
		"--dataNetwork",
		"wifi",
		"--wifiMode",
		"active",
		"--wifiBars",
		"3",
		"--cellularMode",
		"active",
		"--cellularBars",
		"4",
		"--batteryState",
		"discharging",
		"--batteryLevel",
		"100",
	);
	return { udid };
}

export function stopSimulator(simulator: Simulator): void {
	try {
		simctl("shutdown", simulator.udid);
	} catch {
		// It had stopped already.
	}
	simctl("delete", simulator.udid);
}

/** The Debug build of the iPhone app for the simulator. Xcode's output is shown only if it fails. */
export function buildApp(folder: string): string {
	log("Building the iPhone app (Debug, simulator)…");
	const derived = join(folder, "DerivedData");
	try {
		execFileSync(
			"xcodebuild",
			[
				"-project",
				join(ROOT, "ios/Yew.xcodeproj"),
				"-scheme",
				"Yew",
				"-configuration",
				"Debug",
				"-destination",
				"generic/platform=iOS Simulator",
				"-derivedDataPath",
				derived,
				"build",
			],
			{ stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
		);
	} catch (error) {
		const { stdout = "", stderr = "" } = error as {
			stdout?: Buffer | string;
			stderr?: Buffer | string;
		};
		log(`${stdout}${stderr}`.split("\n").slice(-40).join("\n"));
		throw new Error("The iPhone app did not build.");
	}
	return join(derived, "Build/Products/Debug-iphonesimulator/Yew.app");
}

/**
 * Takes the phone pictures of one language. The app shows how long ago each request came, rounded to
 * whole minutes after the first one: "2 min. ago" from 90 seconds to 150. Both pictures are taken while
 * both requests read the same, two minutes or the first number of minutes that leaves time for both.
 */
export async function phonePictures(
	simulator: Simulator,
	app: Yew,
	lang: Lang,
	asked: { first: number; last: number },
	out: (theme: Theme) => string,
): Promise<void> {
	const needed = 30_000;
	for (let minutes = 2; ; minutes++) {
		const start = Math.max(Date.now(), asked.last + (minutes - 0.5) * 60_000 + 1000);
		if (start + needed - asked.first < (minutes + 0.5) * 60_000) {
			await pause(start - Date.now());
			break;
		}
	}
	for (const theme of ["light", "dark"] as const) {
		simctl("ui", simulator.udid, "appearance", theme);
		try {
			simctl("terminate", simulator.udid, BUNDLE_ID);
		} catch {
			// It was not running.
		}
		simctl(
			"launch",
			simulator.udid,
			BUNDLE_ID,
			"-YewReset",
			"YES",
			"-YewDirectLink",
			app.link(),
			"-YewTab",
			"approvals",
			"-AppleLanguages",
			lang === "zh" ? "(zh-Hans)" : "(en)",
			"-AppleLocale",
			lang === "zh" ? "zh_CN" : "en_US",
		);
		await pause(6000);
		simctl("io", simulator.udid, "screenshot", "--type", "png", out(theme));
	}
	simctl("terminate", simulator.udid, BUNDLE_ID);
}
