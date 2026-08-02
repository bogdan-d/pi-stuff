import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import subagentExtension from "../extensions/subagent/index.js";
import {
	collectStaleSubagentOutputs,
	createSubagentOutputFile,
	SUBAGENT_OUTPUT_RETENTION_MS,
} from "../extensions/subagent/output-files.js";

const NOW = Date.UTC(2025, 0, 8);

async function withTempRoot(
	run: (tempRoot: string) => Promise<void>,
): Promise<void> {
	const tempRoot = await mkdtemp(join(tmpdir(), "subagent-output-files-test-"));
	try {
		await run(tempRoot);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

async function createManagedDirectory(
	tempRoot: string,
	suffix: string,
): Promise<string> {
	const directory = join(tempRoot, `pi-subagent-${suffix}`);
	await mkdir(directory);
	await writeFile(join(directory, "output.md"), "output", "utf8");
	return directory;
}

async function setDirectoryAge(directory: string, age: number): Promise<void> {
	const date = new Date(age);
	await utimes(directory, date, date);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("subagent output files", () => {
	test("creates a private output file in an owned temporary directory", async () => {
		await withTempRoot(async (tempRoot) => {
			const outputPath = await createSubagentOutputFile("full output", {
				tempRoot,
			});
			expect(outputPath).toMatch(
				new RegExp(`^${tempRoot}/pi-subagent-[A-Za-z0-9]{6}/output\\.md$`),
			);
			expect(await readFile(outputPath, "utf8")).toBe("full output");
			expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
		});
	});

	test("removes stale managed output and preserves fresh output", async () => {
		await withTempRoot(async (tempRoot) => {
			const stale = await createManagedDirectory(tempRoot, "aaaaaa");
			const fresh = await createManagedDirectory(tempRoot, "bbbbbb");
			await setDirectoryAge(stale, NOW - SUBAGENT_OUTPUT_RETENTION_MS - 1);
			await setDirectoryAge(fresh, NOW - SUBAGENT_OUTPUT_RETENTION_MS + 1);

			await collectStaleSubagentOutputs({ tempRoot, now: NOW });

			expect(await exists(stale)).toBe(false);
			expect(await exists(fresh)).toBe(true);
		});
	});

	test("removes output at the retention cutoff", async () => {
		await withTempRoot(async (tempRoot) => {
			const directory = await createManagedDirectory(tempRoot, "cccccc");
			await setDirectoryAge(directory, NOW - SUBAGENT_OUTPUT_RETENTION_MS);

			await collectStaleSubagentOutputs({ tempRoot, now: new Date(NOW) });

			expect(await exists(directory)).toBe(false);
		});
	});

	test("preserves entries that are not exactly owned output directories", async () => {
		await withTempRoot(async (tempRoot) => {
			const unrelated = join(tempRoot, "unrelated");
			const wrongName = join(tempRoot, "pi-subagent-short");
			const regularFile = join(tempRoot, "pi-subagent-dddddd");
			const malformed = join(tempRoot, "pi-subagent-eeeeee");
			const extraContent = join(tempRoot, "pi-subagent-ffffff");
			const symlinkTarget = join(tempRoot, "symlink-target");
			const symlinkPath = join(tempRoot, "pi-subagent-gggggg");
			const outputSymlink = join(tempRoot, "pi-subagent-hhhhhh");
			const outsideOutput = join(tempRoot, "outside-output.md");
			await Promise.all([mkdir(unrelated), mkdir(wrongName), mkdir(malformed)]);
			await writeFile(regularFile, "not a directory", "utf8");
			await writeFile(join(wrongName, "output.md"), "output", "utf8");
			await mkdir(extraContent);
			await writeFile(join(extraContent, "output.md"), "output", "utf8");
			await writeFile(join(extraContent, "extra.md"), "extra", "utf8");
			await mkdir(symlinkTarget);
			await writeFile(join(symlinkTarget, "output.md"), "output", "utf8");
			await symlink(symlinkTarget, symlinkPath);
			await mkdir(outputSymlink);
			await writeFile(outsideOutput, "outside output", "utf8");
			await symlink(outsideOutput, join(outputSymlink, "output.md"));
			await Promise.all(
				[
					unrelated,
					wrongName,
					malformed,
					extraContent,
					symlinkTarget,
					outputSymlink,
				].map((path) =>
					setDirectoryAge(path, NOW - SUBAGENT_OUTPUT_RETENTION_MS - 1),
				),
			);

			await collectStaleSubagentOutputs({ tempRoot, now: NOW });

			for (const path of [
				unrelated,
				wrongName,
				regularFile,
				malformed,
				extraContent,
				symlinkPath,
				outputSymlink,
			]) {
				expect(await exists(path)).toBe(true);
			}
		});
	});

	test("swallows missing and non-directory roots and is idempotent", async () => {
		await withTempRoot(async (tempRoot) => {
			await expect(
				collectStaleSubagentOutputs({
					tempRoot: join(tempRoot, "missing"),
					now: NOW,
				}),
			).resolves.toBeUndefined();
			const rootFile = join(tempRoot, "root-file");
			await writeFile(rootFile, "not a directory", "utf8");
			await expect(
				collectStaleSubagentOutputs({ tempRoot: rootFile, now: NOW }),
			).resolves.toBeUndefined();

			const directory = await createManagedDirectory(tempRoot, "hhhhhh");
			await setDirectoryAge(directory, NOW - SUBAGENT_OUTPUT_RETENTION_MS - 1);
			await collectStaleSubagentOutputs({ tempRoot, now: NOW });
			await expect(
				collectStaleSubagentOutputs({ tempRoot, now: NOW }),
			).resolves.toBeUndefined();
		});
	});

	test("caps removals per cleanup pass", async () => {
		await withTempRoot(async (tempRoot) => {
			const directories = await Promise.all(
				Array.from({ length: 17 }, async (_, index) => {
					const directory = await createManagedDirectory(
						tempRoot,
						index.toString().padStart(6, "0"),
					);
					await setDirectoryAge(
						directory,
						NOW - SUBAGENT_OUTPUT_RETENTION_MS - 1,
					);
					return directory;
				}),
			);

			await collectStaleSubagentOutputs({ tempRoot, now: NOW });
			expect(
				(
					await Promise.all(directories.map((directory) => exists(directory)))
				).filter(Boolean),
			).toHaveLength(1);

			await collectStaleSubagentOutputs({ tempRoot, now: NOW });
			expect(
				await Promise.all(directories.map((directory) => exists(directory))),
			).toEqual(Array(17).fill(false));
		});
	});

	test("bounds inspection and rotates the candidate window", async () => {
		await withTempRoot(async (tempRoot) => {
			const candidateCount = 65;
			const rotationNow = SUBAGENT_OUTPUT_RETENTION_MS + 1;
			for (let index = 0; index < candidateCount - 1; index++) {
				const directory = join(
					tempRoot,
					`pi-subagent-${index.toString().padStart(6, "0")}`,
				);
				await mkdir(directory);
				await setDirectoryAge(
					directory,
					rotationNow - SUBAGENT_OUTPUT_RETENTION_MS - 1,
				);
			}
			const lastCandidate = await createManagedDirectory(tempRoot, "000064");
			await setDirectoryAge(
				lastCandidate,
				rotationNow - SUBAGENT_OUTPUT_RETENTION_MS - 1,
			);

			await collectStaleSubagentOutputs({ tempRoot, now: rotationNow });
			expect(await exists(lastCandidate)).toBe(true);

			await collectStaleSubagentOutputs({ tempRoot, now: rotationNow });
			expect(await exists(lastCandidate)).toBe(false);
		});
	});

	test("continues past a selected candidate whose cleanup fails", async () => {
		await withTempRoot(async (tempRoot) => {
			const rotationNow = SUBAGENT_OUTPUT_RETENTION_MS + 1;
			const directories = await Promise.all(
				Array.from({ length: 17 }, async (_, index) => {
					const directory = await createManagedDirectory(
						tempRoot,
						index.toString().padStart(6, "0"),
					);
					await setDirectoryAge(
						directory,
						rotationNow - SUBAGENT_OUTPUT_RETENTION_MS - 1,
					);
					return directory;
				}),
			);
			const selected = directories[0]!;
			await chmod(selected, 0o500);

			try {
				await expect(
					collectStaleSubagentOutputs({ tempRoot, now: rotationNow }),
				).resolves.toBeUndefined();
				expect(await exists(selected)).toBe(true);
				const remaining = (
					await Promise.all(
						directories.map(async (directory) => ({
							directory,
							exists: await exists(directory),
						})),
					)
				)
					.filter(({ exists }) => exists)
					.map(({ directory }) => directory);
				expect(remaining).toEqual([selected, directories[16]!]);
			} finally {
				await chmod(selected, 0o700);
			}
		});
	});

	test("removes a partial output and preserves the original write error", async () => {
		await withTempRoot(async (tempRoot) => {
			const writeError = new Error("write failed");
			let outputPath: string | undefined;

			await expect(
				createSubagentOutputFile("full output", { tempRoot }, async (path) => {
					outputPath = path;
					await writeFile(path, "partial output", "utf8");
					throw writeError;
				}),
			).rejects.toBe(writeError);
			expect(outputPath).toBeDefined();
			expect(await exists(outputPath!)).toBe(false);
			expect(await exists(dirname(outputPath!))).toBe(false);
		});
	});

	test("runs cleanup after session-start history reconstruction", async () => {
		await withTempRoot(async (tempRoot) => {
			const directory = await createManagedDirectory(tempRoot, "iiiiii");
			await setDirectoryAge(directory, NOW - SUBAGENT_OUTPUT_RETENTION_MS - 1);
			const previousConfigDirectory = process.env["PI_CODING_AGENT_DIR"];
			const previousChild = process.env["PI_SUBAGENT_CHILD"];
			const handlers = new Map<string, (...args: any[]) => unknown>();
			try {
				process.env["PI_CODING_AGENT_DIR"] = tempRoot;
				delete process.env["PI_SUBAGENT_CHILD"];
				subagentExtension(
					{
						on: (event: string, handler: (...args: any[]) => unknown) =>
							handlers.set(event, handler),
						registerTool: () => {},
						registerCommand: () => {},
						registerShortcut: () => {},
						appendEntry: () => {},
					} as any,
					() => collectStaleSubagentOutputs({ tempRoot, now: NOW }),
				);
				await handlers.get("session_start")?.(
					{},
					{ sessionManager: { getBranch: () => [] } },
				);
				expect(await exists(directory)).toBe(false);
			} finally {
				if (previousConfigDirectory === undefined) {
					delete process.env["PI_CODING_AGENT_DIR"];
				} else {
					process.env["PI_CODING_AGENT_DIR"] = previousConfigDirectory;
				}
				if (previousChild === undefined)
					delete process.env["PI_SUBAGENT_CHILD"];
				else process.env["PI_SUBAGENT_CHILD"] = previousChild;
			}
		});
	});
});
