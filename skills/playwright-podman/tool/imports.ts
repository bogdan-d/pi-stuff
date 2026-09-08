import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";

// Reject directories and devices before reading; nonblocking open avoids hanging on FIFOs.
export function openImportFile(path: string): number {
	const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK);
	if (!fstatSync(fd).isFile()) {
		closeSync(fd);
		throw new Error("Import source must be a readable regular file");
	}
	return fd;
}

export function parseAuth(text: string): string {
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error();
		if (!("cookies" in value) || !Array.isArray(value.cookies))
			throw new Error();
		if ("origins" in value && !Array.isArray(value.origins)) throw new Error();
		return JSON.stringify(value);
	} catch {
		// JSON parser errors can include excerpts containing credentials.
		throw new Error(
			'Expected Playwright state JSON: {"cookies": [...], "origins": [...]}',
		);
	}
}

function authInput(source: string): string {
	try {
		if (source === "-") return parseAuth(readFileSync(0, "utf8"));
		const fd = openImportFile(source);
		try {
			return parseAuth(readFileSync(fd, "utf8"));
		} finally {
			closeSync(fd);
		}
	} catch {
		throw new Error(
			"Could not read authentication. Supply a readable Playwright state JSON file or JSON on stdin.",
		);
	}
}

export function loadAuth(session: string, source: string): void {
	const input = authInput(source);
	const path = `/tmp/pw-auth-${randomUUID()}.json`;
	try {
		const write = spawnSync(
			"podman",
			[
				"exec",
				"-i",
				session,
				"node",
				"-e",
				'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], fs.readFileSync(0), {mode: 0o600, flag: "wx"});',
				path,
			],
			{ input, stdio: ["pipe", "pipe", "pipe"] },
		);
		if (write.error || write.status !== 0)
			throw new Error("Could not transfer authentication state");
		const loaded = spawnSync(
			"podman",
			["exec", session, "playwright-cli", "state-load", path, "--json"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		// Keep upstream messages private, including failures that may quote state values.
		let result: unknown;
		try {
			result = JSON.parse(loaded.stdout ?? "");
		} catch {
			result = null;
		}
		if (
			loaded.error ||
			loaded.status !== 0 ||
			!result ||
			typeof result !== "object" ||
			("isError" in result && result.isError) ||
			!("result" in result)
		) {
			throw new Error(
				"Authentication load failed. Check the state format and cookie fields. Browser state may be partially changed; stop this session before retrying.",
			);
		}
	} finally {
		const cleanup = spawnSync("podman", ["exec", session, "rm", "-f", path], {
			stdio: "pipe",
		});
		if (cleanup.error || cleanup.status !== 0) {
			throw new Error(
				"Authentication temporary-file cleanup failed. Stop this session to dispose of it.",
			);
		}
	}
	console.log(
		"Authentication state loaded. Navigate to the authorized site to verify login.",
	);
}

export function importFile(session: string, source: string): void {
	const fd = openImportFile(source);
	const directory = `/work/uploads/${randomUUID()}`;
	const destination = `${directory}/${basename(resolve(source))}`;
	try {
		const copied = spawnSync(
			"podman",
			[
				"exec",
				"-i",
				session,
				"node",
				"-e",
				'const fs = require("node:fs"); const {pipeline} = require("node:stream"); fs.mkdirSync(process.argv[1], {recursive:true, mode:0o700}); pipeline(process.stdin, fs.createWriteStream(process.argv[2], {mode:0o600, flags:"wx"}), error => {if (error) process.exitCode = 1;});',
				directory,
				destination,
			],
			{ stdio: [fd, "ignore", "pipe"] },
		);
		if (copied.error || copied.status !== 0) {
			const cleanup = spawnSync(
				"podman",
				["exec", session, "rm", "-rf", directory],
				{ stdio: "pipe" },
			);
			if (cleanup.error || cleanup.status !== 0)
				throw new Error(
					"File import and cleanup failed. Stop this session to dispose of partial files.",
				);
			throw new Error("File import failed");
		}
	} finally {
		closeSync(fd);
	}
	console.log(`Imported: ${destination}`);
}
