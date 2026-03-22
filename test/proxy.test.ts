import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

process.env.OPENCODE_SERVER_ORIGIN = "http://127.0.0.1:4196";
process.env.OPENCODE_SERVER_PASSWORD = "very-long-random-password-for-omo-drive";

import { app } from "../index";
import { trustStore } from "../trust";

let mockServer: any;

function createTrustedRequest(path: string, init?: RequestInit) {
  const bootstrap = trustStore.issueBootstrapToken();
  const session = trustStore.redeemBootstrapToken(bootstrap.token, "proxy-test-device");

  if (!session) {
    throw new Error("Failed to create trusted session for test");
  }

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${session.sessionToken}`);

  return new Request(`http://localhost:8080${path}`, {
    ...init,
    headers,
  });
}

beforeAll(() => {
  mockServer = Bun.serve({
    port: 4196,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("Authorization");
      
      if (auth !== "Basic b3BlbmNvZGU6dmVyeS1sb25nLXJhbmRvbS1wYXNzd29yZC1mb3Itb21vLWRyaXZl") {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname === "/global/health") {
        return new Response("OK");
      }
      
      if (url.pathname === "/session") {
        return new Response("Session List");
      }

      if (url.pathname === "/session/test-id") {
        return new Response("Session Info");
      }

      return new Response("Not Found", { status: 404 });
    },
  });
});

beforeEach(() => {
  trustStore.reset();
});

afterAll(() => {
  mockServer.stop();
});

test("GET /api/opencode/global/health returns 200", async () => {
  const req = createTrustedRequest("/api/opencode/global/health");
  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe("OK");
});

test("GET /api/opencode/session returns 200", async () => {
  const req = createTrustedRequest("/api/opencode/session");
  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe("Session List");
});

test("GET /api/opencode/session/test-id returns 200", async () => {
  const req = createTrustedRequest("/api/opencode/session/test-id");
  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe("Session Info");
});

test("GET /api/opencode/session/does-not-exist/shell returns 403", async () => {
  const req = createTrustedRequest("/api/opencode/session/does-not-exist/shell");
  const res = await app.fetch(req);
  expect(res.status).toBe(403);
  const text = await res.text();
  expect(text).toBe("Forbidden");
});

test("POST /api/opencode/unsupported-endpoint returns 403", async () => {
  const req = createTrustedRequest("/api/opencode/unsupported-endpoint", { method: "POST" });
  const res = await app.fetch(req);
  expect(res.status).toBe(403);
});
