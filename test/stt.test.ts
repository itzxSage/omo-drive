import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../index";
import { trustStore } from "../trust";

function createTrustedHeaders() {
  const bootstrap = trustStore.issueBootstrapToken();
  const session = trustStore.redeemBootstrapToken(bootstrap.token, "stt-test-device");

  if (!session) {
    throw new Error("Failed to create trusted session for test");
  }

  return {
    Authorization: `Bearer ${session.sessionToken}`,
  };
}

describe("STT API", () => {
  beforeEach(() => {
    trustStore.reset();
  });

  test("transcribes hello.wav correctly", async () => {
    const file = Bun.file("test/fixtures/hello.wav");
    const formData = new FormData();
    formData.append("audio", file);

    const res = await app.request("/api/stt", {
      headers: createTrustedHeaders(),
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { text: string; ms: number };
    expect(json.text.toLowerCase()).toContain("hello");
    expect(json.ms).toBeGreaterThan(0);
  }, 60000);

  test("returns 413 for oversized upload", async () => {
    const largeBuffer = new Uint8Array(11 * 1024 * 1024);
    const formData = new FormData();
    formData.append("audio", new Blob([largeBuffer]));

    const res = await app.request("/api/stt", {
      headers: createTrustedHeaders(),
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(413);
  });

  test("returns 400 if audio field is missing", async () => {
    const formData = new FormData();
    formData.append("not_audio", "random data");

    const res = await app.request("/api/stt", {
      headers: createTrustedHeaders(),
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(400);
  });
});
