import {generators} from './generators/index.js';
import type {LegacyGeneratorResult} from './core/types.js';

type GeneratorId = keyof typeof generators;
type FieldType = 'text' | 'number' | 'checkbox' | 'select';
type Field = readonly [id: string, label: string, type: FieldType, value: string | boolean];

interface UiOption {
  readonly title: string;
  readonly subtitle: string;
  readonly fields: readonly Field[];
}

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing UI element: ${id}.`);
  return found as T;
};

const options: Record<GeneratorId, UiOption> = {
  nginx: {title: 'Nginx reverse proxy', subtitle: 'Configure your domain and upstream', fields: [['domain', 'Domain name', 'text', 'app.example.com'], ['port', 'Application port', 'number', '3000'], ['tls', 'Enable HTTPS redirect + TLS server', 'checkbox', true], ['websockets', 'WebSocket upgrade support', 'checkbox', false]]},
  compose: {title: 'Docker Compose service', subtitle: 'Generate a loopback-bound container service', fields: [['service', 'Service name', 'text', 'web'], ['image', 'Container image', 'text', 'nginx:stable'], ['hostPort', 'Host port', 'number', '8080'], ['containerPort', 'Container port', 'number', '80'], ['restart', 'Restart policy', 'select', 'unless-stopped']]},
  systemd: {title: 'systemd service', subtitle: 'Create a managed Linux service unit', fields: [['service', 'Service name', 'text', 'myapp'], ['description', 'Description', 'text', 'My application'], ['user', 'Linux user', 'text', 'appuser'], ['workdir', 'Working directory', 'text', '/opt/myapp'], ['executable', 'Executable path', 'text', '/usr/bin/node'], ['arguments', 'Arguments (optional)', 'text', 'server.js']]},
};

let selected: GeneratorId = 'nginx';
let result: LegacyGeneratorResult | null = null;

function render(): void {
  const option = options[selected];
  element('heading').textContent = option.title;
  element('subtitle').textContent = option.subtitle;
  element('crumb').textContent = option.title.split(' ')[0] ?? option.title;
  const form = element<HTMLFormElement>('generator-form');
  form.replaceChildren();
  for (const [id, label, type, value] of option.fields) {
    const wrapper = document.createElement('label');
    wrapper.className = type === 'checkbox' ? 'check' : 'field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement(type === 'select' ? 'select' : 'input');
    input.name = id;
    input.id = id;
    if (input instanceof HTMLInputElement) input.type = type;
    if (type === 'checkbox' && input instanceof HTMLInputElement) input.checked = value === true;
    else if (type === 'select' && input instanceof HTMLSelectElement) {
      for (const policy of ['unless-stopped', 'always', 'no', 'on-failure']) {
        const item = document.createElement('option');
        item.value = policy;
        item.textContent = policy;
        input.append(item);
      }
      input.value = String(value);
    } else input.value = String(value);
    if (type === 'checkbox') wrapper.append(input, span);
    else wrapper.append(span, input);
    form.append(wrapper);
  }
  document.querySelectorAll<HTMLElement>('[data-type]').forEach(item => item.classList.toggle('active', item.dataset.type === selected));
  generateSelected();
}

function readInput(): Record<string, FormDataEntryValue | boolean> {
  const data: Record<string, FormDataEntryValue | boolean> = {};
  new FormData(element<HTMLFormElement>('generator-form')).forEach((value, key) => { data[key] = value; });
  for (const [id, , type] of options[selected].fields) {
    if (type === 'checkbox') data[id] = element<HTMLInputElement>(id).checked;
  }
  return data;
}

function generateSelected(): void {
  try {
    result = generators[selected](readInput());
    element('output').textContent = result.content;
    element('filename').textContent = result.filename;
    element('status').textContent = 'Generated';
    element('status').classList.remove('error');
    element('message').textContent = '';
    const steps = element('steps');
    steps.replaceChildren();
    for (const step of result.steps) {
      const item = document.createElement('li');
      item.textContent = step;
      steps.append(item);
    }
    const checks = element('checks');
    checks.replaceChildren();
    for (const check of result.checks) {
      const item = document.createElement('p');
      item.textContent = `⚠ ${check}`;
      checks.append(item);
    }
  } catch (error) {
    result = null;
    element('status').textContent = 'Invalid input';
    element('status').classList.add('error');
    element('message').textContent = error instanceof Error ? error.message : 'Generation failed.';
    element('output').textContent = 'Fix the input values to generate a configuration.';
    element('steps').replaceChildren();
    element('checks').replaceChildren();
  }
}

document.querySelectorAll<HTMLElement>('[data-type]').forEach(item => item.addEventListener('click', () => {
  const id = item.dataset.type;
  if (id !== undefined && id in generators) {
    selected = id as GeneratorId;
    render();
  }
}));
element('generate').addEventListener('click', generateSelected);
element('copy').addEventListener('click', async () => {
  if (result === null) return;
  try {
    await navigator.clipboard.writeText(result.content);
    element('copy').textContent = 'Copied ✓';
    window.setTimeout(() => { element('copy').textContent = 'Copy code'; }, 1_300);
  } catch {
    element('message').textContent = 'Clipboard unavailable; select the preview text manually.';
  }
});
element('download').addEventListener('click', () => {
  if (result === null) return;
  const url = URL.createObjectURL(new Blob([result.content], {type: 'text/plain;charset=utf-8'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();
  URL.revokeObjectURL(url);
});
render();
