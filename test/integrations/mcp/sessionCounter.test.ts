import { describe, expect, it } from "vitest";
import { SESSION_CAP, ServerCounter, SessionCounter } from "../../../src/integrations/mcp/sessionCounter.js";
import { nowMicros } from "../../../src/sequence.js";

describe("SessionCounter", () => {
  it("numbers a minted session 1, 2, 3", () => {
    const counter = new SessionCounter();

    expect([counter.next("s", false), counter.next("s", false), counter.next("s", false)]).toEqual([1, 2, 3]);
  });

  it("forgets the least recently used session past the cap", () => {
    const counter = new SessionCounter();
    counter.next("used", false);
    counter.next("idle", false);
    counter.next("used", false);
    for (let i = 0; i < SESSION_CAP - 1; i++) counter.next(`filler-${i}`, false);

    expect(counter.next("used", false)).toBe(3);
    expect(counter.next("idle", false)).toBe(1);
  });

  it("numbers an observed session at least by the clock, still rising after it is forgotten", () => {
    const counter = new SessionCounter();
    const before = nowMicros();
    const first = counter.next("observed", true);
    const second = counter.next("observed", true);
    for (let i = 0; i < SESSION_CAP; i++) counter.next(`filler-${i}`, false);
    const afterForgotten = counter.next("observed", true);

    expect(first).toBeGreaterThanOrEqual(before);
    expect(second).toBeGreaterThan(first);
    expect(afterForgotten).toBeGreaterThan(second);
  });

  it("takes a resolved session's origin, and keeps no entry for a per-call one", () => {
    const counter = new SessionCounter();
    const before = nowMicros();

    expect(counter.nextFor({ sessionId: "o", origin: "observed", perCall: false })).toBeGreaterThanOrEqual(before);
    expect(counter.nextFor({ sessionId: "m", origin: "minted", perCall: false })).toBe(1);
    counter.nextFor({ sessionId: "p", origin: "minted", perCall: true });
    expect(counter.next("p", false)).toBe(1);
  });
});

describe("ServerCounter", () => {
  it("numbers its own session itself, so the Baton's counter keeps no entry for it", () => {
    const shared = new SessionCounter();
    const server = new ServerCounter(shared, "sdk-own");

    expect([server.next("sdk-own", false), server.next("sdk-own", false)]).toEqual([1, 2]);
    expect(shared.next("sdk-own", false)).toBe(1);
  });

  it("numbers every other session through the Baton's counter", () => {
    const shared = new SessionCounter();
    const first = new ServerCounter(shared, "sdk-a");
    const second = new ServerCounter(shared, "sdk-b");

    expect([first.next("client", false), second.next("client", false), first.next("client", false)]).toEqual([1, 2, 3]);
  });
});
