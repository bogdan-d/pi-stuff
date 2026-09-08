import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	artifactPath,
	sessionName,
} from "../skills/playwright-podman/tool/browser.ts";

test("task handles cannot address arbitrary containers or inject options", () => {
	const handle = "pi-browser-01234567-89ab-cdef-0123-456789abcdef";
	expect(sessionName(handle)).toBe(handle);
	for (const name of [
		"postgres",
		"--all",
		"pi-browser-",
		`${handle}; echo bad`,
	]) {
		expect(() => sessionName(name)).toThrow();
	}
});

test("artifact paths stay in the disposable workspace", () => {
	expect(artifactPath(".playwright-cli/page.yml")).toBe(
		"/work/.playwright-cli/page.yml",
	);
	expect(artifactPath("/work/page.png")).toBe("/work/page.png");
	for (const path of [
		"../etc/passwd",
		"/etc/passwd",
		"/work/../secret",
		"/work",
	]) {
		expect(() => artifactPath(path)).toThrow();
	}
});

test("session-first wrapper validates destructive and artifact arguments before execution", () => {
	const script = fileURLToPath(
		new URL("../skills/playwright-podman/tool/browser.ts", import.meta.url),
	);
	const session = "pi-browser-01234567-89ab-cdef-0123-456789abcdef";
	for (const [args, message] of [
		[[session, "stop", "--all"], "Usage: pw <session> stop"],
		[[session, "export", "page.png"], "Usage: pw <session> export"],
		[[session, "read", "page.yml", "1", "201"], "at most 200 lines"],
		[[session, "read", "../secret"], "Artifacts must be under /work"],
	] as const) {
		const result = spawnSync(process.execPath, [script, ...args], {
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(message);
	}
});
