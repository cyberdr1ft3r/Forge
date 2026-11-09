import {test, expect} from '@playwright/test';

test('landing page is truthful and routes into every supported generator', async ({page}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Infrastructure configs, composed with intent.'})).toBeVisible();
  await expect(page.getByText('Coming soon')).toBeVisible();
  await expect(page.getByText(/testimonials|customers|deploy now/i)).toHaveCount(0);
  await page.screenshot({path: testInfo.outputPath('landing.png')});
  for (const path of ['/generators/nginx', '/generators/compose', '/generators/systemd']) {
    await page.locator(`.generator-card[href="${path}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.goto('/');
  }
});

test('direct routes and persistent switcher preserve generator functionality', async ({page}, testInfo) => {
  await page.goto('/generators/nginx');
  await expect(page.getByRole('heading', {name: 'Nginx configuration'})).toBeVisible();
  await page.getByLabel('Active generator').selectOption('compose');
  await expect(page).toHaveURL(/\/generators\/compose$/);
  await page.getByLabel('Service name').fill('api');
  if (testInfo.project.name === 'desktop-chromium') {
    await page.getByRole('link', {name: 'Workspace'}).click();
    await expect(page).toHaveURL(/\/generators\/compose$/);
    await expect(page.getByLabel('Service name')).toHaveValue('api');
  }
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.getByText('compose.yaml', {exact: true})).toBeVisible();
  await expect(page.locator('#output')).toContainText('127.0.0.1:8080:80');
  await expect(page.getByText('△ Native validator unavailable')).toBeVisible();
  await page.getByLabel('Active generator').selectOption('systemd');
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.getByText('myapp.service', {exact: true})).toBeVisible();
  await expect(page.locator('#output')).toContainText('NoNewPrivileges=true');
  await page.getByLabel('Active generator').selectOption('compose');
  await expect(page.getByLabel('Service name')).toHaveValue('api');
});

test('Nginx uses typed composition, field diagnostics, TLS, and honest validation states', async ({page}) => {
  await page.goto('/generators/nginx');
  await expect(page.getByRole('heading', {name: 'Assumed Nginx compatibility inputs'})).toBeVisible();
  await expect(page.getByText(/assumed Nginx 1\.26\.3 target/)).toBeVisible();
  await expect(page.getByText(/http_log, http_map, http_proxy, http_rewrite, http_ssl/)).toBeVisible();
  await expect(page.getByText(/not properties discovered from your server/)).toBeVisible();
  await expect(page.getByText(/nginx -t.*was not run/)).toBeVisible();
  await page.getByLabel('Domain name').fill('bad; include /tmp/x');
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.getByLabel('Domain name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#domain-error')).not.toBeEmpty();
  await expect(page.getByText('No artifact was created.')).toBeVisible();

  await page.getByLabel('Domain name').fill('secure.example.com');
  await page.getByLabel('Enable HTTPS').check();
  await page.getByLabel('Certificate-chain path').fill('/etc/nginx/certs/secure.example.com.pem');
  await page.getByLabel('Private-key path').fill('/etc/nginx/private/secure.example.com.key');
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.locator('#output')).toContainText('listen 443 ssl;');
  await expect(page.locator('#output')).toContainText('ssl_certificate /etc/nginx/certs/secure.example.com.pem;');
  await expect(page.getByText('✓ Input passed')).toBeVisible();
  await expect(page.getByText('✓ Static checks passed')).toBeVisible();
  await expect(page.getByText('△ Native validator unavailable')).toBeVisible();
  await expect(page.getByText('○ Target host not run')).toBeVisible();
});

test('WebSocket site fragments retain supporting artifacts and export copy, files, ZIP, and expansion', async ({page, context}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/generators/nginx');
  await page.getByLabel('Output profile').selectOption('site-fragment');
  await page.getByLabel('Enable WebSocket support').check();
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  const siteArtifact = page.getByRole('button', {name: 'site.conf'});
  const sharedArtifact = page.getByRole('button', {name: 'http-shared.conf'});
  await expect(siteArtifact).toHaveAttribute('aria-pressed', 'true');
  await expect(sharedArtifact).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('2 required artifacts generated. Select a file to inspect it.')).toBeVisible();
  await siteArtifact.focus();
  await page.keyboard.press('Tab');
  await expect(sharedArtifact).toBeFocused();
  expect(await sharedArtifact.evaluate(button => getComputedStyle(button).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(sharedArtifact).toBeFocused();
  await expect(sharedArtifact).toHaveAttribute('aria-pressed', 'true');
  await expect(siteArtifact).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#artifact-role')).toHaveText('Supporting');
  await expect(page.locator('#output')).toContainText('map $http_upgrade $connection_upgrade');

  await page.getByRole('button', {name: 'Copy'}).click();
  await expect(page.getByText('http-shared.conf copied to the clipboard.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('map $http_upgrade');

  const fileDownload = page.waitForEvent('download');
  await page.getByRole('button', {name: /Download/}).click();
  expect((await fileDownload).suggestedFilename()).toBe('http-shared.conf');
  const zipDownload = page.waitForEvent('download');
  await page.getByRole('button', {name: 'ZIP'}).click();
  expect((await zipDownload).suggestedFilename()).toBe('forge-nginx-artifacts.zip');

  await page.getByRole('button', {name: 'Expand'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').locator('code')).toContainText('map $http_upgrade');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.evaluate(() => window.scrollTo({top: 0}));
  await page.screenshot({path: testInfo.outputPath('workspace-desktop.png')});
});

async function expectStaleResult(page) {
  await expect(page.getByText('Configuration changed — regenerate to update the output.').first()).toBeVisible();
  await expect(page.locator('#output')).toHaveText('Configuration changed — regenerate to update the output.');
  for (const name of ['Copy', /Download/, 'Expand']) await expect(page.getByRole('button', {name})).toBeDisabled();
  await expect(page.getByText('✓ Input passed')).toHaveCount(0);
  await expect(page.getByText('✓ Static checks passed')).toHaveCount(0);
  await expect(page.getByText('○ Input not run')).toBeVisible();
  await expect(page.getByText('○ Static checks not run')).toBeVisible();
}

async function captureFullPageEvidence(page, path) {
  const captureStyles = await page.addStyleTag({content: `
    .skip-link { display: none !important; }
    .validation-bar { position: static !important; }
  `});
  await page.screenshot({path, fullPage: true});
  await captureStyles.evaluate(element => element.remove());
}

test('edited Nginx, Compose, and systemd inputs invalidate stale output until regeneration', async ({page}) => {
  await page.goto('/generators/nginx');
  await page.getByLabel('Output profile').selectOption('site-fragment');
  await page.getByLabel('Enable WebSocket support').check();
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.getByRole('button', {name: 'ZIP'})).toBeEnabled();
  await page.getByLabel('Domain name').fill('changed.example.com');
  await expectStaleResult(page);
  await expect(page.getByRole('button', {name: 'ZIP'})).toBeHidden();
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.locator('#output')).toContainText('changed.example.com');
  await expect(page.getByRole('button', {name: 'Copy'})).toBeEnabled();

  await page.goto('/generators/compose');
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await page.getByLabel('Host port').fill('9090');
  await expectStaleResult(page);
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.locator('#output')).toContainText('127.0.0.1:9090:80');

  await page.goto('/generators/systemd');
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await page.getByLabel('Description').fill('Changed application');
  await expectStaleResult(page);
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.locator('#output')).toContainText('Description=Changed application');
});

test('static website and SPA fallback invoke the matching capability flow', async ({page}) => {
  await page.goto('/generators/nginx');
  await page.getByLabel('Workflow').selectOption('static-site');
  await expect(page.getByLabel('Document root')).toBeVisible();
  await expect(page.getByLabel('Upstream host')).toHaveCount(0);
  await page.getByLabel('Document root').fill('/srv/www/app');
  await page.getByLabel('Single Page Application fallback').check();
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await expect(page.locator('#output')).toContainText('root /srv/www/app;');
  await expect(page.locator('#output')).toContainText('try_files $uri $uri/ /index.html;');
  await expect(page.locator('#output')).not.toContainText('proxy_pass');
});

test('mobile layout stacks panels and retains labelled keyboard controls', async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile geometry is verified in the mobile project.');
  await page.goto('/generators/nginx');
  const configuration = await page.locator('.configuration-panel').boundingBox();
  const preview = await page.locator('.preview-panel').boundingBox();
  expect(configuration).not.toBeNull(); expect(preview).not.toBeNull();
  expect(preview.y).toBeGreaterThan(configuration.y + configuration.height - 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.getByLabel('Domain name')).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('workspace-mobile.png')});
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
});

test('captures reproducible Forge visual review evidence at fixed viewports', async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One deterministic visual evidence set is sufficient.');
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/');
  await captureFullPageEvidence(page, testInfo.outputPath('visual-landing-desktop.png'));

  await page.goto('/generators/nginx');
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await captureFullPageEvidence(page, testInfo.outputPath('visual-nginx-generated-desktop.png'));

  await page.getByLabel('Output profile').selectOption('site-fragment');
  await page.getByLabel('Enable WebSocket support').check();
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await page.getByRole('button', {name: 'http-shared.conf'}).click();
  await captureFullPageEvidence(page, testInfo.outputPath('visual-nginx-multifile-desktop.png'));

  await page.getByLabel('Domain name').fill('invalid;domain');
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  await captureFullPageEvidence(page, testInfo.outputPath('visual-validation-error-desktop.png'));

  await page.setViewportSize({width: 820, height: 1180});
  await page.goto('/generators/nginx');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/generators/nginx');
  await page.getByRole('button', {name: 'Generate configuration'}).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await captureFullPageEvidence(page, testInfo.outputPath('visual-nginx-mobile.png'));
});
