import {outcomes} from './generators/index.js';
import {composeNginxCapabilities} from './nginx-composition/index.js';
import type {Diagnostic, GenerationOutcome, OutputArtifact, ValidationRecord, ValidationSummary} from './core/types.js';
import type {CapabilitySelection, NginxCompositionOutcome} from './nginx-composition/types.js';
import {createZipBlob} from './ui/zip.js';

type GeneratorId = 'nginx' | 'compose' | 'systemd';
type FieldValue = string | boolean;
type UiResult = GenerationOutcome | NginxCompositionOutcome;

interface FieldOption { readonly value: string; readonly label: string; }
interface FieldDefinition {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'number' | 'checkbox' | 'select';
  readonly description: string;
  readonly group: string;
  readonly placeholder?: string;
  readonly options?: readonly FieldOption[];
  readonly visible?: (values: Readonly<Record<string, FieldValue>>) => boolean;
}
interface GeneratorDefinition {
  readonly label: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly FieldDefinition[];
}

const applicationRoot = document.getElementById('app');
if (applicationRoot === null) throw new Error('Missing application root.');
const app: HTMLElement = applicationRoot;

const githubUrl = 'https://github.com/cyberdr1ft3r/Forge';
const docsUrl = `${githubUrl}/blob/main/docs/ARCHITECTURE.md`;
const generatorIds: readonly GeneratorId[] = ['nginx', 'compose', 'systemd'];
const defaults: Record<GeneratorId, Record<string, FieldValue>> = {
  nginx: {
    workflow: 'reverse-proxy', profile: 'full-config', domain: 'app.example.com', targetHost: '127.0.0.1', targetPort: '3000',
    tls: false, certificatePath: '/etc/nginx/certs/app.example.com.pem', privateKeyPath: '/etc/nginx/private/app.example.com.key',
    redirectHttp: true, websockets: false, documentRoot: '/var/www/example', indexFile: 'index.html', spaFallback: false,
  },
  compose: {service: 'web', image: 'nginx:stable', hostPort: '8080', containerPort: '80', restart: 'unless-stopped'},
  systemd: {service: 'myapp', description: 'My application', user: 'appuser', workdir: '/opt/myapp', executable: '/usr/bin/node', arguments: 'server.js'},
};

