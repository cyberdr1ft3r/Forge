import test from 'node:test';
import assert from 'node:assert/strict';
import {strFromU8, unzipSync} from 'fflate';
import {createZipBytes} from '../dist/ui/zip.js';

const artifacts = [
  {filename: 'site.conf', content: 'server {\n    server_name app.example.com;\n}\n'},
  {filename: 'http-shared.conf', content: 'map $http_upgrade $connection_upgrade {\n    default upgrade;\n}\n'},
  {filename: 'mime-types.conf', content: '# UTF-8 integrity: café, العربية, 日本語, 🚀\ndefault_type application/octet-stream;\n'},
];

test('browser ZIP export independently extracts every exact filename and UTF-8 artifact', () => {
  const bytes = createZipBytes(artifacts);
  const extracted = unzipSync(bytes);

  assert.deepEqual(Object.keys(extracted).sort(), artifacts.map(artifact => artifact.filename).sort());
  for (const artifact of artifacts) {
    assert.ok(extracted[artifact.filename], `missing ${artifact.filename}`);
    assert.equal(strFromU8(extracted[artifact.filename]), artifact.content);
  }
  assert.equal(strFromU8(extracted['http-shared.conf']), artifacts[1].content, 'supporting HTTP artifact must remain byte-identical');
});

test('browser ZIP output is deterministic for identical artifacts', () => {
  assert.deepEqual(createZipBytes(artifacts), createZipBytes(structuredClone(artifacts)));
});

test('browser ZIP export rejects duplicate, traversal, nested, absolute, and unsupported filenames', () => {
  for (const filename of ['../escape.conf', '..\\escape.conf', 'nested/site.conf', '/absolute.conf', 'C:\\escape.conf', 'café.conf', 'line\nbreak.conf']) {
    assert.throws(() => createZipBytes([{filename, content: 'unsafe\n'}]), /Unsafe ZIP artifact filename/);
  }
  assert.throws(() => createZipBytes([{filename: 'site.conf', content: 'one\n'}, {filename: 'site.conf', content: 'two\n'}]), /Duplicate ZIP artifact filename/);
  assert.throws(() => createZipBytes([]), /ZIP export requires/);
});
