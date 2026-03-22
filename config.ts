import { isAbsolute, join } from "node:path";

type RuntimeConfig = Readonly<{
  server: Readonly<{
    hostname: string;
    port: number;
    publicOrigin: string;
  }>;
  opencode: Readonly<{
    username: string;
    password: string;
    origin: string;
    basicAuth: string;
  }>;
  stt: Readonly<{
    modelPath: string;
    maxDurationSeconds: number;
    ffmpegBin: string;
    whisperBin: string;
  }>;
  screenshot: Readonly<{
    rateLimitMs: number;
    defaultMax: number;
    defaultQuality: number;
    captureBin: string;
    convertBin: string;
  }>;
  pair: Readonly<{
    tailscaleBin: string;
    fallbackUrl: string;
  }>;
}>;

function readString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readNumber(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validateUrl(name: string, value: string) {
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL. Received: ${value}`);
  }
}

function validatePositiveInteger(name: string, value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${value}`);
  }
}

function validateAbsolutePath(name: string, value: string) {
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path. Received: ${value}`);
  }
}

function buildRuntimeConfig(): RuntimeConfig {
  const serverHostname = readString("OMO_DRIVE_HOSTNAME", "127.0.0.1");
  const serverPort = readNumber("OMO_DRIVE_PORT", 8080);
  const publicOrigin = readString("OMO_DRIVE_PUBLIC_ORIGIN", `http://localhost:${serverPort}`);
  const opencodeUsername = readString("OPENCODE_SERVER_USERNAME", "opencode");
  const opencodePassword = process.env.OPENCODE_SERVER_PASSWORD ?? "";
  const opencodeOrigin = readString("OPENCODE_SERVER_ORIGIN", "http://127.0.0.1:4096");
  const defaultModelPath = join(import.meta.dir, "models", "ggml-base.en.bin");

  return Object.freeze({
    server: Object.freeze({
      hostname: serverHostname,
      port: serverPort,
      publicOrigin,
    }),
    opencode: Object.freeze({
      username: opencodeUsername,
      password: opencodePassword,
      origin: opencodeOrigin,
      basicAuth: `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`,
    }),
    stt: Object.freeze({
      modelPath: readString("OMO_DRIVE_WHISPER_MODEL_PATH", defaultModelPath),
      maxDurationSeconds: readNumber("OMO_DRIVE_STT_MAX_DURATION_SECONDS", 20),
      ffmpegBin: readString("OMO_DRIVE_FFMPEG_BIN", "ffmpeg"),
      whisperBin: readString("OMO_DRIVE_WHISPER_BIN", "whisper-cli"),
    }),
    screenshot: Object.freeze({
      rateLimitMs: readNumber("OMO_DRIVE_SCREENSHOT_RATE_LIMIT_MS", 2000),
      defaultMax: readNumber("OMO_DRIVE_SCREENSHOT_MAX", 1280),
      defaultQuality: readNumber("OMO_DRIVE_SCREENSHOT_QUALITY", 60),
      captureBin: readString("OMO_DRIVE_SCREENSHOT_CAPTURE_BIN", "screencapture"),
      convertBin: readString("OMO_DRIVE_SCREENSHOT_CONVERT_BIN", "sips"),
    }),
    pair: Object.freeze({
      tailscaleBin: readString(
        "OMO_DRIVE_TAILSCALE_BIN",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ),
      fallbackUrl: readString("OMO_DRIVE_PUBLIC_ORIGIN", publicOrigin),
    }),
  });
}

export function getRuntimeConfig(): RuntimeConfig {
  return assertRuntimeConfig(buildRuntimeConfig());
}

export const runtimeConfig = getRuntimeConfig();

export function assertRuntimeConfig(config: RuntimeConfig = runtimeConfig) {
  validatePositiveInteger("OMO_DRIVE_PORT", config.server.port);
  validateUrl("OMO_DRIVE_PUBLIC_ORIGIN", config.server.publicOrigin);
  validateUrl("OPENCODE_SERVER_ORIGIN", config.opencode.origin);
  validateAbsolutePath("OMO_DRIVE_WHISPER_MODEL_PATH", config.stt.modelPath);
  validatePositiveInteger("OMO_DRIVE_STT_MAX_DURATION_SECONDS", config.stt.maxDurationSeconds);
  validatePositiveInteger("OMO_DRIVE_SCREENSHOT_RATE_LIMIT_MS", config.screenshot.rateLimitMs);
  validatePositiveInteger("OMO_DRIVE_SCREENSHOT_MAX", config.screenshot.defaultMax);
  validatePositiveInteger("OMO_DRIVE_SCREENSHOT_QUALITY", config.screenshot.defaultQuality);

  if (config.pair.tailscaleBin.includes("/") && !isAbsolute(config.pair.tailscaleBin)) {
    throw new Error(
      `OMO_DRIVE_TAILSCALE_BIN must be absolute when a path is provided. Received: ${config.pair.tailscaleBin}`,
    );
  }

  const executableSettings: Array<[string, string]> = [
    ["OMO_DRIVE_FFMPEG_BIN", config.stt.ffmpegBin],
    ["OMO_DRIVE_WHISPER_BIN", config.stt.whisperBin],
    ["OMO_DRIVE_SCREENSHOT_CAPTURE_BIN", config.screenshot.captureBin],
    ["OMO_DRIVE_SCREENSHOT_CONVERT_BIN", config.screenshot.convertBin],
  ];

  for (const [name, value] of executableSettings) {
    if (value.includes("/") && !isAbsolute(value)) {
      throw new Error(`${name} must be absolute when a path is provided. Received: ${value}`);
    }
  }

  return config;
}