const definitions: Record<GeneratorId, GeneratorDefinition> = {
  nginx: {
    label: 'Nginx', eyebrow: 'NGINX / CAPABILITY COMPOSITION', title: 'Nginx configuration',
    description: 'Compose a reverse proxy or static site from Forge’s typed capability engine, then inspect every required artifact.',
    fields: [
      {id: 'workflow', label: 'Workflow', type: 'select', group: 'Site type', description: 'Choose the capability set that owns this site.', options: [
        {value: 'reverse-proxy', label: 'Reverse proxy'}, {value: 'static-site', label: 'Static website'},
      ]},
      {id: 'profile', label: 'Output profile', type: 'select', group: 'Site type', description: 'Complete configuration includes events/http contexts; a site fragment may require supporting files.', options: [
        {value: 'full-config', label: 'Complete nginx.conf'}, {value: 'site-fragment', label: 'Site fragment'},
      ]},
      {id: 'domain', label: 'Domain name', type: 'text', group: 'Connection', description: 'Exact fully qualified server name.', placeholder: 'app.example.com'},
      {id: 'targetHost', label: 'Upstream host', type: 'text', group: 'Connection', description: 'Literal hostname or IP reachable from Nginx.', placeholder: '127.0.0.1', visible: item => item.workflow === 'reverse-proxy'},
      {id: 'targetPort', label: 'Upstream port', type: 'number', group: 'Connection', description: 'TCP port from 1 to 65535.', placeholder: '3000', visible: item => item.workflow === 'reverse-proxy'},
      {id: 'documentRoot', label: 'Document root', type: 'text', group: 'Static files', description: 'Absolute directory containing the deployed site.', placeholder: '/var/www/example', visible: item => item.workflow === 'static-site'},
      {id: 'indexFile', label: 'Index file', type: 'text', group: 'Static files', description: 'Safe entry filename relative to the document root.', placeholder: 'index.html', visible: item => item.workflow === 'static-site'},
      {id: 'spaFallback', label: 'Single Page Application fallback', type: 'checkbox', group: 'Static files', description: 'Route missing files to the index entry.', visible: item => item.workflow === 'static-site'},
      {id: 'tls', label: 'Enable HTTPS', type: 'checkbox', group: 'TLS & protocol', description: 'Requires explicit certificate files on the target host.'},
      {id: 'certificatePath', label: 'Certificate-chain path', type: 'text', group: 'TLS & protocol', description: 'Absolute path to an existing PEM certificate chain.', visible: item => item.tls === true},
      {id: 'privateKeyPath', label: 'Private-key path', type: 'text', group: 'TLS & protocol', description: 'Absolute path to a distinct protected PEM private key.', visible: item => item.tls === true},
      {id: 'redirectHttp', label: 'Redirect HTTP to HTTPS', type: 'checkbox', group: 'TLS & protocol', description: 'Create a separate port 80 redirect server.', visible: item => item.tls === true},
      {id: 'websockets', label: 'Enable WebSocket support', type: 'checkbox', group: 'TLS & protocol', description: 'Add the trusted HTTP upgrade map and route headers.', visible: item => item.workflow === 'reverse-proxy'},
    ],
  },
  compose: {
    label: 'Docker Compose', eyebrow: 'DOCKER COMPOSE / SERVICE', title: 'Docker Compose service',
    description: 'Generate a single loopback-bound container service using the existing Forge generator contract.',
    fields: [
      {id: 'service', label: 'Service name', type: 'text', group: 'Service', description: 'Compose service identifier.'},
      {id: 'image', label: 'Container image', type: 'text', group: 'Service', description: 'Use a pinned tag or digest for deployment.'},
      {id: 'hostPort', label: 'Host port', type: 'number', group: 'Networking', description: 'Loopback port exposed on the host.'},
      {id: 'containerPort', label: 'Container port', type: 'number', group: 'Networking', description: 'Port exposed by the container.'},
      {id: 'restart', label: 'Restart policy', type: 'select', group: 'Runtime', description: 'Docker Compose restart behavior.', options: ['unless-stopped', 'always', 'no', 'on-failure'].map(value => ({value, label: value}))},
    ],
  },
  systemd: {
    label: 'systemd', eyebrow: 'SYSTEMD / SERVICE UNIT', title: 'systemd service',
    description: 'Create a hardened Linux service unit using the existing Forge generator contract.',
    fields: [
      {id: 'service', label: 'Service name', type: 'text', group: 'Identity', description: 'Unit base name.'},
      {id: 'description', label: 'Description', type: 'text', group: 'Identity', description: 'Human-readable service description.'},
      {id: 'user', label: 'Linux user', type: 'text', group: 'Execution', description: 'Unprivileged account that runs the service.'},
      {id: 'workdir', label: 'Working directory', type: 'text', group: 'Execution', description: 'Absolute application directory.'},
      {id: 'executable', label: 'Executable path', type: 'text', group: 'Execution', description: 'Absolute binary path.'},
      {id: 'arguments', label: 'Arguments', type: 'text', group: 'Execution', description: 'Optional space-separated literal arguments.'},
    ],
  },
};

let selected: GeneratorId = 'nginx';
const values: Record<GeneratorId, Record<string, FieldValue>> = structuredClone(defaults);
let currentResult: UiResult | null = null;
let selectedArtifactId = '';

function isGeneratorId(value: string): value is GeneratorId { return generatorIds.includes(value as GeneratorId); }
function generatorFromPath(pathname: string): GeneratorId | null {
  const match = /^\/generators\/(nginx|compose|systemd)\/?$/.exec(pathname);
  return match?.[1] !== undefined && isGeneratorId(match[1]) ? match[1] : null;
}
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function icon(id: GeneratorId): string { return id === 'nginx' ? 'N' : id === 'compose' ? 'D' : 'S'; }

