import { Hono } from "hono";
import { invalid, notFound } from "../errors.ts";
import { SEARCH_SERVICES, type SearchAccess } from "../tools/web-search.ts";
import { readJson, reqString } from "./input.ts";
import type { AppEnv } from "./problem.ts";

/**
 * The search services and their keys. As with the model providers, a key is written to the
 * keychain and never read back; the list says only whether one is saved.
 */
export function searchRoutes(search: SearchAccess): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const service = (id: string) => {
		const found = SEARCH_SERVICES.find((item) => item.id === id);
		if (!found) throw notFound("Search service", id);
		// Its key is the model provider's, set with the model providers.
		if (found.provider) {
			throw invalid(
				`${found.name} uses the ${found.provider} key; set it under Models and keys.`,
				"id",
			);
		}
		return found;
	};

	app.get("/search-services", async (c) => {
		await search.refresh();
		const items = await Promise.all(
			SEARCH_SERVICES.map(async (item) => ({
				id: item.id,
				name: item.name,
				region: item.region,
				hasKey: await search.hasKey(item),
				// Uses this model provider's key; set with the model providers, not here.
				provider: item.provider ?? null,
				// The one web search uses: the first in this order that has a key.
				active: search.service?.id === item.id,
			})),
		);
		return c.json({ items, nextCursor: null });
	});

	app.put("/search-services/:id/key", async (c) => {
		const found = service(c.req.param("id"));
		const key = reqString(await readJson(c), "key", 4096).trim();
		if (!key) throw invalid("The key cannot be empty.", "key");
		await search.saveKey(found, key);
		return c.body(null, 204);
	});

	app.delete("/search-services/:id/key", async (c) => {
		await search.deleteKey(service(c.req.param("id")));
		return c.body(null, 204);
	});

	return app;
}
