import { expect, test } from "bun:test";
import toolsExtension from "../extensions/tools.js";
import { builtinTool, createMockContext, createMockPi } from "./support.js";

test("restoring tools waits for deferred registrations before replacing the loadout", async () => {
	const allTools = [builtinTool("read"), builtinTool("bash")];
	const { pi, rawPi, events } = createMockPi({
		activeTools: ["read", "bash"],
		allTools,
	});
	toolsExtension(pi);
	const { ctx } = createMockContext({
		sessionManager: {
			getBranch: () => [
				{
					type: "custom",
					customType: "tools-config",
					data: { enabledTools: ["read", "remote"] },
				},
			],
		},
	});

	await events.get("session_start")?.[0]?.({}, ctx);
	expect(rawPi.getActiveTools()).toEqual(["read", "bash"]);

	allTools.push(builtinTool("remote"));
	await events.get("session_tree")?.[0]?.({}, ctx);
	expect(rawPi.getActiveTools()).toEqual(["read", "remote"]);
});
