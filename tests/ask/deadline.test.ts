import {
	afterEach,
	describe,
	expect,
	it,
	jest,
	mock,
	setSystemTime,
} from "bun:test";
import {
	createDeadlineSignal,
	resolveTimeoutMs,
} from "../../extensions/ask/deadline.js";
import type {
	AskSettings,
	TimeoutOnInput,
} from "../../extensions/ask/settings.js";

const settings = (
	timeoutOnInput: TimeoutOnInput = "never-reset",
	timeoutMs = 50,
): AskSettings => ({
	timeoutMs,
	timeoutOnInput,
});

afterEach(() => {
	jest.useRealTimers();
});

function advanceTimersByTime(milliseconds: number): void {
	const now = Date.now();
	jest.advanceTimersByTime(milliseconds);
	setSystemTime(now + milliseconds);
}

describe("resolveTimeoutMs", () => {
	it.each([undefined, false])(
		"disables the configured timeout when the flag is %s",
		(enabled) => {
			expect(resolveTimeoutMs(enabled, settings())).toBeUndefined();
		},
	);

	it("uses the configured duration when enabled", () => {
		expect(resolveTimeoutMs(true, settings("never-reset", 2_500))).toBe(2_500);
	});
});

describe("createDeadlineSignal", () => {
	it("returns an undefined signal and no-op disposer without a parent or timeout", () => {
		const deadline = createDeadlineSignal(undefined, undefined);

		expect(deadline.signal).toBeUndefined();
		expect(deadline.deadlineAt).toBeUndefined();
		expect(deadline.timedOut).toBe(false);
		expect(deadline.handleInput()).toBe(false);
		expect(() => deadline.dispose()).not.toThrow();
	});

	it("returns an already-aborted signal when the parent is already aborted", () => {
		const parent = new AbortController();
		const reason = new Error("cancelled");
		parent.abort(reason);

		jest.useFakeTimers();
		const deadline = createDeadlineSignal(parent.signal, true, settings());

		expect(deadline.signal?.aborted).toBe(true);
		expect(deadline.signal?.reason).toBe(reason);
		expect(deadline.deadlineAt).toBeUndefined();
		expect(deadline.timedOut).toBe(false);
		expect(jest.getTimerCount()).toBe(0);
		deadline.dispose();
	});

	it("propagates the parent abort exactly once", () => {
		const parent = new AbortController();
		const deadline = createDeadlineSignal(parent.signal, undefined);
		const onAbort = mock();
		deadline.signal?.addEventListener("abort", onAbort);

		const reason = new Error("cancelled");
		parent.abort(reason);
		parent.abort(new Error("ignored"));

		expect(deadline.signal?.aborted).toBe(true);
		expect(deadline.signal?.reason).toBe(reason);
		expect(deadline.timedOut).toBe(false);
		expect(onAbort).toHaveBeenCalledTimes(1);
	});

	it("aborts exactly once when a positive timeout expires", () => {
		jest.useFakeTimers();
		const deadline = createDeadlineSignal(undefined, true, settings());
		expect(deadline.deadlineAt).toBe(Date.now() + 50);
		const onAbort = mock();
		deadline.signal?.addEventListener("abort", onAbort);

		advanceTimersByTime(49);
		expect(deadline.signal?.aborted).toBe(false);
		expect(deadline.timedOut).toBe(false);

		advanceTimersByTime(1);
		advanceTimersByTime(100);

		expect(deadline.signal?.aborted).toBe(true);
		expect(deadline.timedOut).toBe(true);
		expect(onAbort).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	});

	it("resets the timeout from the latest input", () => {
		jest.useFakeTimers();
		const deadline = createDeadlineSignal(undefined, true, settings("reset"));

		advanceTimersByTime(40);
		expect(deadline.handleInput()).toBe(true);
		expect(deadline.deadlineAt).toBe(Date.now() + 50);

		advanceTimersByTime(49);
		expect(deadline.signal?.aborted).toBe(false);
		advanceTimersByTime(1);
		expect(deadline.signal?.aborted).toBe(true);
		expect(deadline.timedOut).toBe(true);
	});

	it("cancels only the timeout on the first input", () => {
		jest.useFakeTimers();
		const deadline = createDeadlineSignal(undefined, true, settings("cancel"));

		expect(deadline.handleInput()).toBe(true);
		expect(deadline.deadlineAt).toBeUndefined();
		expect(jest.getTimerCount()).toBe(0);

		advanceTimersByTime(100);
		expect(deadline.signal?.aborted).toBe(false);
		expect(deadline.timedOut).toBe(false);
		expect(deadline.handleInput()).toBe(false);
	});

	it("does not change a never-reset timeout on input", () => {
		jest.useFakeTimers();
		const deadline = createDeadlineSignal(
			undefined,
			true,
			settings("never-reset"),
		);
		const initialDeadline = deadline.deadlineAt;

		advanceTimersByTime(25);
		expect(deadline.handleInput()).toBe(false);
		expect(deadline.deadlineAt).toBe(initialDeadline);
	});

	it.each([undefined, false])(
		"does not create a timer when the flag is %s",
		(enabled) => {
			jest.useFakeTimers();
			const parent = new AbortController();
			const deadline = createDeadlineSignal(parent.signal, enabled, settings());

			expect(deadline.signal).toBeDefined();
			expect(deadline.deadlineAt).toBeUndefined();
			expect(jest.getTimerCount()).toBe(0);
			deadline.dispose();
		},
	);

	it("disposes the timer and parent listener, preventing later abort", () => {
		jest.useFakeTimers();
		const parent = new AbortController();
		const deadline = createDeadlineSignal(
			parent.signal,
			true,
			settings("reset", 100),
		);
		const onAbort = mock();
		deadline.signal?.addEventListener("abort", onAbort);

		deadline.dispose();
		expect(jest.getTimerCount()).toBe(0);

		parent.abort();
		advanceTimersByTime(100);

		expect(deadline.signal?.aborted).toBe(false);
		expect(deadline.timedOut).toBe(false);
		expect(deadline.handleInput()).toBe(false);
		expect(onAbort).not.toHaveBeenCalled();

		deadline.dispose();
	});
});
