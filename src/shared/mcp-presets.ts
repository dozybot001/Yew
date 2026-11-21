/**
 * Official MCP servers people often add (blueprint 6.11, item 40). Some take a token; the others are
 * signed in to in the browser. Each was tried with Yew's own client before it went in: the token ones
 * connected and listed their tools; for the sign-in ones Yew found where to sign in, registered or
 * used the person's client, and the sign-in page opened. Adding one writes an mcp.json entry. A server
 * that runs on this computer is written as `"preset": "<id>"`: Yew installs its package from npm as a
 * lock file that ships with Yew says (`mcp-builtin/presets/<id>`), without install scripts, the way it
 * installs its own two servers, rather than letting npx resolve the package's dependencies when it
 * starts, since these servers hold the person's token.
 */
export interface McpPreset {
	/** Its name in mcp.json, and the middle part of its tools' names. */
	id: string;
	name: string;
	/** Who makes and runs it. */
	publisher: string;
	/** Where to read about it. */
	docs: string;
	/** A remote server's address, or the npm package, at one version, that Yew installs and runs. */
	connect: { url: string } | { package: string };
	token?: {
		/** Sent as a request header, or set as an environment variable of the command. */
		in: "header" | "env";
		key: string;
		/** Written before the token, such as "Bearer ". */
		prefix?: string;
		/** It works without one, with lower limits. */
		optional?: boolean;
		/** Where to make one. */
		where: string;
	};
	/**
	 * Tools of this server that send something out although their names do not say so, asked about
	 * every time like the ones whose names do: creating or changing a calendar event invites its
	 * attendees.
	 */
	asksEveryTime?: string[];
	/** Signed in to in the browser instead of a token. */
	signIn?: {
		/**
		 * The server only accepts a client the person makes for it (Google's): the APIs to turn on, the
		 * scopes to ask for, and the provider's guide.
		 */
		ownClient?: { apis: string[]; scopes: string[]; guide: string };
	};
}

export const MCP_PRESETS: readonly McpPreset[] = [
	{
		id: "github",
		name: "GitHub",
		publisher: "GitHub",
		docs: "https://github.com/github/github-mcp-server",
		connect: { url: "https://api.githubcopilot.com/mcp/" },
		token: {
			in: "header",
			key: "Authorization",
			prefix: "Bearer ",
			where: "https://github.com/settings/personal-access-tokens",
		},
	},
	{
		id: "gitee",
		name: "Gitee",
		publisher: "Gitee",
		docs: "https://gitee.com/oschina/mcp-gitee",
		connect: { package: "@gitee/mcp-gitee@1.0.0" },
		token: {
			in: "env",
			key: "GITEE_ACCESS_TOKEN",
			where: "https://gitee.com/profile/personal_access_tokens",
		},
	},
	{
		id: "context7",
		name: "Context7",
		publisher: "Upstash",
		docs: "https://context7.com",
		connect: { url: "https://mcp.context7.com/mcp" },
		token: {
			in: "header",
			key: "CONTEXT7_API_KEY",
			optional: true,
			where: "https://context7.com/dashboard",
		},
	},
	{
		id: "notion",
		name: "Notion",
		publisher: "Notion",
		docs: "https://github.com/makenotion/notion-mcp-server",
		connect: { package: "@notionhq/notion-mcp-server@2.6.1" },
		token: { in: "env", key: "NOTION_TOKEN", where: "https://www.notion.so/profile/integrations" },
	},
	{
		id: "gmail",
		name: "Gmail",
		publisher: "Google",
		docs: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
		connect: { url: "https://gmailmcp.googleapis.com/mcp/v1" },
		signIn: {
			ownClient: {
				apis: ["gmail.googleapis.com", "gmailmcp.googleapis.com"],
				scopes: [
					"https://www.googleapis.com/auth/gmail.readonly",
					"https://www.googleapis.com/auth/gmail.compose",
				],
				guide: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
			},
		},
	},
	{
		id: "google-calendar",
		asksEveryTime: ["create_event", "update_event", "respond_to_event"],
		name: "Google Calendar",
		publisher: "Google",
		docs: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
		connect: { url: "https://calendarmcp.googleapis.com/mcp/v1" },
		signIn: {
			ownClient: {
				apis: ["calendar-json.googleapis.com", "calendarmcp.googleapis.com"],
				scopes: [
					"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
					"https://www.googleapis.com/auth/calendar.events.freebusy",
					"https://www.googleapis.com/auth/calendar.events.readonly",
				],
				guide: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
			},
		},
	},
	{
		id: "google-drive",
		name: "Google Drive",
		publisher: "Google",
		docs: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
		connect: { url: "https://drivemcp.googleapis.com/mcp/v1" },
		signIn: {
			ownClient: {
				apis: ["drive.googleapis.com", "drivemcp.googleapis.com"],
				scopes: [
					"https://www.googleapis.com/auth/drive.readonly",
					"https://www.googleapis.com/auth/drive.file",
				],
				guide: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
			},
		},
	},
	{
		id: "linear",
		name: "Linear",
		publisher: "Linear",
		docs: "https://linear.app/docs/mcp",
		connect: { url: "https://mcp.linear.app/mcp" },
		signIn: {},
	},
	{
		id: "vercel",
		name: "Vercel",
		publisher: "Vercel",
		docs: "https://vercel.com/docs/mcp/vercel-mcp",
		connect: { url: "https://mcp.vercel.com" },
		signIn: {},
	},
	{
		id: "sentry",
		name: "Sentry",
		publisher: "Sentry",
		docs: "https://github.com/getsentry/sentry-mcp",
		connect: { package: "@sentry/mcp-server@0.49.0" },
		token: {
			in: "env",
			key: "SENTRY_ACCESS_TOKEN",
			where: "https://sentry.io/settings/account/api/auth-tokens/",
		},
	},
];

/**
 * The mcp.json entry for a preset with what the person gave: a token, or for a server that takes only
 * their own client, its ID and secret.
 */
export function presetEntry(
	preset: McpPreset,
	token: string,
	client: { id: string; secret: string } = { id: "", secret: "" },
): {
	name: string;
	url?: string;
	headers?: Record<string, string>;
	preset?: string;
	env?: Record<string, string>;
	oauth?: { clientId?: string; clientSecret?: string; scopes?: string[] };
} {
	const own = preset.signIn?.ownClient;
	if (preset.signIn && "url" in preset.connect) {
		return {
			name: preset.id,
			url: preset.connect.url,
			...(own
				? {
						oauth: {
							clientId: client.id.trim(),
							clientSecret: client.secret.trim(),
							scopes: [...own.scopes],
						},
					}
				: {}),
		};
	}
	const value = token.trim();
	const secret =
		preset.token && value ? { [preset.token.key]: `${preset.token.prefix ?? ""}${value}` } : null;
	if ("url" in preset.connect) {
		return {
			name: preset.id,
			url: preset.connect.url,
			...(secret && preset.token?.in === "header" ? { headers: secret } : {}),
		};
	}
	return {
		name: preset.id,
		preset: preset.id,
		...(secret && preset.token?.in === "env" ? { env: secret } : {}),
	};
}

/** The npm package, at its version, of a preset Yew installs and runs on this computer; null otherwise. */
export function presetPackage(id: string): string | null {
	const preset = MCP_PRESETS.find((item) => item.id === id);
	return preset && "package" in preset.connect ? preset.connect.package : null;
}
