/** Capture settings from the collector (SPEC §2.6) and the `labels` envelope
 * member (SPEC §11.4). The cases are Python's `tests/test_capture_settings.py`. */

import { describe, expect, it } from "vitest";
import { callerFor, cleanLabels } from "../../../src/identity.js";
import {
  type Caller,
  type SettingsDocument,
  SettingsFetcher,
  parseDocument,
  shareBucket,
} from "../../../src/integrations/mcp/captureSettings.js";
import { serveHttp } from "../../_http.js";

const document = (audiences: unknown[], version = 3): string => JSON.stringify({ version, audiences });
const audience = (id: string, match: unknown, results: unknown = "full") => ({
  id,
  match,
  capture: { goal: "required", reports: "off", results },
});
const EVERYONE = audience("everyone", {}, "off");

function parsed(body: string): SettingsDocument {
  const doc = parseDocument(body);
  expect(doc).not.toBeNull();
  return doc!;
}

const caller = (over: Partial<Caller> = {}): Caller => ({ labels: [], clientName: null, shareKey: null, ...over });
const matched = (body: string, who: Caller): string | undefined =>
  parsed(body).settingsFor(who, "srv").capture.audience;

describe("labels", () => {
  it("keeps usable labels in order without repeats", () => {
    expect(cleanLabels(["beta", "org_1", "beta"])).toEqual(["beta", "org_1"]);
  });

  it.each([null, 3, "", "  ", " ", "x".repeat(65), "a\u0000b", "a\ud800b"])(
    "drops an unusable label alone: %j",
    (bad) => {
      expect(cleanLabels(["beta", bad])).toEqual(["beta"]);
    },
  );

  it("keeps a label of 64 code points, astral ones included", () => {
    expect(cleanLabels(["x".repeat(64)])).toEqual(["x".repeat(64)]);
    expect(cleanLabels(["😀".repeat(64)])).toEqual(["😀".repeat(64)]);
  });

  it("keeps at most twenty", () => {
    const given = Array.from({ length: 25 }, (_, i) => `l${i}`);
    expect(cleanLabels(given)).toEqual(given.slice(0, 20));
  });

  it("sends a principal's labels and its organization's together", () => {
    const wire = callerFor(
      { principalId: "u", labels: ["beta", "beta", ""], organization: { organizationId: "o", labels: ["enterprise"] } },
      () => {},
    );
    expect(wire.labels).toEqual(["beta", "enterprise"]);
  });

  it("lets an organization alone carry labels", () => {
    const wire = callerFor({ organizationId: "org_1", labels: ["enterprise"] }, () => {});
    expect(wire.principal).toBeNull();
    expect(wire.labels).toEqual(["enterprise"]);
  });

  it("never throws on labels a resolver cannot read", () => {
    function* thenRaise(): Generator<string> {
      yield "beta";
      throw new Error("resolver bug");
    }
    function* endless(): Generator<string> {
      for (;;) yield "beta";
    }
    for (const labels of [thenRaise(), endless()]) {
      const wire = callerFor({ principalId: "u", labels }, () => {});
      expect(wire.principal).not.toBeNull();
      expect(wire.labels.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("share", () => {
  it("pins the bucket", () => {
    // SPEC §2.6's formula; every SDK gives the same buckets.
    expect(["alice", "bob", "carol"].map((key) => shareBucket("acme", key))).toEqual([1556, 3902, 7404]);
  });

  it("a half rounds up", () => {
    // 0.00025 * 10000 is exactly 2.5, so buckets 0, 1 and 2 are in.
    let i = 0;
    while (shareBucket("srv", `u${i}`) !== 2) i++;
    const body = document([audience("tiny", { share: 0.00025 }), EVERYONE]);
    expect(matched(body, caller({ shareKey: `u${i}` }))).toBe("tiny");
  });

  it("raising the share keeps everyone already in", () => {
    const small = document([audience("in", { share: 0.1 }), EVERYONE]);
    const large = document([audience("in", { share: 0.5 }), EVERYONE]);
    const keys = Array.from({ length: 500 }, (_, i) => `user-${i}`);
    const inSmall = keys.filter((k) => matched(small, caller({ shareKey: k })) === "in");
    const inLarge = new Set(keys.filter((k) => matched(large, caller({ shareKey: k })) === "in"));
    expect(inSmall.length).toBeGreaterThan(25);
    expect(inSmall.length).toBeLessThan(75);
    expect(inSmall.every((k) => inLarge.has(k))).toBe(true);
    expect(inLarge.size).toBeGreaterThan(inSmall.length);
  });

  it("needs an identity", () => {
    const body = document([audience("all", { share: 1 }), EVERYONE]);
    expect(matched(body, caller())).toBe("everyone");
    expect(matched(body, caller({ shareKey: "user-1" }))).toBe("all");
  });
});

describe("the document", () => {
  it.each([
    "not json",
    "[]",
    "[".repeat(100000),
    document([], 0),
    JSON.stringify({ version: true, audiences: [EVERYONE] }),
    JSON.stringify({ version: 1.5, audiences: [EVERYONE] }),
    JSON.stringify({ version: 1, audiences: [] }),
    JSON.stringify({ version: 1, audiences: [{ id: 1, match: {}, capture: {} }] }),
    JSON.stringify({ version: 1, audiences: [{ id: "a", match: [], capture: {} }] }),
    JSON.stringify({ version: 1, audiences: [{ id: "a", match: {}, capture: null }] }),
  ])("refuses an invalid one: %s", (body) => {
    expect(parseDocument(body)).toBeNull();
  });

  it("the first matching audience wins", () => {
    const body = document([
      audience("beta", { label: ["beta", "alpha"] }),
      audience("claude", { client: ["claude-code"] }),
      EVERYONE,
    ]);
    expect(matched(body, caller({ labels: ["alpha"], clientName: "claude-code" }))).toBe("beta");
    expect(matched(body, caller({ clientName: "claude-code" }))).toBe("claude");
    expect(matched(body, caller({ labels: ["gamma"] }))).toBe("everyone");
  });

  it("match keys combine with AND", () => {
    const body = document([audience("both", { label: ["beta"], client: ["cursor"] }), EVERYONE]);
    expect(matched(body, caller({ labels: ["beta"] }))).toBe("everyone");
    expect(matched(body, caller({ labels: ["beta"], clientName: "cursor" }))).toBe("both");
  });

  it.each([
    { organization: ["org_1"] },
    { label: "beta" },
    { label: [1] },
    { client: "cursor" },
    { share: "0.5" },
    { share: true },
    { share: 5 },
    { share: -1 },
    { share: 1e305 },
    { share: 0 },
  ])("an audience it cannot read matches nobody: %j", (match) => {
    const body = document([audience("odd", match), EVERYONE]);
    expect(matched(body, caller({ labels: ["beta"], clientName: "cursor", shareKey: "u" }))).toBe("everyone");
  });

  it("a share too big for a float matches nobody", () => {
    const body = `{"version": 1, "audiences": [{"id": "odd", "match": {"share": 1${"0".repeat(400)}}, "capture": {}}, ${JSON.stringify(EVERYONE)}]}`;
    expect(matched(body, caller({ shareKey: "u" }))).toBe("everyone");
  });

  it("the matched audience sets results and is recorded", () => {
    const doc = parsed(document([audience("beta", { label: ["beta"] }), EVERYONE], 7));
    const beta = doc.settingsFor(caller({ labels: ["beta"] }), "srv");
    expect(beta.resultCaptureMode).toBe("full");
    expect(beta.capture).toEqual({ settings_version: 7, audience: "beta" });
    const rest = doc.settingsFor(caller(), "srv");
    expect(rest.resultCaptureMode).toBe("off");
    expect(rest.capture).toEqual({ settings_version: 7, audience: "everyone" });
  });

  it.each(["metadata", ["full"], { a: 1 }, null, "constructor"])(
    "an unknown results value leaves the code value: %j",
    (results) => {
      const doc = parsed(document([audience("everyone", {}, results)]));
      expect(doc.settingsFor(caller(), "srv").resultCaptureMode).toBeUndefined();
    },
  );

  it("no matching audience records the version alone", () => {
    const settings = parsed(document([audience("beta", { label: ["beta"] })])).settingsFor(caller(), "srv");
    expect(settings.resultCaptureMode).toBeUndefined();
    expect(settings.capture).toEqual({ settings_version: 3 });
  });

  it("a dropped catch-all leaves the code's reports reachable", () => {
    const doc = parsed(
      JSON.stringify({
        version: 4,
        audiences: [
          { id: "beta", match: { label: ["beta"] }, capture: { reports: "off" } },
          { id: "odd", match: { plan: ["pro"] }, capture: { reports: "off" } },
        ],
      }),
    );
    expect(doc.reportsOnForAnyone).toBe(true);
    const everyoneOff = parsed(document([{ id: "everyone", match: {}, capture: { reports: "off" } }]));
    expect(everyoneOff.reportsOnForAnyone).toBe(false);
  });
});

type Answer = { status: number; etag?: string; body?: string } | Error;

function fetcherAnswering(...answers: Answer[]): { fetcher: SettingsFetcher; requests: Request[] } {
  const requests: Request[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push(new Request(url, init));
    const answer = answers.shift()!;
    if (answer instanceof Error) throw answer;
    const headers: Record<string, string> = answer.etag === undefined ? {} : { etag: answer.etag };
    return new Response(answer.status === 204 || answer.status === 304 ? null : (answer.body ?? ""), {
      status: answer.status,
      headers,
    });
  }) as typeof fetch;
  const fetcher = new SettingsFetcher({
    origin: "https://h.example.com",
    apiKey: "baton_pk_x",
    tenantId: "ten_1",
    vendorId: "srv",
    refreshMs: 60_000,
    fetchImpl,
  });
  return { fetcher, requests };
}

describe("the fetcher", () => {
  it("uses a 200 and sends its etag back", async () => {
    const { fetcher, requests } = fetcherAnswering(
      { status: 200, etag: '"v3-w1"', body: document([EVERYONE]) },
      { status: 304 },
    );
    await fetcher.readOnce();
    await fetcher.readOnce();
    expect(fetcher.document?.version).toBe(3);
    expect(requests[1]!.headers.get("If-None-Match")).toBe('"v3-w1"');
  });

  it("drops the document on a 204", async () => {
    const { fetcher } = fetcherAnswering({ status: 200, body: document([EVERYONE]) }, { status: 204 });
    await fetcher.readOnce();
    await fetcher.readOnce();
    expect(fetcher.document).toBeNull();
  });

  it.each<Answer>([{ status: 500 }, { status: 401 }, { status: 200, body: "{}" }, new Error("down")])(
    "keeps the document held on a failure: %j",
    async (failure) => {
      const { fetcher } = fetcherAnswering({ status: 200, body: document([EVERYONE]) }, failure);
      await fetcher.readOnce();
      await fetcher.readOnce();
      expect(fetcher.document).not.toBeNull();
    },
  );

  it("drops an answer that lands after stop, and reads again at once on a restart", async () => {
    const answers: ((response: Response) => void)[] = [];
    const fetcher = new SettingsFetcher({
      origin: "https://h.example.com",
      apiKey: "baton_pk_x",
      tenantId: "ten_1",
      vendorId: "srv",
      refreshMs: 60_000,
      fetchImpl: () => new Promise<Response>((resolve) => answers.push(resolve)),
    });
    const first = fetcher.readOnce();
    fetcher.stop();
    fetcher.start();
    expect(answers).toHaveLength(2);
    fetcher.stop();
    for (const answer of answers) answer(new Response(document([EVERYONE]), { status: 200 }));
    await first;
    expect(fetcher.document).toBeNull();
  });

  it("reads the document and its etag over a real request", async () => {
    const seen: Record<string, string | undefined>[] = [];
    const http = await serveHttp(async (req, res) => {
      seen.push({
        path: req.url,
        authorization: req.headers.authorization,
        tenant: req.headers["x-baton-tenant-id"] as string | undefined,
        etag: req.headers["if-none-match"],
      });
      if (req.headers["if-none-match"] === '"v3-w1"') {
        res.writeHead(304).end();
        return;
      }
      res.writeHead(200, { ETag: '"v3-w1"', "Content-Type": "application/json" }).end(document([EVERYONE]));
    });
    try {
      const fetcher = new SettingsFetcher({
        origin: http.url.origin,
        apiKey: "baton_pk_x",
        tenantId: "ten_1",
        vendorId: "srv",
        refreshMs: 60_000,
      });
      await fetcher.readOnce();
      await fetcher.readOnce();
      expect(fetcher.document?.version).toBe(3);
    } finally {
      await http.close();
    }
    expect(seen.map((r) => r.path)).toEqual(["/v0/settings?server=srv", "/v0/settings?server=srv"]);
    expect(seen[0]).toMatchObject({ authorization: "Bearer baton_pk_x", tenant: "ten_1" });
    expect(seen[1]!.etag).toBe('"v3-w1"');
  });
});
