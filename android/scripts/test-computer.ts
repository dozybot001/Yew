// A computer to try the Android app against, all on this machine and in memory: a relay on
// 127.0.0.1:8791, Yew's API behind it with two sessions and four artifacts, and the notifier. Nothing
// touches ~/.yew or the system keychain; the artifacts' files go into <folder>. Run from the repository root:
//   node android/scripts/test-computer.ts <folder>
// It writes the pairing link to <folder>/link.txt and takes commands as one line written to
// <folder>/cmd:  pair | ask <command> | settle | drop | status
// On the emulator (always name it: `-s emulator-5570` is Yew's own),
// `adb -s <serial> reverse tcp:8791 tcp:8791` makes 127.0.0.1:8791 reach this relay; a debug
// build then pairs with `adb -s <serial> shell am start -n cn.tenonai.apps.yew.debug/cn.tenonai.apps.yew.MainActivity --es yew.pair '<link>'`.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { Relay } from "../../relay/relay.ts";
import { RemoteAccess } from "../../src/remote/access.ts";
import { ArtifactStore } from "../../src/server/artifacts.ts";
import { createApp } from "../../src/server/http/app.ts";
import { NoteStreams } from "../../src/server/http/notes.ts";
import { MemoryKeyStore } from "../../src/server/keys.ts";
import { MailStore } from "../../src/server/mail/store.ts";
import { Notifier } from "../../src/server/push.ts";
import { newStore, sessionInput } from "../../test/helpers/store.ts";

const folder = process.argv[2];
if (!folder) {
	process.stderr.write("usage: node android/scripts/test-computer.ts <folder>\n");
	process.exit(2);
}
const log = (line: string) => process.stdout.write(`${line}\n`);

const relay = new Relay({ port: 8791, host: "127.0.0.1", log: (line) => log(`relay: ${line}`) });
const relayUrl = `ws://127.0.0.1:${await relay.listen()}`;
const { store, bus } = newStore();
store.setSetting("remote", { enabled: true, relayUrl });
let app: ReturnType<typeof createApp> | null = null;
const remote = new RemoteAccess(store, new MemoryKeyStore(), {
	version: "0.0.0",
	log: (line) => log(`remote: ${line}`),
	WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
	handle: async (request, device) =>
		(app as ReturnType<typeof createApp>).fetch(request, { device: device.id }),
});
const notes = new NoteStreams(store);
const artifacts = new ArtifactStore(store, folder);
app = createApp({ store, bus, remote, notes, artifacts, log: () => {} });
const notifier = new Notifier({
	store,
	mail: new MailStore(store),
	bus,
	send: (note) => {
		const sent = notes.send(note);
		log(`note: ${JSON.stringify(note)} -> ${sent}`);
		return sent;
	},
});
store.createSession(sessionInput("总办"));
const site = store.createSession({ ...sessionInput("官网"), cwd: "/tmp" });
artifacts.save(site.id, { name: "发布说明", kind: "markdown", content: "**1.0.0**\n\n- 手机上能看产物。\n- `yew serve` 开机启动。" });
artifacts.save(site.id, { name: "配置", kind: "json", content: '{"port":4777,"remote":{"enabled":true}}' });
artifacts.save(site.id, {
	name: "每周提交",
	kind: "chart",
	content: '{"type":"line","title":"每周提交","labels":["一","二","三","四"],"series":[{"name":"官网","values":[3,5,2,6]},{"name":"总办","values":[1,2,4,3]}]}',
});
// A page that tries to reach the network: on the phone it must say "blocked".
artifacts.save(site.id, {
	name: "联网测试页",
	kind: "html",
	content:
		'<h1>Sealed page</h1><p id="out">script did not run</p><img src="https://example.com/x.png"><script>fetch("https://example.com/").then(()=>out.textContent="NETWORK REACHED",()=>out.textContent="network blocked")</script>',
});
notifier.start();
await remote.sync();

const pair = async () => writeFileSync(join(folder, "link.txt"), (await remote.pairing()).link);
setTimeout(pair, 1500);
const asked: string[] = [];
setInterval(async () => {
	const file = join(folder, "cmd");
	if (!existsSync(file)) return;
	const line = readFileSync(file, "utf8").trim();
	rmSync(file);
	log(`cmd: ${line}`);
	try {
		if (line === "pair") {
			await pair();
		} else if (line.startsWith("ask ")) {
			// A permission request waiting in the approval center, as a session's push would be.
			const approval = store.createApproval({
				sessionId: site.id,
				toolCallId: null,
				kind: "permission",
				request: { tool: "shell", summary: line.slice(4), mustConfirm: true },
			});
			asked.push(approval.id);
		} else if (line === "settle") {
			const id = asked.pop();
			if (id) store.resolveApproval(id, { decision: "allow_once" });
		} else if (line === "drop") {
			for (const device of store.listDevices()) remote.disconnect(device.id);
		} else if (line === "status") {
			log(JSON.stringify({ devices: store.listDevices(), remote: remote.status() }));
		}
	} catch (error) {
		log(`error: ${String(error)}`);
	}
}, 500);
log(`ready ${relayUrl}`);
