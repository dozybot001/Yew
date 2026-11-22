import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { UnsentTexts } from "../web/src/unsent.ts";

/** Yew's side, held in memory: what was written, in order, and a way to hold a request back. */
function yew() {
	const saved = new Map<string, string>();
	const writes: string[] = [];
	let hold: Promise<void> = Promise.resolve();
	let failing = false;
	return {
		saved,
		writes,
		/** Requests wait until the returned function is called. */
		holdBack(): () => void {
			let release = () => {};
			hold = new Promise((resolve) => {
				release = resolve;
			});
			return release;
		},
		failOnce(): void {
			failing = true;
		},
		link: {
			read: async (place: string) => {
				await hold;
				return saved.get(place) ?? "";
			},
			write: async (place: string, text: string, leaving: boolean) => {
				writes.push(`${place}${leaving ? " (leaving)" : ""}: ${text}`);
				await hold;
				if (failing) {
					failing = false;
					throw new Error("offline");
				}
				saved.set(place, text);
			},
		},
	};
}

/** Lets the requests under way finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("text typed into a message box and not sent", () => {
	beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
	afterEach(() => mock.timers.reset());

	test("typing is saved a moment later, the newest text once; an emptied box at once", async () => {
		const side = yew();
		const unsent = new UnsentTexts(side.link, 500);
		unsent.keep("s1", "你");
		unsent.keep("s1", "你好");
		assert.deepEqual(side.writes, []);
		mock.timers.tick(500);
		await settle();
		assert.deepEqual(side.writes, ["s1: 你好"]);
		// Sent: the box is emptied, and so is what Yew keeps.
		unsent.keep("s1", "");
		await settle();
		assert.deepEqual(side.writes, ["s1: 你好", "s1: "]);
		assert.equal(side.saved.get("s1"), "");
		// Nothing changed, nothing sent.
		unsent.keep("s1", "");
		unsent.flush("s1");
		mock.timers.tick(500);
		await settle();
		assert.equal(side.writes.length, 2);
	});

	test("one request at a time for a place; text changed meanwhile goes out next", async () => {
		const side = yew();
		const unsent = new UnsentTexts(side.link, 500);
		const release = side.holdBack();
		// The box goes away after each change, so each is saved at once.
		for (const text of ["a", "ab", "abc"]) {
			unsent.keep("s1", text);
			unsent.flush("s1");
		}
		assert.deepEqual(side.writes, ["s1: a"]);
		release();
		await settle();
		assert.deepEqual(side.writes, ["s1: a", "s1: abc"]);
		assert.equal(side.saved.get("s1"), "abc");
	});

	test("a box opens with what was saved, unless it holds something newer", async () => {
		const side = yew();
		side.saved.set("s1", "saved earlier");
		const unsent = new UnsentTexts(side.link, 500);
		assert.equal(unsent.known("s1"), "");
		assert.equal(await unsent.load("s1"), "saved earlier");
		assert.equal(unsent.known("s1"), "saved earlier");
		// Typed while the answer was on its way: the answer is dropped.
		const release = side.holdBack();
		const late = unsent.load("s1");
		unsent.keep("s1", "typed meanwhile");
		release();
		assert.equal(await late, null);
		assert.equal(unsent.known("s1"), "typed meanwhile");
		// Not saved yet: what the page holds is newer than what Yew has.
		assert.equal(await unsent.load("s1"), null);
		mock.timers.tick(500);
		await settle();
		assert.equal(await unsent.load("s1"), "typed meanwhile");
		// Each place has its own text.
		assert.equal(await unsent.load("home"), "");
	});

	test("leaving the page sends what is waiting, and only that", async () => {
		const side = yew();
		const unsent = new UnsentTexts(side.link, 500);
		unsent.keep("s1", "saved already");
		mock.timers.tick(500);
		await settle();
		unsent.keep("home", "not saved yet");
		unsent.flushAll(true);
		await settle();
		assert.deepEqual(side.writes, ["s1: saved already", "home (leaving): not saved yet"]);
		mock.timers.tick(500);
		await settle();
		assert.equal(side.writes.length, 2);
	});

	test("a text that could not be saved goes out again when the box goes away", async () => {
		const side = yew();
		const unsent = new UnsentTexts(side.link, 500);
		side.failOnce();
		unsent.keep("s1", "a");
		mock.timers.tick(500);
		await settle();
		assert.equal(side.saved.get("s1"), undefined);
		unsent.flush("s1");
		await settle();
		assert.equal(side.saved.get("s1"), "a");
	});
});
