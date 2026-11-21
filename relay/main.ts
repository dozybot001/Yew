import { Apns, apnsConfigFromEnv } from "./apns.ts";
import { Relay } from "./relay.ts";

// Yew's relay as a service: `node relay/main.ts`. PORT (default 8790) and HOST (default 0.0.0.0) come
// from the environment; TLS ends at the reverse proxy in front of it.
// Notifications need Apple's signing key: APNS_KEY_FILE (the .p8, readable by this service only),
// APNS_KEY_ID and APNS_TEAM_ID; APNS_TOPIC is the app's bundle id. Without them push is off.
const port = Number(process.env.PORT ?? 8790);
const config = apnsConfigFromEnv(process.env);
const apns = config ? new Apns(config) : null;
const relay = new Relay({
	port,
	...(process.env.MAX_CONNECTIONS ? { maxConnections: Number(process.env.MAX_CONNECTIONS) } : {}),
	// Behind the reverse proxy every connection comes from the proxy; it appends the address it saw
	// as the last value of X-Forwarded-For, which a client cannot forge.
	...(process.env.TRUST_PROXY === "1"
		? {
				addressOf: (request) => {
					const forwarded = request.headers["x-forwarded-for"];
					const last = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)?.split(",").at(-1);
					return last?.trim() || request.socket.remoteAddress || "";
				},
			}
		: {}),
	host: process.env.HOST ?? "0.0.0.0",
	...(apns ? { push: (job) => apns.send(job) } : {}),
});
const bound = await relay.listen();
process.stderr.write(`Yew relay listening on ${bound}; notifications ${apns ? "on" : "off"}\n`);

// A line of counts every ten minutes: connections only, never content.
const counts = setInterval(() => {
	const { desktops, phones } = relay.counts;
	process.stderr.write(
		`connected: ${desktops} Macs, ${phones} phones; notifications: ${relay.pushes}\n`,
	);
	relay.pushes = 0;
}, 600_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		clearInterval(counts);
		apns?.close();
		void relay.close().then(() => process.exit(0));
	});
}
