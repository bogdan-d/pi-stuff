import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openImportFile,
	parseAuth,
} from "../skills/playwright-podman/tool/imports.ts";

test("auth accepts standard state and never quotes malformed secrets in errors", () => {
	const state = {
		cookies: [],
		origins: [
			{
				origin: "https://example.com",
				localStorage: [{ name: "token", value: "secret" }],
			},
		],
	};
	expect(JSON.parse(parseAuth(JSON.stringify(state)))).toEqual(state);
	for (const input of [
		'{"cookies": "SENSITIVE"}',
		"SENSITIVE",
		"[]",
		'{"cookies":[],"origins":"SENSITIVE"}',
	]) {
		try {
			parseAuth(input);
			throw new Error("Expected validation failure");
		} catch (error) {
			expect(String(error)).toContain("Expected Playwright state JSON");
			expect(String(error)).not.toContain("SENSITIVE");
		}
	}
});

test("file imports accept regular files but reject directories and devices", () => {
	const directory = mkdtempSync(join(tmpdir(), "pw-input-"));
	try {
		const path = join(directory, "report.txt");
		writeFileSync(path, "report");
		closeSync(openImportFile(path));
		expect(() => openImportFile(directory)).toThrow("regular file");
		expect(() => openImportFile("/dev/null")).toThrow("regular file");
	} finally {
		rmSync(directory, { recursive: true });
	}
});
