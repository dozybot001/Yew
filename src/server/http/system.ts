import { Hono } from "hono";
import { conflict } from "../errors.ts";
import { optBoolean, readJson } from "./input.ts";
import type { AppEnv } from "./problem.ts";

/** Starting Yew at login and the launcher icon, as the settings show them. */
export interface SystemStatus {
	startAtLogin: {
		/** False where `yew service` does not work (it needs macOS or Linux). */
		supported: boolean;
		on: boolean;
		/** The LaunchAgent or systemd unit; null where it is not supported. */
		file: string | null;
	};
	launcher: {
		/** False where `yew app` does not work (it needs macOS). */
		supported: boolean;
		on: boolean;
		/** Where the launcher is or would be; null where it is not supported. */
		path: string | null;
	};
}

/**
 * What the routes change on the system. The real one is built from the functions behind
 * `yew service` and `yew app` (`src/cli/system.ts`); tests give it stand-in hosts.
 */
export interface SystemControl {
	status(): SystemStatus;
	setStartAtLogin(on: boolean): void;
	setLauncher(on: boolean): void;
}

/** Computer-only: these change what this computer starts. */
export function systemRoutes(system: SystemControl): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.get("/system", (c) => c.json(system.status()));

	app.patch("/system", async (c) => {
		const fields = await readJson(c);
		const startAtLogin = optBoolean(fields, "startAtLogin");
		const launcher = optBoolean(fields, "launcher");
		const status = system.status();
		if (startAtLogin !== undefined && !status.startAtLogin.supported) {
			throw conflict(
				"Starting at login works on macOS and Linux.",
				{ field: "startAtLogin" },
				"not-on-this-system",
			);
		}
		if (launcher !== undefined && !status.launcher.supported) {
			throw conflict(
				"The launcher icon works on macOS.",
				{ field: "launcher" },
				"not-on-this-system",
			);
		}
		if (startAtLogin !== undefined) system.setStartAtLogin(startAtLogin);
		if (launcher !== undefined) system.setLauncher(launcher);
		return c.json(system.status());
	});

	return app;
}
