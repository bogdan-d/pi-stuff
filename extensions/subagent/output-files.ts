import type { Dirent, Stats } from "node:fs";
import {
	lstat,
	mkdtemp,
	readdir,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SUBAGENT_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const OUTPUT_DIRECTORY_PREFIX = "pi-subagent-";
const OUTPUT_DIRECTORY_PATTERN = /^pi-subagent-[A-Za-z0-9]{6}$/;
const OUTPUT_FILENAME = "output.md";
const QUARANTINE_DIRECTORY_PREFIX = ".pi-subagent-gc-";
const MAX_CANDIDATE_INSPECTIONS_PER_PASS = 64;
const MAX_DELETION_ATTEMPTS_PER_PASS = 16;

const inspectionCursors = new Map<string, number>();

export interface CreateSubagentOutputFileOptions {
	tempRoot?: string;
}

export interface CollectStaleSubagentOutputsOptions {
	tempRoot?: string;
	now?: number | Date;
}

type WriteOutputFile = (path: string, output: string) => Promise<void>;

async function writeOutputFile(path: string, output: string): Promise<void> {
	await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
}

function hasSameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function readManagedOutputStat(
	directory: string,
): Promise<Stats | undefined> {
	const entries = await readdir(directory, { withFileTypes: true });
	if (
		entries.length !== 1 ||
		entries[0]?.name !== OUTPUT_FILENAME ||
		!entries[0].isFile() ||
		entries[0].isSymbolicLink()
	) {
		return undefined;
	}

	const outputStat = await lstat(join(directory, OUTPUT_FILENAME));
	return outputStat.isFile() && !outputStat.isSymbolicLink()
		? outputStat
		: undefined;
}

/**
 * Moves a validated candidate into a private same-filesystem quarantine before
 * making any destructive change. A raced or malformed candidate is retained.
 */
async function quarantineAndRemoveManagedOutput(
	directory: string,
	directoryStat: Stats,
	outputStat: Stats,
	tempRoot: string,
): Promise<void> {
	let quarantineRoot: string | undefined;
	let candidateQuarantined = false;
	try {
		quarantineRoot = await mkdtemp(join(tempRoot, QUARANTINE_DIRECTORY_PREFIX));
		const quarantinedDirectory = join(quarantineRoot, "candidate");
		const quarantinedOutput = join(quarantineRoot, OUTPUT_FILENAME);

		await rename(directory, quarantinedDirectory);
		candidateQuarantined = true;

		const quarantinedDirectoryStat = await lstat(quarantinedDirectory);
		if (
			!quarantinedDirectoryStat.isDirectory() ||
			quarantinedDirectoryStat.isSymbolicLink() ||
			!hasSameIdentity(directoryStat, quarantinedDirectoryStat)
		) {
			return;
		}

		const revalidatedOutputStat =
			await readManagedOutputStat(quarantinedDirectory);
		if (
			!revalidatedOutputStat ||
			!hasSameIdentity(outputStat, revalidatedOutputStat)
		) {
			return;
		}

		await rename(
			join(quarantinedDirectory, OUTPUT_FILENAME),
			quarantinedOutput,
		);
		const movedOutputStat = await lstat(quarantinedOutput);
		if (
			!movedOutputStat.isFile() ||
			movedOutputStat.isSymbolicLink() ||
			!hasSameIdentity(outputStat, movedOutputStat)
		) {
			return;
		}
		const emptiedDirectoryStat = await lstat(quarantinedDirectory);
		if (
			!emptiedDirectoryStat.isDirectory() ||
			emptiedDirectoryStat.isSymbolicLink() ||
			!hasSameIdentity(directoryStat, emptiedDirectoryStat)
		) {
			return;
		}
		if ((await readdir(quarantinedDirectory)).length !== 0) return;

		await rmdir(quarantinedDirectory);
		await unlink(quarantinedOutput);
		await rmdir(quarantineRoot);
	} finally {
		// Never recursively remove a quarantine. On failure it safely retains
		// whichever identities were moved; an unused empty root can be discarded.
		if (quarantineRoot && !candidateQuarantined) {
			await rmdir(quarantineRoot).catch(() => {});
		}
	}
}

async function cleanFailedCreation(directory: string): Promise<void> {
	const directoryStat = await lstat(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
	const entries = await readdir(directory);
	if (entries.length === 0) {
		await rmdir(directory);
		return;
	}
	const outputStat = await readManagedOutputStat(directory);
	if (outputStat) {
		await quarantineAndRemoveManagedOutput(
			directory,
			directoryStat,
			outputStat,
			dirname(directory),
		);
	}
}

export async function createSubagentOutputFile(
	output: string,
	options: CreateSubagentOutputFileOptions = {},
	writeOutput: WriteOutputFile = writeOutputFile,
): Promise<string> {
	let directory: string | undefined;
	try {
		directory = await mkdtemp(
			join(options.tempRoot ?? tmpdir(), OUTPUT_DIRECTORY_PREFIX),
		);
		const outputPath = join(directory, OUTPUT_FILENAME);
		await writeOutput(outputPath, output);
		return outputPath;
	} catch (error) {
		if (directory) await cleanFailedCreation(directory).catch(() => {});
		throw error;
	}
}

function isStale(stat: Stats, now: number): boolean {
	return stat.mtimeMs <= now - SUBAGENT_OUTPUT_RETENTION_MS;
}

export async function collectStaleSubagentOutputs(
	options: CollectStaleSubagentOutputsOptions = {},
): Promise<void> {
	const tempRoot = options.tempRoot ?? tmpdir();
	const now =
		options.now instanceof Date
			? options.now.getTime()
			: (options.now ?? Date.now());
	let entries: Dirent<string>[];
	try {
		entries = await readdir(tempRoot, { withFileTypes: true });
	} catch {
		return;
	}

	const candidates = entries
		.filter((entry) => OUTPUT_DIRECTORY_PATTERN.test(entry.name))
		.sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);
	if (!candidates.length) return;
	const startIndex = (inspectionCursors.get(tempRoot) ?? 0) % candidates.length;
	const inspectionWindow = Math.min(
		MAX_CANDIDATE_INSPECTIONS_PER_PASS,
		candidates.length,
	);
	const rotatedCandidates = [
		...candidates.slice(startIndex),
		...candidates.slice(0, startIndex),
	];

	let inspections = 0;
	let deletionAttempts = 0;
	for (const entry of rotatedCandidates) {
		if (
			inspections >= MAX_CANDIDATE_INSPECTIONS_PER_PASS ||
			deletionAttempts >= MAX_DELETION_ATTEMPTS_PER_PASS
		) {
			return;
		}
		inspections++;
		inspectionCursors.set(
			tempRoot,
			(startIndex + Math.min(inspections, inspectionWindow)) %
				candidates.length,
		);

		const directory = join(tempRoot, entry.name);
		try {
			const directoryStat = await lstat(directory);
			if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
				continue;
			if (!isStale(directoryStat, now)) continue;
			const outputStat = await readManagedOutputStat(directory);
			if (!outputStat) continue;
			deletionAttempts++;
			await quarantineAndRemoveManagedOutput(
				directory,
				directoryStat,
				outputStat,
				tempRoot,
			);
		} catch {
			// Cleanup is deliberately best-effort.
		}
	}
}
