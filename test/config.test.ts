import { expect, test } from 'bun:test';
import { createApp } from '../index';

test('createApp fails fast when runtime config is invalid', () => {
  const previousModelPath = process.env.OMO_DRIVE_WHISPER_MODEL_PATH;

  try {
    process.env.OMO_DRIVE_WHISPER_MODEL_PATH = 'relative/model.bin';
    expect(() => createApp()).toThrow(/OMO_DRIVE_WHISPER_MODEL_PATH must be an absolute path/);
  } finally {
    if (previousModelPath === undefined) {
      delete process.env.OMO_DRIVE_WHISPER_MODEL_PATH;
    } else {
      process.env.OMO_DRIVE_WHISPER_MODEL_PATH = previousModelPath;
    }
  }
});
