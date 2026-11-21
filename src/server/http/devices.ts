import { Hono } from "hono";
import { renderSVG } from "uqr";
import type { RemoteAccess } from "../../remote/access.ts";
import { PUSH_TOKEN } from "../../remote/push.ts";
import { conflict, invalid } from "../errors.ts";
import type { Store } from "../store.ts";
import { optBoolean, optNullableString, optString, readJson } from "./input.ts";
import type { AppEnv } from "./problem.ts";

/** Paired phones and pairing. Pairing and revoking stay on the Mac. */
export function deviceRoutes(store: Store, remote: RemoteAccess | undefined): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.get("/devices", (c) =>
		c.json({ devices: store.listDevices(), remote: remote?.status() ?? null }),
	);

	app.patch("/devices/:id", async (c) => {
		const id = c.req.param("id");
		const fields = await readJson(c);
		const name = optString(fields, "name", 60)?.trim();
		if (name !== undefined && !name) throw invalid("The name cannot be empty.", "name");
		const push = optBoolean(fields, "push");
		// Only the phone itself hands over its notification token.
		const pushToken = optNullableString(fields, "pushToken", 200);
		if (pushToken !== undefined && c.env?.device !== id) {
			throw invalid("Only the device itself can set its notification token.", "pushToken");
		}
		if (pushToken && !PUSH_TOKEN.test(pushToken)) {
			throw invalid("The notification token is not one Apple gives out.", "pushToken");
		}
		return c.json(
			store.updateDevice(id, {
				...(name !== undefined ? { name } : {}),
				...(push !== undefined ? { push } : {}),
				...(pushToken !== undefined ? { pushToken } : {}),
			}),
		);
	});

	app.delete("/devices/:id", (c) => {
		const id = c.req.param("id");
		store.deleteDevice(id);
		remote?.disconnect(id);
		return c.body(null, 204);
	});

	app.post("/devices/pairing", async (c) => {
		if (!remote) throw conflict("Remote access is not available here.", undefined, "remote-off");
		if (!remote.status().enabled) {
			throw conflict("Turn on phone access first.", undefined, "remote-off");
		}
		const { link, expiresAt } = await remote.pairing();
		return c.json({ link, expiresAt, svg: renderSVG(link) });
	});

	return app;
}
