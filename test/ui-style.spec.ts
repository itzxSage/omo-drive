import { test, expect } from '@playwright/test';

test('UI has light mode and circular button', async ({ page }) => {
  await page.goto('http://localhost:8080');
  
  // Check background color
  const body = page.locator('body');
  await expect(body).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  
  // Check button shape
  const pttButton = page.locator('#ptt-button');
  await expect(pttButton).toHaveCSS('border-radius', '50%');
  await expect(pttButton).toHaveCSS('width', '160px');
  await expect(pttButton).toHaveCSS('height', '160px');
});
