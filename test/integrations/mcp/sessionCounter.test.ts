import { describe, expect, it } from "vitest";
import { ServerCounter, SessionCounter } from "../../../src/integrations/mcp/sessionCounter.js";

describe("ServerCounter", () => {
  it("numbers its own session itself, so the Baton's counter keeps no entry for it", () => {
    const shared = new SessionCounter();
    const server = new ServerCounter(shared, "sdk-own");

    expect([server.next("sdk-own"), server.next("sdk-own")]).toEqual([1, 2]);
    expect(shared.next("sdk-own")).toBe(1);
  });

  it("numbers every other session through the Baton's counter", () => {
    const shared = new SessionCounter();
    const first = new ServerCounter(shared, "sdk-a");
    const second = new ServerCounter(shared, "sdk-b");

    expect([first.next("client"), second.next("client"), first.next("client")]).toEqual([1, 2, 3]);
  });
});
