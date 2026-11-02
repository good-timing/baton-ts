import { describe, expect, it, vi } from "vitest";
import { DROP_REASONS, type DropReason, PROCESS_DROPS } from "../src/drops.js";
import { ToolCallStartEventSchema, type Event } from "../src/events.js";
import { emit } from "../src/integrations/mcp/emit.js";
import { Client } from "../src/index.js";
import { safeWrite, type Sink } from "../src/sinks.js";
import { acceptAll, results, sentIn, sequences, sinkWith } from "./_sink.js";

function makeEvent(): Event {
  return ToolCallStartEventSchema.parse({
    tenant_id: "t",
    vendor_id: "v",
    session_id: "s",
    sequence_number: 0,
    captured_at: new Date().toISOString(),
    consent_token: "ct",
    call_id: "call-1",
    payload: { tool_name: "lookup" },
  });
}

const neverAnswers = (_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

function httpSink(fetchImpl: typeof fetch, options: { bufferSize?: number; shutdownFlushTimeoutMs?: number } = {}) {
  return sinkWith(fetchImpl, { maxRetries: 0, ...options });
}

const writeRejects: Sink = {
  write: () => Promise.reject(new Error("disk full")),
  flush: () => Promise.resolve(),
  aclose: () => Promise.resolve(),
};

function collectWarnings(): { seen: string[]; restore: () => void } {
  const seen: string[] = [];
  const spy = vi.spyOn(process, "emitWarning").mockImplementation((w: string | Error) => {
    seen.push(String(w));
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    seen,
    restore: () => {
      spy.mockRestore();
      stderr.mockRestore();
    },
  };
}

const scenarios: Record<string, [DropReason, () => Promise<void>]> = {
  buffer_full: [
    "buffer_full",
    async () => {
      const sink = httpSink(neverAnswers, { bufferSize: 2 });
      const internals = sink as unknown as { enqueue: (event: Event) => void };
      for (let i = 0; i < 3; i += 1) internals.enqueue(makeEvent());
    },
  ],
  refused: [
    "refused",
    async () => {
      const sink = httpSink(() => Promise.resolve(new Response("no", { status: 400 })));
      await sink.write(makeEvent());
      await sink.flush();
    },
  ],
  encode_failed: [
    "encode_failed",
    () =>
      emit(writeRejects, () => {
        throw new Error("unbuildable");
      }),
  ],
  write_failed: ["write_failed", () => safeWrite(writeRejects, makeEvent())],
  after_close: [
    "after_close",
    async () => {
      const client = new Client({ sink: writeRejects, vendorId: "v" });
      await client.aclose();
      await client.annotate({ whatHappened: "late" });
    },
  ],
  unsent_at_close: [
    "unsent_at_close",
    async () => {
      const sink = httpSink(neverAnswers, { shutdownFlushTimeoutMs: 20 });
      await sink.write(makeEvent());
      await sink.aclose();
    },
  ],
  write_abandoned_at_close: [
    "unsent_at_close",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      try {
        const client = new Client({ sink: { ...writeRejects, write: () => new Promise(() => {}) }, vendorId: "v" });
        void client.annotate({ whatHappened: "stuck" });
        const closed = client.aclose();
        await vi.advanceTimersByTimeAsync(3250);
        await closed;
      } finally {
        vi.useRealTimers();
      }
    },
  ],
};

describe("every event is delivered or counted (SPEC §11.2)", () => {
  it("has a scenario for every reason", () => {
    expect(new Set(Object.values(scenarios).map(([reason]) => reason))).toEqual(new Set(DROP_REASONS));
  });

  it.each(Object.keys(scenarios))("counts a dropped event once under its reason (%s)", async (name) => {
    const [reason, scenario] = scenarios[name]!;
    const warnings = collectWarnings();
    try {
      await scenario();
      expect(PROCESS_DROPS.total()).toEqual({ [reason]: 1 });
    } finally {
      warnings.restore();
    }
  });

  it("says what was lost at the first delivery after a loss", async () => {
    const statuses = [400, 202, 202];
    const sink = httpSink(() => Promise.resolve(new Response(null, { status: statuses.shift()! })));
    const warnings = collectWarnings();
    try {
      for (let i = 0; i < 3; i += 1) {
        await sink.write(makeEvent());
        await sink.flush();
      }
      expect(warnings.seen.filter((w) => w.includes("delivering again"))).toEqual([
        "baton: delivering again; 1 event(s) lost before this: refused 1.",
      ]);
    } finally {
      warnings.restore();
    }
  });

  it("says so once a minute when loss goes on beside delivery", async () => {
    const statuses = [400, 202, 400, 202];
    const sink = httpSink(() => Promise.resolve(new Response(null, { status: statuses.shift()! })));
    const warnings = collectWarnings();
    try {
      for (let i = 0; i < 4; i += 1) {
        await sink.write(makeEvent());
        await sink.flush();
      }
      expect(warnings.seen.filter((w) => w.includes("delivering again"))).toHaveLength(1);
    } finally {
      warnings.restore();
    }
  });

  it("never pushes out an event while it is being sent", async () => {
    let answer: (response: Response) => void = () => {};
    const posted: number[][] = [];
    const fetchImpl = (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(sequences(init));
      const events = sentIn(init);
      return new Promise<Response>((resolve) => (answer = resolve)).then(() => results(events));
    };
    const sink = httpSink(fetchImpl, { bufferSize: 2 });
    const warnings = collectWarnings();
    try {
      for (let i = 1; i <= 2; i += 1) await sink.write({ ...makeEvent(), sequence_number: i });
      const flushing = sink.flush();
      await vi.waitFor(() => expect(posted).toEqual([[1, 2]]));
      await sink.write({ ...makeEvent(), sequence_number: 3 });
      answer(new Response());
      await vi.waitFor(() => expect(posted).toEqual([[1, 2], [3]]));
      answer(new Response());
      await flushing;
      await sink.aclose();
      expect(PROCESS_DROPS.total()).toEqual({});
    } finally {
      warnings.restore();
    }
  });

  it("counts an event once when the buffer is full while its batch is refused", async () => {
    let answer: ((response: Response) => void) | undefined;
    const posted: number[][] = [];
    const fetchImpl = (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(sequences(init));
      if (answer === undefined) return new Promise<Response>((resolve) => (answer = resolve));
      return Promise.resolve(results(sentIn(init)));
    };
    const sink = httpSink(fetchImpl, { bufferSize: 2 });
    const warnings = collectWarnings();
    try {
      for (let i = 1; i <= 2; i += 1) await sink.write({ ...makeEvent(), sequence_number: i });
      const flushing = sink.flush();
      await vi.waitFor(() => expect(answer).toBeDefined());
      for (let i = 3; i <= 5; i += 1) await sink.write({ ...makeEvent(), sequence_number: i });
      answer!(new Response(null, { status: 400 }));
      await flushing;
      expect(PROCESS_DROPS.total()).toEqual({ buffer_full: 1, refused: 2 });
      expect(posted).toEqual([[1, 2], [4, 5]]);
    } finally {
      await sink.aclose();
      warnings.restore();
    }
  });

  it("counts and logs nothing on a healthy run", async () => {
    const sink = httpSink(acceptAll);
    const warnings = collectWarnings();
    try {
      for (let i = 0; i < 3; i += 1) await sink.write(makeEvent());
      await sink.aclose();
      expect(PROCESS_DROPS.total()).toEqual({});
      expect(warnings.seen).toEqual([]);
    } finally {
      warnings.restore();
    }
  });
});
