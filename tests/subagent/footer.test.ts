import { expect, mock, test } from "bun:test";
import type { ConversationSnapshot } from "../../extensions/subagent/conversation.js";
import { registerSubagentCostStatusLifecycle } from "../../extensions/subagent/footer.js";
import { fakeAgent } from "./helpers/fake-agent.js";

function withCost(
	conversationId: string,
	total: number,
	parentConversationId?: string,
): ConversationSnapshot {
	return fakeAgent({
		conversationId,
		parentConversationId,
		status: { kind: "running" },
		cost: {
			input: total,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total,
		},
	});
}

test("footer cost is monotonic across realtime updates and removals", () => {
	const handlers = new Map<string, (event: unknown, context: any) => void>();
	let listener:
		| ((
				conversation: { snapshot(): ConversationSnapshot },
				kind: string,
		  ) => void)
		| undefined;
	const unsubscribe = mock();
	const source = {
		listConversations: () => [] as ConversationSnapshot[],
		onConversationUpdate(next: typeof listener) {
			listener = next;
			return () => {
				listener = undefined;
				unsubscribe();
			};
		},
	};
	registerSubagentCostStatusLifecycle(
		{
			on: (event: string, handler: (event: unknown, context: any) => void) =>
				handlers.set(event, handler),
		} as any,
		source as any,
	);
	const setStatus = mock();
	const context = { hasUI: true, ui: { setStatus } };
	const emit = (snapshot: ConversationSnapshot, kind = "usage") =>
		listener?.({ snapshot: () => snapshot }, kind);

	handlers.get("session_start")?.({}, context);
	expect(setStatus).toHaveBeenLastCalledWith("subagent-cost", undefined);

	emit(withCost("root", 0));
	expect(setStatus).toHaveBeenLastCalledWith("subagent-cost", "subs $0.0000");
	emit(withCost("root", 0.01));
	expect(setStatus).toHaveBeenLastCalledWith("subagent-cost", "subs $0.0100");
	emit(withCost("child", 0.02, "root"));
	expect(setStatus).toHaveBeenLastCalledWith("subagent-cost", "subs $0.0300");

	const callsBeforeRemoval = setStatus.mock.calls.length;
	emit(withCost("root", 0.01), "removed");
	expect(setStatus).toHaveBeenCalledTimes(callsBeforeRemoval);
	emit(withCost("root", 0.03));
	expect(setStatus).toHaveBeenLastCalledWith("subagent-cost", "subs $0.0500");

	handlers.get("session_shutdown")?.({}, context);
	expect(setStatus).toHaveBeenLastCalledWith("subagent-cost", undefined);
	expect(unsubscribe).toHaveBeenCalledTimes(1);
	expect(listener).toBeUndefined();
});

test("footer cost seeds all retained conversations at session start", () => {
	const handlers = new Map<string, (event: unknown, context: any) => void>();
	const source = {
		listConversations: () => [
			withCost("root", 0.01),
			withCost("child", 0.02, "root"),
		],
		onConversationUpdate: () => () => {},
	};
	registerSubagentCostStatusLifecycle(
		{
			on: (event: string, handler: (event: unknown, context: any) => void) =>
				handlers.set(event, handler),
		} as any,
		source as any,
	);
	const setStatus = mock();

	handlers.get("session_start")?.({}, { hasUI: true, ui: { setStatus } });

	expect(setStatus).toHaveBeenCalledWith("subagent-cost", "subs $0.0300");
});
