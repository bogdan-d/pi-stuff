import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importFile, loadAuth } from "./imports.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const image = "localhost/pi-playwright:0.1.19";
const owner = "pi.playwright-podman";

function podman(args: string[], capture = false): string {
	const result = spawnSync("podman", args, {
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`podman ${args[0]} failed (${result.status ?? result.signal})`,
		);
	}
	return result.stdout?.trim() ?? "";
}

export function sessionName(value: string): string {
	if (
		!/^pi-browser-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			value,
		)
	) {
		throw new Error("Expected the session handle returned by start");
	}
	return value;
}

export function artifactPath(value: string): string {
	const path = posix.resolve("/work", value);
	if (!path.startsWith("/work/"))
		throw new Error("Artifacts must be under /work");
	return path;
}

function ownedSession(value: string): string {
	const name = sessionName(value);
	const label = podman(
		[
			"inspect",
			"--type",
			"container",
			"--format",
			`{{index .Config.Labels "${owner}"}}`,
			name,
		],
		true,
	);
	if (label !== "true")
		throw new Error("Refusing a container not owned by this wrapper");
	return name;
}

function build(): void {
	podman(["build", "-t", image, directory]);
}

function main(args: string[]): void {
	const [command, ...rest] = args;
	if (!command || command === "--help") {
		console.log(`Usage: pw <command>
  build                              Build/rebuild the cached runtime image
  start [url]                        Start a task; prints its session handle
  <session> <playwright-command> ...  Forward arguments to Playwright CLI
  <session> read <path> [start] [end] Read artifact lines (default 1-80, max 200)
  <session> export <path> <host-path> Copy an artifact out without a mount
  <session> import <host-file>        Copy one file in for an authorized upload
  <session> auth <host-file|->        Load private Playwright state; - reads stdin
  <session> stop                     Remove only this task's container

Run <session> --help for upstream browser commands. Paths are inside /work.
Browser close resets the browser; wrapper stop disposes of the whole task.`);
		return;
	}
	if (command === "build") {
		if (rest.length) throw new Error("Usage: build");
		build();
		return;
	}
	if (command === "start") {
		if (rest.length > 1) throw new Error("Usage: start [url]");
		const exists = spawnSync("podman", ["image", "exists", image]);
		if (exists.error) throw exists.error;
		if (exists.status === 1) build();
		else if (exists.status !== 0)
			throw new Error("Could not inspect runtime image");
		const name = `pi-browser-${randomUUID()}`;
		try {
			podman(
				[
					"run",
					"-d",
					"--name",
					name,
					"--label",
					`${owner}=true`,
					"--network=host",
					"--init",
					"--shm-size=1g",
					image,
				],
				true,
			);
			podman([
				"exec",
				name,
				"playwright-cli",
				"open",
				rest[0] ?? "about:blank",
			]);
			console.log(`Session: ${name}`);
		} catch (error) {
			// A failed start must not leave an unreported task container behind.
			const cleanup = spawnSync("podman", ["rm", "--force", name], {
				stdio: "inherit",
			});
			if (cleanup.status !== 0) console.error(`Check cleanup of ${name}`);
			throw error;
		}
		return;
	}
	const session = sessionName(command);
	const [action, ...actionArgs] = rest;
	if (action === "auth" || action === "import") {
		if (actionArgs.length !== 1 || !actionArgs[0])
			throw new Error(
				`Usage: pw <session> ${action} <host-file${action === "auth" ? "|-" : ""}>`,
			);
		const name = ownedSession(session);
		if (action === "auth") loadAuth(name, actionArgs[0]);
		else importFile(name, actionArgs[0]);
		return;
	}
	if (action === "stop") {
		if (actionArgs.length) throw new Error("Usage: pw <session> stop");
		const name = ownedSession(session);
		// Stopping the container also terminates a failed or unresponsive browser.
		podman(["stop", name]);
		podman(["rm", name]);
		return;
	}
	if (action === "read" || action === "export") {
		const [path, first, last] = actionArgs;
		if (!path) throw new Error(`Usage: pw <session> ${action} <path> ...`);
		const source = artifactPath(path);
		if (action === "export") {
			if (actionArgs.length !== 2 || !first)
				throw new Error("Usage: pw <session> export <path> <host-path>");
			podman(["cp", `${ownedSession(session)}:${source}`, resolve(first)]);
		} else {
			const start = Number(first ?? 1);
			const end = Number(last ?? start + 79);
			if (
				actionArgs.length > 3 ||
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 1 ||
				end < start ||
				end - start >= 200
			) {
				throw new Error(
					"Read requires a positive line range of at most 200 lines",
				);
			}
			podman([
				"exec",
				ownedSession(session),
				"sed",
				"-n",
				`${start},${end}p`,
				source,
			]);
		}
		return;
	}
	if (!rest.length)
		throw new Error("Expected a Playwright command after the session handle");
	podman(["exec", ownedSession(session), "playwright-cli", ...rest]);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
