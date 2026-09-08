// Opt-in integration check: bun skills/playwright-podman/tool/verify-imports.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("browser.ts", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "pw-import-check-"));
let session = "";
let uploaded = "";
const server = createServer((request, response) => {
	if (!request.headers.cookie?.includes("session=synthetic-secret")) {
		response.writeHead(401).end("Not authenticated");
		return;
	}
	if (request.method === "POST") {
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			uploaded += chunk;
		});
		request.on("end", () => response.end("Uploaded"));
		return;
	}
	response.setHeader("Content-Type", "text/html");
	response.end(
		'<h1>Authenticated</h1><input type="file" aria-label="Document" onchange="fetch(\'/upload\', {method:\'POST\',body:this.files[0]})">',
	);
});
try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	const run = async (...args: string[]) =>
		(await exec(process.execPath, [script, ...args])).stdout;
	session =
		(await run("start", origin)).match(
			/Session: (pi-browser-[\da-f-]+)/,
		)?.[1] ?? "";
	assert(session);
	const state = join(directory, "state.json");
	await writeFile(
		state,
		JSON.stringify({
			cookies: [
				{
					name: "session",
					value: "synthetic-secret",
					domain: "127.0.0.1",
					path: "/",
					expires: -1,
					httpOnly: true,
					secure: false,
					sameSite: "Lax",
				},
			],
			origins: [],
		}),
		{ mode: 0o600 },
	);
	const result = await run(session, "auth", state);
	assert(!result.includes("synthetic-secret"));
	await run(session, "goto", origin);
	assert(
		(await run(session, "eval", "() => document.body.innerText")).includes(
			"Authenticated",
		),
	);
	const file = join(directory, "report with spaces.txt");
	await writeFile(file, "authorized upload fixture");
	const imported = (await run(session, "import", file))
		.trim()
		.replace(/^Imported: /, "");
	assert(imported.startsWith("/work/uploads/"));
	await run(session, "click", 'getByLabel("Document")');
	await run(session, "upload", imported);
	assert.equal(uploaded, "authorized upload fixture");
	const badState = join(directory, "bad.json");
	await writeFile(
		badState,
		JSON.stringify({
			cookies: [
				{ name: "session", value: "synthetic-secret", sameSite: "INVALID" },
			],
			origins: [],
		}),
	);
	await assert.rejects(run(session, "auth", badState), (error) => {
		assert(error instanceof Error);
		assert(!error.message.includes("synthetic-secret"));
		return true;
	});
	const remaining = await exec("podman", [
		"exec",
		session,
		"find",
		"/tmp",
		"-maxdepth",
		"1",
		"-name",
		"pw-auth-*",
	]);
	assert.equal(remaining.stdout.trim(), "");
	console.log(
		"PASS: authenticated request, explicit upload, private errors, auth-file cleanup",
	);
} finally {
	try {
		if (session) await exec(process.execPath, [script, session, "stop"]);
	} finally {
		server.close();
		await rm(directory, { recursive: true, force: true });
	}
}
