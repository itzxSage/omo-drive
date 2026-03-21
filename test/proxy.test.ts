import { test, expect, beforeAll, afterAll } from "bun:test";

process.env.OPENCODE_SERVER_ORIGIN = "http://127.0.0.1:4196";

import { app } from "../index";

let mockServer: any;

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

afterAll(() => {
  mockServer.stop();
});

test("GET /api/opencode/global/health returns 200", async () => {
  const req = new Request("http://localhost:8080/api/opencode/global/health");
  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe("OK");
});

test("GET /api/opencode/session returns 200", async () => {
  const req = new Request("http://localhost:8080/api/opencode/session");
  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe("Session List");
});

test("GET /api/opencode/session/test-id returns 200", async () => {
  const req = new Request("http://localhost:8080/api/opencode/session/test-id");
  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe("Session Info");
});

test("GET /api/opencode/session/does-not-exist/shell returns 403", async () => {
  const req = new Request("http://localhost:8080/api/opencode/session/does-not-exist/shell");
  const res = await app.fetch(req);
  expect(res.status).toBe(403);
  const text = await res.text();
  expect(text).toBe("Forbidden");
});

test("POST /api/opencode/unsupported-endpoint returns 403", async () => {
  const req = new Request("http://localhost:8080/api/opencode/unsupported-endpoint", { method: 'POST' });
  const res = await app.fetch(req);
  expect(res.status).toBe(403);
});
