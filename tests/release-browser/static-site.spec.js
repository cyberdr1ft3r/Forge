import {test, expect} from '@playwright/test';

for (const route of ['/', '/generators/nginx', '/generators/compose', '/generators/systemd']) {
  test(`${route} loads without CSP violations or horizontal overflow`, async ({page}) => {
    const violations = [];
    const pageErrors = [];
    page.on('console', message => { if (message.type() === 'error') violations.push(message.text()); });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(route);
    await expect(page).toHaveTitle(/Forge/);
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(violations.filter(message => /content security policy|refused to/iu.test(message))).toEqual([]);
  });
}
