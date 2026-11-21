import { Hono } from "hono";
import type { ArtifactStore } from "../artifacts.ts";
import { invalid } from "../errors.ts";
import { optIntQuery } from "./input.ts";
import type { AppEnv } from "./problem.ts";

/**
 * What an HTML artifact is served with. `sandbox` without
 * allow-same-origin makes the page its own origin: it has no cookie for Yew and cannot read Yew's
 * pages. `default-src 'none'` stops every request, so it cannot reach Yew's interface or anything
 * else; only its own inline scripts and styles run.
 */
export const ARTIFACT_CSP =
	"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-ancestors 'self'";

const versionOf = (text: string): number => {
	if (!/^\d{1,6}$/.test(text)) throw invalid("The version is a whole number.", "version");
	return Number(text);
};

export function artifactRoutes(artifacts: ArtifactStore): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.get("/api/artifacts", (c) => {
		const limit = optIntQuery(c, "limit") ?? 100;
		if (limit < 1 || limit > 500) throw invalid("limit must be from 1 to 500.", "limit");
		return c.json({
			items: artifacts.list({ sessionId: c.req.query("session") ?? null, limit }),
			nextCursor: null,
		});
	});

	app.get("/api/artifacts/:id", (c) => {
		const id = c.req.param("id");
		return c.json({ artifact: artifacts.get(id), versions: artifacts.versions(id) });
	});

	// The version's text as it was saved, for Yew's own viewers and for downloading.
	app.get("/api/artifacts/:id/versions/:version", (c) => {
		const { content } = artifacts.content(c.req.param("id"), versionOf(c.req.param("version")));
		c.header("Content-Type", "text/plain; charset=utf-8");
		c.header("X-Content-Type-Options", "nosniff");
		return c.body(content);
	});

	app.delete("/api/artifacts/:id", (c) => {
		artifacts.delete(c.req.param("id"));
		return c.body(null, 204);
	});

	// An HTML artifact as a page, shut in. Other kinds are drawn by Yew and have no page here.
	app.get("/artifact-view/:id/:version", (c) => {
		const { artifact, content } = artifacts.content(
			c.req.param("id"),
			versionOf(c.req.param("version")),
		);
		if (artifact.kind !== "html") throw invalid("Only HTML artifacts have a page.", "id");
		c.header("Content-Type", "text/html; charset=utf-8");
		c.header("Content-Security-Policy", ARTIFACT_CSP);
		c.header("Cache-Control", "no-store");
		return c.body(content);
	});

	return app;
}