function navMarkup(inWorkspace: boolean): string {
  return `<header class="site-nav">
    <a class="brand" href="/" data-route><span class="brand-mark" aria-hidden="true">◇</span><span>FORGE</span></a>
    ${inWorkspace ? `<label class="generator-switch"><span class="sr-only">Active generator</span><select id="generator-switch">${generatorIds.map(id => `<option value="${id}"${id === selected ? ' selected' : ''}>Generators / ${definitions[id].label}</option>`).join('')}</select></label>` : ''}
    <nav aria-label="Primary navigation">
      ${inWorkspace ? '<a href="/generators/nginx" data-route>Workspace</a>' : '<a href="#generators">Generators</a>'}
      <a href="${docsUrl}" target="_blank" rel="noreferrer">Docs</a><a href="${githubUrl}" target="_blank" rel="noreferrer">GitHub</a>
    </nav>
  </header>`;
}

function renderLanding(): void {
  document.title = 'Forge — Configuration Studio';
  app.innerHTML = `${navMarkup(false)}
    <main id="main-content" class="landing" tabindex="-1">
      <section class="hero" aria-labelledby="hero-title">
        <p class="overline">LOCAL-FIRST CONFIGURATION STUDIO</p><h1 id="hero-title">Infrastructure configs,<br><span>composed with intent.</span></h1>
        <p class="hero-copy">Forge turns guided inputs into deterministic Nginx, Docker Compose, and systemd configuration files. Review every artifact and validate it with the native tool before deployment.</p>
        <div class="hero-actions"><a class="button button-primary" href="/generators/nginx" data-route>Start generating <span aria-hidden="true">→</span></a><a class="button button-secondary" href="${githubUrl}" target="_blank" rel="noreferrer">View on GitHub</a></div>
        <p class="local-note"><span aria-hidden="true">●</span> Generation stays in your browser. No credentials, deployment, or telemetry.</p>
      </section>
      <section id="generators" class="generator-section" aria-labelledby="generator-title">
        <div class="section-intro"><p class="overline">SUPPORTED GENERATORS</p><h2 id="generator-title">Choose a configuration workflow</h2><p>Each generator uses strict typed input and keeps native validation status honest.</p></div>
        <div class="generator-cards">${generatorIds.map(id => `<a class="generator-card" href="/generators/${id}" data-route><span class="card-icon" aria-hidden="true">${icon(id)}</span><span class="card-status">Available</span><h3>${definitions[id].label}</h3><p>${id === 'nginx' ? 'Reverse proxy, HTTPS, WebSocket, static site, and SPA workflows.' : id === 'compose' ? 'A secure loopback-bound single-service Compose file.' : 'A hardened service unit for a Linux application.'}</p><span class="card-link">Open generator <span aria-hidden="true">→</span></span></a>`).join('')}</div>
      </section>
      <section class="cli-callout" aria-labelledby="cli-title"><div><p class="overline">FORGE CLI</p><h2 id="cli-title">Command-line workflow</h2><p>A Forge CLI is planned, but it is not available in v0.1.</p></div><span class="coming-soon">Coming soon</span></section>
    </main><footer class="site-footer"><span>Forge v0.1 prototype</span><span>Review and natively validate every output before use.</span></footer>`;
  bindRoutes();
}

