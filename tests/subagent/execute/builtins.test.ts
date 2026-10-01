import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createMcpExtension,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { Conversation } from "../../../extensions/subagent/conversation.js";
import {
	DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
	executeGeneration,
} from "../../../extensions/subagent/execute.js";
import { createMockContext } from "../../support.js";
import { ZERO_USAGE } from "../helpers/fake-agent.js";

test("children execute MCP calls through codemode while preserving trust and tool allowlists", async () => {
	const root = await mkdtemp(join(tmpdir(), "subagent-builtins-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultTools: ["read", "codemode", "tool_search"] }),
	);
	const unknownCwd = join(root, "unknown-project");
	const trustedCwd = join(root, "trusted-project");
	for (const cwd of [unknownCwd, trustedCwd]) {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "mcp.json"), '{"mcpServers":{}}');
	}
	new ProjectTrustStore(agentDir).set(trustedCwd, true);
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = await request.json();
			if (message.id === undefined) return new Response(null, { status: 202 });
			let result: unknown;
			if (message.method === "initialize") {
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "fixture", version: "1" },
				};
			} else if (message.method === "tools/list") {
				result = {
					tools: [{ name: "echo", inputSchema: { type: "object" } }],
				};
			} else if (message.method === "tools/call") {
				calls++;
				result = { content: [{ type: "text", text: "MCP works" }] };
			} else {
				result = {};
			}
			return Response.json({ jsonrpc: "2.0", id: message.id, result });
		},
	});
	// Keep MCP config and logs in the fixture, independent of the developer's agent directory.
	class Loader extends DefaultResourceLoader {
		constructor(
			options: ConstructorParameters<typeof DefaultResourceLoader>[0],
		) {
			super({
				...options,
				extensionFactories: options.extensionFactories?.map((extension) =>
					typeof extension !== "function" && extension.name === "mcp"
						? {
								...extension,
								factory: createMcpExtension({
									logPath: join(root, "mcp.log"),
									loadConfig: (ctx) => ({
										errors: [],
										servers: ctx.isProjectTrusted()
											? [
													{
														name: "fixture",
														config: { url: server.url.href },
														source: "fixture",
													},
												]
											: [],
									}),
								}),
							}
						: extension,
				),
			});
		}
	}
	try {
		for (const [parentTrusted, tools, cwd, trusted] of [
			[true, undefined, root, true],
			[false, undefined, root, false],
			[true, ["read"], root, true],
			[true, undefined, unknownCwd, false],
			[false, undefined, trustedCwd, true],
		] as const) {
			const runtime = await ModelRuntime.create({
				modelsPath: null,
				refreshOnCreate: false,
				credentials: {
					read: async () => undefined,
					list: async () => [],
					modify: async () => {
						throw new Error("No stored credentials in this test");
					},
					delete: async () => {},
				},
			});
			const registry = new ModelRegistry(runtime);
			const model = registry.getAll()[0]!;
			await runtime.setRuntimeApiKey(model.provider, "synthetic-key");
			const { ctx } = createMockContext({
				cwd: root,
				model,
				modelRegistry: registry,
				isProjectTrusted: () => parentTrusted,
			});
			const agent = new Conversation(
				"amber-acorn" as never,
				{
					name: "worker",
					description: "",
					systemPrompt: "",
					source: "project",
					...(tools ? { tools: [...tools] } : {}),
				} as never,
				{
					kind: "spawn",
					agent: "worker",
					prompt: "work",
					label: "work",
					...(cwd === root ? {} : { cwd }),
				},
				() => {},
			);
			let child: AgentSession | undefined;
			const callsBefore = calls;
			try {
				const result = await executeGeneration(
					ctx,
					agent,
					agent.latestGeneration,
					undefined,
					{
						...DEFAULT_EXECUTE_GENERATION_DEPENDENCIES,
						ResourceLoader: Loader,
						getAgentDir: () => agentDir,
						createAgentSession: async (options) => {
							const created = await createAgentSession({
								...options,
								modelRuntime: runtime,
							});
							child = created.session;
							// Replace only provider streaming; the agent loop and nested tools use the real SDK.
							let requested = false;
							child.agent.streamFunction = () => {
								const message: AssistantMessage = {
									role: "assistant",
									api: model.api,
									provider: model.provider,
									model: model.id,
									content: requested
										? [{ type: "text", text: "done" }]
										: [
												{
													type: "toolCall",
													id: "test-call",
													name: "codemode",
													arguments: {
														code: "text(await tools.mcp__fixture__echo({}))",
													},
												},
											],
									usage: ZERO_USAGE,
									stopReason: requested ? "stop" : "toolUse",
									timestamp: Date.now(),
								};
								requested = true;
								const stream = createAssistantMessageEventStream();
								stream.push({ type: "start", partial: message });
								stream.push({
									type: "done",
									reason: message.stopReason as "stop" | "toolUse",
									message,
								});
								return stream;
							};
							return created;
						},
					},
				);
				assert.equal(result.status.kind, "done");
				assert.equal(
					"outcome" in result.status && result.status.outcome,
					"completed",
					JSON.stringify(result),
				);
				assert.ok(child);
				assert.equal(
					child.extensionRunner.createContext().isProjectTrusted(),
					trusted,
				);
				if (!tools) {
					assert.ok(
						child.getAllTools().some((tool) => tool.name === "codemode"),
					);
					assert.ok(
						child.getAllTools().some((tool) => tool.name === "tool_search"),
					);
				}
				const response = child.messages.find(
					(message) => message.role === "toolResult",
				);
				assert.ok(response?.role === "toolResult");
				assert.equal(
					Boolean(response.isError),
					!trusted || Boolean(tools),
					JSON.stringify(response),
				);
				if (trusted && !tools)
					assert.ok(JSON.stringify(response).includes("MCP works"));
				if (tools) assert.ok(!child.getActiveToolNames().includes("codemode"));
				assert.equal(calls - callsBefore, trusted && !tools ? 1 : 0);
			} finally {
				await child?.extensionRunner.emit({
					type: "session_shutdown",
					reason: "quit",
				});
				child?.dispose();
			}
		}
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});
