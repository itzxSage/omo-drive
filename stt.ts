import { join } from "path";
import { unlink } from "fs/promises";

const MODEL_PATH = join(process.env.HOME!, "Development/omo-drive/models/ggml-base.en.bin");
const MAX_DURATION_SECONDS = 20;

export async function transcribe(audioBuffer: Buffer | ArrayBuffer): Promise<{ text: string; ms: number }> {
  const start = performance.now();
  const tempId = Math.random().toString(36).substring(7);
  const inputPath = `/tmp/stt_input_${tempId}`;
  const wavPath = `/tmp/stt_output_${tempId}.wav`;

  try {
    await Bun.write(inputPath, audioBuffer);

    const ffmpeg = Bun.spawn([
      "ffmpeg", "-y", "-i", inputPath,
      "-t", MAX_DURATION_SECONDS.toString(),
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      wavPath
    ]);
    await ffmpeg.exited;

    if (ffmpeg.exitCode !== 0) {
      throw new Error("FFmpeg normalization failed");
    }

    const whisper = Bun.spawn([
      "whisper-cli",
      "-m", MODEL_PATH,
      "-f", wavPath,
      "-nt",
      "-np"
    ]);
    
    const output = await new Response(whisper.stdout).text();
    await whisper.exited;

    if (whisper.exitCode !== 0) {
      const errorOutput = await new Response(whisper.stderr).text();
      throw new Error(`Whisper transcription failed: ${errorOutput}`);
    }

    return {
      text: output.trim(),
      ms: performance.now() - start
    };
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
  }
}
