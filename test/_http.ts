/** A local HTTP server for streamable HTTP tests. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Serves `handle` on a free local port; it gets each request with its JSON
 * body, or `undefined` for none. */
export async function serveHttp(
  handle: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>,
): Promise<{ url: URL; close: () => Promise<void> }> {
  const http = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      await handle(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
    })();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${String(port)}/mcp`),
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}
