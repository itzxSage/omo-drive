import { $ } from "bun";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let lastCaptureTime = 0;
const RATE_LIMIT_MS = 2000;

export async function captureScreenshot(options: {
  display?: string;
  max?: number;
  quality?: number;
} = {}) {
  const now = Date.now();
  if (now - lastCaptureTime < RATE_LIMIT_MS) {
    throw new Error("Rate limit exceeded. Please wait 2 seconds between captures.");
  }
  lastCaptureTime = now;

  const { display, max = 1280, quality = 60 } = options;
  const tmpPng = join(tmpdir(), `screenshot-${now}.png`);
  const tmpJpg = join(tmpdir(), `screenshot-${now}.jpg`);

  try {
    const captureArgs = ["-x", "-C", "-t", "png"];
    if (display) {
      captureArgs.push("-D", display);
    }
    captureArgs.push(tmpPng);

    await $`screencapture ${captureArgs}`;

    await $`sips -Z ${max} -s format jpeg -s formatOptions ${quality} ${tmpPng} --out ${tmpJpg}`;

    const jpgBuffer = await Bun.file(tmpJpg).arrayBuffer();
    return new Uint8Array(jpgBuffer);
  } finally {
    try {
      await unlink(tmpPng);
    } catch (e) {}
    try {
      await unlink(tmpJpg);
    } catch (e) {}
  }
}
