import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { test } from "node:test";

import {
  createAgentdTransport,
  createApplyTransport,
} from "../src/agentd-transport.ts";

test("node unix transport sends HTTP request and parses chunked response", async () => {
  const fixture = await createSocketFixture(
    [
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: close",
      "",
      "6",
      "{\"ok\":",
      "4",
      "true",
      "1",
      "}",
      "0",
      "",
      "",
    ].join("\r\n"),
  );

  try {
    const transport = createApplyTransport({ socketPath: fixture.path });
    const response = await transport("http://agentd/apply", {
      body: `{"operations":[]}`,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `{"ok":true}`);

    const request = onlyRequest(fixture.requests);
    assert.match(request, /^POST \/apply HTTP\/1\.1\r\n/u);
    assert.match(request, /\r\nHost: agentd\r\n/u);
    assert.match(request, /\r\nConnection: close\r\n/u);
    assert.match(request, /\r\nAccept: application\/json\r\n/u);
    assert.match(request, /\r\nContent-Type: application\/json\r\n/u);
    assert.match(request, /\r\nContent-Length: 17\r\n/u);
    assert.ok(request.endsWith(`\r\n\r\n{"operations":[]}`));
  } finally {
    await fixture.close();
  }
});

test("transport guards reject unsafe POST paths before opening a socket", async () => {
  const readOnly = createAgentdTransport({ socketPath: "unused" });
  const apply = createApplyTransport({ socketPath: "unused" });

  await assert.rejects(
    readOnly("http://agentd/apply", {
      body: "{}",
      method: "POST",
    }),
    /read-only/u,
  );
  await assert.rejects(
    apply("http://agentd/not-apply", {
      body: "{}",
      method: "POST",
    }),
    /only allows GET plus POST \/apply/u,
  );
  await assert.rejects(
    apply("http://agentd/apply?x=1", {
      body: "{}",
      method: "POST",
    }),
    /only allows GET plus POST \/apply/u,
  );
});

test("transport fail-closes malformed and oversized responses", async () => {
  const malformed = await createSocketFixture("not an http response");

  try {
    const transport = createAgentdTransport({ socketPath: malformed.path });
    await assert.rejects(
      transport("http://agentd/healthz", { method: "GET" }),
      /missing HTTP headers/u,
    );
  } finally {
    await malformed.close();
  }

  const oversized = await createSocketFixture(
    [
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "Connection: close",
      "",
      "{\"payload\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}",
    ].join("\r\n"),
  );

  try {
    const transport = createAgentdTransport({
      maxResponseBytes: 48,
      socketPath: oversized.path,
    });
    await assert.rejects(
      transport("http://agentd/healthz", { method: "GET" }),
      /size limit/u,
    );
  } finally {
    await oversized.close();
  }
});

interface SocketFixture {
  readonly path: string;
  readonly requests: readonly string[];
  close(): Promise<void>;
}

async function createSocketFixture(response: string): Promise<SocketFixture> {
  const requests: string[] = [];
  const socketPath = await createSocketPath();
  const server = createServer((socket) => {
    let request = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);

      if (!isRequestComplete(request)) {
        return;
      }

      requests[requests.length] = request.toString("utf8");
      socket.end(response);
    });
  });

  await listen(server, socketPath.path);

  return {
    path: socketPath.path,
    requests,
    async close(): Promise<void> {
      await closeServer(server);
      if (socketPath.directory !== undefined) {
        await rm(socketPath.directory, { force: true, recursive: true });
      }
    },
  };
}

async function createSocketPath(): Promise<{
  readonly path: string;
  readonly directory: string | undefined;
}> {
  const id = `vita-cli-${process.pid}-${randomUUID()}`;

  if (process.platform === "win32") {
    return {
      directory: undefined,
      path: `\\\\.\\pipe\\${id}`,
    };
  }

  const directory = await mkdtemp(join(tmpdir(), `${id}-`));

  return {
    directory,
    path: join(directory, basename("agentd.sock")),
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function isRequestComplete(request: Buffer): boolean {
  const headerEnd = request.indexOf("\r\n\r\n", 0, "latin1");
  if (headerEnd < 0) {
    return false;
  }

  const headers = request.subarray(0, headerEnd).toString("latin1");
  const match = /\r\ncontent-length:\s*([0-9]+)(?:\r\n|$)/iu.exec(headers);
  if (match === null) {
    return true;
  }

  const lengthText = match[1];
  if (lengthText === undefined) {
    return false;
  }

  return request.length >= headerEnd + 4 + Number.parseInt(lengthText, 10);
}

function onlyRequest(requests: readonly string[]): string {
  assert.equal(requests.length, 1);

  const request = requests[0];
  if (request === undefined) {
    assert.fail("expected one request");
  }

  return request;
}
