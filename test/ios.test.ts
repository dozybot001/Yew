import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { POLICY, POLICY_VERSION } from "../src/shared/policy.ts";

// The iPhone app's project and texts, checked against the one source each has in this repository.

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

type Unit = { stringUnit?: { value: string } };
type Catalog = {
	strings: Record<
		string,
		{ shouldTranslate?: boolean; localizations?: Record<string, Unit & { variations?: unknown }> }
	>;
};

const catalog = JSON.parse(read("ios/Yew/Localizable.xcstrings")) as Catalog;
const value = (key: string, language: string) =>
	catalog.strings[key]?.localizations?.[language]?.stringUnit?.value;

describe("the iPhone app", () => {
	test("its version is the one in package.json", () => {
		const { version } = JSON.parse(read("package.json")) as { version: string };
		const versions = [
			...read("ios/Yew.xcodeproj/project.pbxproj").matchAll(/MARKETING_VERSION = ([^;]+);/g),
		];
		assert.ok(versions.length > 0);
		for (const [, marketing] of versions) assert.equal(marketing, version);
	});

	test("its privacy policy and terms are the Mac's, in both languages", () => {
		assert.equal(value("policy.version", "en"), POLICY_VERSION);
		assert.equal(value("policy.version", "zh-Hans"), POLICY_VERSION);
		for (const [language, texts] of [
			["en", POLICY.en],
			["zh-Hans", POLICY.zh],
		] as const) {
			assert.equal(value("policy.date", language), texts.date);
			assert.equal(value("policy.privacy", language), texts.privacy.join("\n\n"));
			assert.equal(value("policy.terms", language), texts.terms.join("\n\n"));
		}
	});

	test("every text is translated into Chinese", () => {
		const untranslated = Object.entries(catalog.strings)
			.filter(([, entry]) => entry.shouldTranslate !== false && !entry.localizations?.["zh-Hans"])
			.map(([key]) => key);
		assert.deepEqual(untranslated, []);
	});
});
