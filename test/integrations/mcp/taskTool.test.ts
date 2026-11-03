import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { CapturingSink, MAJORS, install } from "./_majors.js";

const V1 = MAJORS[0]!;

/** A 1.x tool registered with an object at `.handler`, which Baton does not wrap. */
function taskTool(seen: Record<string, unknown>[], run: () => Promise<unknown> = async () => undefined): McpServer {
  const server = new McpServer({ name: "vendor", version: "1.0.0" }, { taskStore: new InMemoryTaskStore() });
  server.experimental.tasks.registerToolTask(
    "export",
    { inputSchema: { format: z.string() }, execution: { taskSupport: "optional" } },
    {
      createTask: async (args, extra) => {
        seen.push({ ...args });
        await run();
        const task = await extra.taskStore.createTask({ pollInterval: 1 });
        await extra.taskStore.storeTaskResult(task.taskId, "completed", {
          content: [{ type: "text", text: "exported" }],
        });
        return { task };
      },
      getTask: async (_args, extra) => await extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)) as never,
    },
  );
  return server;
}

describe("a 1.x task-based tool, which Baton does not wrap", () => {
  it("never sees the user_goal Baton adds to its schema", async () => {
    const seen: Record<string, unknown>[] = [];
    const server = taskTool(seen);
    install(server, new CapturingSink());
    const client = await V1.connect(server);

    const listed = await client.listTools();
    expect(Object.keys(listed.tools[0].inputSchema.properties)).toContain("user_goal");

    const result = await client.callTool({ name: "export", arguments: { format: "csv", user_goal: "1: export" } });
    expect(result.content).toEqual([{ type: "text", text: "exported" }]);
    expect(seen).toEqual([{ format: "csv" }]);
  });

  it("gives its user_goal to no wrapped tool it runs in-process", async () => {
    const sink = new CapturingSink();
    const server = taskTool([], async () => {
      await (notify.handler as (args: unknown, extra: unknown) => Promise<unknown>)({ to: "ops" }, {});
    });
    const notify = server.registerTool("notify", { inputSchema: { to: z.string() } }, () => ({
      content: [{ type: "text" as const, text: "sent" }],
    }));
    install(server, sink);
    const client = await V1.connect(server);

    await client.callTool({ name: "export", arguments: { format: "csv", user_goal: "1: export" } });
    const starts = sink.events.filter((e) => e.event_type === "tool_call_start");
    expect(starts.map((e) => (e.payload as { call_intent: unknown }).call_intent)).toEqual([null]);
  });
});
