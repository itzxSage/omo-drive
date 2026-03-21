import { test, expect } from '@playwright/test';

test('tap-to-toggle recording state', async ({ page }) => {
  await page.goto('http://localhost:8080');
  
  // Mock initAudio to succeed
  await page.evaluate(() => {
    window.mediaRecorder = {
      state: 'inactive',
      start: function() { this.state = 'recording'; },
      stop: function() { this.state = 'inactive'; }
    };
    window.initAudio = async () => {};
  });
  
  const pttButton = page.locator('#ptt-button');
  
  // Initial state
  await expect(pttButton).not.toHaveClass(/is-recording/);
  
  // Click to start
  await pttButton.click();
  await expect(pttButton).toHaveClass(/is-recording/);
  
  // Click to stop
  await pttButton.click();
  await expect(pttButton).not.toHaveClass(/is-recording/);
});