function fieldMarkup(field: FieldDefinition, fieldValues: Readonly<Record<string, FieldValue>>): string {
  if (field.visible !== undefined && !field.visible(fieldValues)) return '';
  const rawValue = fieldValues[field.id] ?? '';
  const errorId = `${field.id}-error`;
  if (field.type === 'checkbox') return `<div class="field field-checkbox" data-field-wrap="${field.id}"><label for="${field.id}"><input id="${field.id}" name="${field.id}" type="checkbox"${rawValue === true ? ' checked' : ''}><span><strong>${field.label}</strong><small>${field.description}</small></span></label><p class="field-error" id="${errorId}"></p></div>`;
  const control = field.type === 'select'
    ? `<select id="${field.id}" name="${field.id}" aria-describedby="${field.id}-help ${errorId}">${(field.options ?? []).map(option => `<option value="${escapeHtml(option.value)}"${rawValue === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`
    : `<input id="${field.id}" name="${field.id}" type="${field.type}" value="${escapeHtml(String(rawValue))}"${field.placeholder === undefined ? '' : ` placeholder="${escapeHtml(field.placeholder)}"`} aria-describedby="${field.id}-help ${errorId}">`;
  return `<div class="field" data-field-wrap="${field.id}"><label for="${field.id}">${field.label}</label>${control}<small id="${field.id}-help">${field.description}</small><p class="field-error" id="${errorId}"></p></div>`;
}
function fieldsMarkup(definition: GeneratorDefinition, fieldValues: Readonly<Record<string, FieldValue>>): string {
  const visible = definition.fields.filter(field => field.visible === undefined || field.visible(fieldValues));
  const groups = [...new Set(visible.map(field => field.group))];
  return groups.map((group, index) => `<fieldset><legend><span>${String(index + 1).padStart(2, '0')}</span>${group}</legend><div class="field-grid">${visible.filter(field => field.group === group).map(field => fieldMarkup(field, fieldValues)).join('')}</div></fieldset>`).join('');
}

function renderWorkspace(): void {
  const definition = definitions[selected];
  document.title = `${definition.label} Generator — Forge`;
  app.innerHTML = `${navMarkup(true)}
    <main id="main-content" class="workspace-page" tabindex="-1">
      <header class="workspace-heading"><div><p class="overline">${definition.eyebrow}</p><h1>${definition.title}</h1><p>${definition.description}</p></div><a class="back-link" href="/" data-route>All generators</a></header>
      <section class="workspace" aria-label="Generator workspace">
        <div class="panel configuration-panel"><div class="panel-label"><span>01</span> / CONFIGURATION</div>
          <form id="generator-form" novalidate>${fieldsMarkup(definition, values[selected])}<div id="form-message" class="form-message" role="alert" hidden></div><button class="button button-primary generate-button" type="submit">Generate configuration <span aria-hidden="true">→</span></button><p class="form-note">Inputs remain local. Forge does not connect to servers or run deployment commands.</p></form>
        </div>
        <aside class="panel preview-panel" aria-label="Generated file preview"><div class="panel-label"><span>02</span> / FILE PREVIEW</div><div id="artifact-tabs" class="artifact-tabs" role="tablist" aria-label="Generated artifacts"></div><div class="preview-heading"><div><span class="file-icon" aria-hidden="true">▤</span><strong id="filename">No file generated</strong></div><span id="artifact-role" class="role-badge">Waiting</span></div><pre id="preview" tabindex="0" aria-label="Configuration preview"><code id="output">Complete the form and generate a configuration.</code></pre><div id="preview-message" class="preview-message" aria-live="polite"></div><div class="preview-actions"><button id="copy" type="button" disabled>⧉ Copy</button><button id="download" type="button" disabled>↓ Download</button><button id="download-all" type="button" disabled hidden>↓ ZIP</button><button id="expand" type="button" disabled>⛶ Expand</button></div><section class="details" aria-labelledby="prerequisites-title"><h2 id="prerequisites-title">Prerequisites & cautions</h2><div id="prerequisites"><p>Generate a configuration to see target-host prerequisites.</p></div></section></aside>
      </section>
    </main>
    <section class="validation-bar" aria-label="Validation status"><strong><span aria-hidden="true">●</span> LOCAL GENERATION</strong><div id="validation-records"><span>○ Input not run</span><span>○ Static checks not run</span><span>△ Native validator unavailable</span><span>○ Target host not checked</span></div></section>
    <dialog id="expanded-preview" aria-labelledby="expanded-title"><div class="dialog-head"><div><p class="panel-label">EXPANDED FILE PREVIEW</p><h2 id="expanded-title">Generated configuration</h2></div><button id="close-expanded" type="button" aria-label="Close expanded preview">×</button></div><pre tabindex="0"><code id="expanded-output"></code></pre></dialog>`;
  bindWorkspace(); bindRoutes();
}

function captureValues(): void {
  const form = document.getElementById('generator-form');
  if (!(form instanceof HTMLFormElement)) return;
  for (const field of definitions[selected].fields) {
    const control = form.elements.namedItem(field.id);
    if (control instanceof HTMLInputElement && field.type === 'checkbox') values[selected][field.id] = control.checked;
    else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) values[selected][field.id] = control.value;
  }
}
function navigate(url: string): void {
  const next = new URL(url, window.location.href); window.history.pushState({}, '', next.pathname); renderRoute();
  document.getElementById('main-content')?.focus({preventScroll: true}); window.scrollTo({top: 0});
}
function bindRoutes(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[data-route]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); captureValues(); navigate(link.href); }));
}
function bindWorkspace(): void {
  const switcher = document.getElementById('generator-switch');
  if (switcher instanceof HTMLSelectElement) switcher.addEventListener('change', () => { captureValues(); if (isGeneratorId(switcher.value)) navigate(`/generators/${switcher.value}`); });
  const form = document.getElementById('generator-form'); if (!(form instanceof HTMLFormElement)) return;
  form.addEventListener('input', event => {
    captureValues(); const target = event.target; if (target instanceof HTMLElement) clearFieldError(target.id);
    if (target instanceof HTMLSelectElement && target.id === 'workflow' || target instanceof HTMLInputElement && target.id === 'tls') { renderWorkspace(); document.getElementById(target.id)?.focus(); }
  });
  form.addEventListener('submit', event => { event.preventDefault(); generate(); });
  document.getElementById('copy')?.addEventListener('click', () => void copySelected());
  document.getElementById('download')?.addEventListener('click', downloadSelected);
  document.getElementById('download-all')?.addEventListener('click', downloadAll);
  document.getElementById('expand')?.addEventListener('click', openExpanded);
  document.getElementById('close-expanded')?.addEventListener('click', () => { const dialog = document.getElementById('expanded-preview'); if (dialog instanceof HTMLDialogElement) dialog.close(); });
}

function numeric(value: FieldValue): number { return typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN; }
function nginxRequest(fieldValues: Readonly<Record<string, FieldValue>>): unknown {
  const capabilities: CapabilitySelection[] = [];
  if (fieldValues.workflow === 'static-site') capabilities.push({id: 'static-site', input: {domain: fieldValues.domain, documentRoot: fieldValues.documentRoot, indexFile: fieldValues.indexFile, spaFallback: fieldValues.spaFallback}});
  else {
    capabilities.push({id: 'reverse-proxy', input: {domain: fieldValues.domain, targetHost: fieldValues.targetHost, targetPort: numeric(fieldValues.targetPort ?? '')}});
    if (fieldValues.websockets === true) capabilities.push({id: 'websocket', input: {routes: ['/']}});
  }
  if (fieldValues.tls === true) capabilities.push({id: 'tls', input: {certificatePath: fieldValues.certificatePath, privateKeyPath: fieldValues.privateKeyPath, redirectHttp: fieldValues.redirectHttp}});
  return {profile: String(fieldValues.profile), target: {version: '1.26.3', modules: ['http_log', 'http_map', 'http_proxy', 'http_rewrite', 'http_ssl']}, capabilities};
}
function legacyInput(id: Exclude<GeneratorId, 'nginx'>, fieldValues: Readonly<Record<string, FieldValue>>): Record<string, FieldValue | number> {
  return id === 'compose' ? {...fieldValues, hostPort: numeric(fieldValues.hostPort ?? ''), containerPort: numeric(fieldValues.containerPort ?? '')} : {...fieldValues};
}
function generate(): void {
  captureValues(); clearErrors();
  currentResult = selected === 'nginx' ? composeNginxCapabilities(nginxRequest(values.nginx)) : outcomes[selected](legacyInput(selected, values[selected]));
  selectedArtifactId = currentResult.ok ? currentResult.artifacts[0]?.id ?? '' : ''; renderResult();
}
function statusLabel(label: string, record: ValidationRecord): string {
  const mark = record.status === 'passed' ? '✓' : record.status === 'failed' ? '×' : record.status === 'unavailable' ? '△' : '○';
  const wording = record.status === 'unavailable' ? 'unavailable' : record.status === 'not-run' ? 'not run' : record.status;
  return `${mark} ${label} ${wording}`;
}
function selectedArtifact(): OutputArtifact | undefined {
  if (currentResult === null || !currentResult.ok) return undefined;
  return currentResult.artifacts.find(artifact => artifact.id === selectedArtifactId) ?? currentResult.artifacts[0];
}
function renderResult(): void {
  if (currentResult === null) return; renderValidation(currentResult.validation);
  if (!currentResult.ok) {
    showDiagnostics(currentResult.diagnostics); setText('filename', 'Generation blocked'); setText('artifact-role', 'Invalid input'); setText('output', 'Fix the highlighted fields, then generate again.'); setText('preview-message', 'No artifact was created.'); setActions(false, false); document.getElementById('artifact-tabs')?.replaceChildren(); renderPrerequisites([]); return;
  }
  showDiagnostics([]); renderArtifactTabs(currentResult.artifacts); renderSelectedArtifact();
  const prerequisites = 'prerequisites' in currentResult ? currentResult.prerequisites : currentResult.deploymentSteps.map((description, index) => ({code: `step-${index}`, description}));
  renderPrerequisites(prerequisites);
}
function renderArtifactTabs(artifacts: readonly OutputArtifact[]): void {
  const host = document.getElementById('artifact-tabs'); if (host === null) return; host.replaceChildren(); if (artifacts.length < 2) return;
  for (const artifact of artifacts) { const button = document.createElement('button'); button.type = 'button'; button.role = 'tab'; button.textContent = artifact.filename; button.dataset.artifactId = artifact.id; button.ariaSelected = String(artifact.id === selectedArtifactId); button.addEventListener('click', () => { selectedArtifactId = artifact.id; renderArtifactTabs(artifacts); renderSelectedArtifact(); }); host.append(button); }
}
function renderSelectedArtifact(): void {
  const artifact = selectedArtifact(); if (artifact === undefined || currentResult === null || !currentResult.ok) return;
  setText('filename', artifact.filename); setText('artifact-role', artifact.role === 'primary' ? 'Primary' : 'Supporting'); setText('output', artifact.content); setText('expanded-output', artifact.content);
  setText('preview-message', currentResult.artifacts.length > 1 ? `${currentResult.artifacts.length} required artifacts generated. Select a file to inspect it.` : 'Configuration generated locally.'); setActions(true, currentResult.artifacts.length > 1);
}
function renderValidation(validation: ValidationSummary): void {
  const host = document.getElementById('validation-records'); if (host === null) return;
  const records: readonly [string, ValidationRecord][] = [['Input', validation.input], ['Static checks', validation.static], ['Native validator', validation.native], ['Target host', validation.targetHost ?? {status: 'not-run', diagnostics: []}]];
  host.replaceChildren(...records.map(([label, record]) => { const span = document.createElement('span'); span.className = `validation-${record.status}`; span.textContent = statusLabel(label, record); span.title = record.diagnostics.map(item => item.message).join(' ') || `${label}: ${record.status}`; return span; }));
}
function diagnosticField(diagnostic: Diagnostic): string | undefined {
  const path = diagnostic.path ?? ''; return definitions[selected].fields.map(field => field.id).find(id => path.endsWith(`.${id}`) || path === id);
}
function showDiagnostics(diagnostics: readonly Diagnostic[]): void {
  const general: string[] = [];
  for (const diagnostic of diagnostics.filter(item => item.severity === 'error')) {
    const field = diagnosticField(diagnostic);
    if (field === undefined) general.push(diagnostic.message);
    else { setText(`${field}-error`, diagnostic.message); document.getElementById(field)?.setAttribute('aria-invalid', 'true'); document.querySelector(`[data-field-wrap="${field}"]`)?.classList.add('has-error'); }
  }
  const message = document.getElementById('form-message'); if (message instanceof HTMLElement) { message.hidden = general.length === 0; message.textContent = general.join(' '); }
  document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}
function clearFieldError(id: string): void { document.getElementById(id)?.removeAttribute('aria-invalid'); document.querySelector(`[data-field-wrap="${id}"]`)?.classList.remove('has-error'); setText(`${id}-error`, ''); }
function clearErrors(): void { definitions[selected].fields.forEach(field => clearFieldError(field.id)); const message = document.getElementById('form-message'); if (message instanceof HTMLElement) { message.hidden = true; message.textContent = ''; } }
function renderPrerequisites(items: readonly {readonly description: string; readonly path?: string}[]): void {
  const host = document.getElementById('prerequisites'); if (host === null) return; host.replaceChildren();
  if (items.length === 0) { const paragraph = document.createElement('p'); paragraph.textContent = 'No artifacts were produced, so prerequisites are unavailable.'; host.append(paragraph); return; }
  const list = document.createElement('ul'); for (const item of items) { const entry = document.createElement('li'); entry.textContent = item.path === undefined ? item.description : `${item.description} (${item.path})`; list.append(entry); } host.append(list);
}
function setActions(enabled: boolean, multiple: boolean): void {
  for (const id of ['copy', 'download', 'expand']) { const button = document.getElementById(id); if (button instanceof HTMLButtonElement) button.disabled = !enabled; }
  const all = document.getElementById('download-all'); if (all instanceof HTMLButtonElement) { all.disabled = !enabled || !multiple; all.hidden = !multiple; }
}
async function copySelected(): Promise<void> {
  const artifact = selectedArtifact(); if (artifact === undefined) return;
  try { await navigator.clipboard.writeText(artifact.content); setText('preview-message', `${artifact.filename} copied to the clipboard.`); } catch { setText('preview-message', 'Clipboard access is unavailable. Select the preview text and copy it manually.'); }
}
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
function downloadSelected(): void { const artifact = selectedArtifact(); if (artifact === undefined) return; saveBlob(new Blob([artifact.content], {type: `${artifact.mediaType};charset=utf-8`}), artifact.filename); setText('preview-message', `${artifact.filename} download prepared.`); }
function downloadAll(): void { if (currentResult === null || !currentResult.ok || currentResult.artifacts.length < 2) return; saveBlob(createZipBlob(currentResult.artifacts), 'forge-nginx-artifacts.zip'); setText('preview-message', `ZIP prepared with ${currentResult.artifacts.length} required artifacts.`); }
function openExpanded(): void { const artifact = selectedArtifact(); const dialog = document.getElementById('expanded-preview'); if (artifact === undefined || !(dialog instanceof HTMLDialogElement)) return; setText('expanded-title', artifact.filename); setText('expanded-output', artifact.content); dialog.showModal(); document.getElementById('close-expanded')?.focus(); }
function setText(id: string, value: string): void { const element = document.getElementById(id); if (element !== null) element.textContent = value; }
function renderRoute(): void { const routeGenerator = generatorFromPath(window.location.pathname); if (routeGenerator !== null) { selected = routeGenerator; currentResult = null; selectedArtifactId = ''; renderWorkspace(); } else renderLanding(); }

window.addEventListener('popstate', renderRoute);
renderRoute();
