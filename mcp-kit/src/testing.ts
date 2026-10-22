import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Connectable } from "./stdio.js";

/**
 * Connect a client to `server` in memory, for tests (job-searcher's mcp.test.ts
 * did this by hand). `close()` closes both ends.
 */
export async function connectInMemory(server: Connectable, clientInfo = { name: "test-client", version: "0.0.0" }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client(clientInfo);
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
