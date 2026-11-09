import test from 'node:test';
import assert from 'node:assert/strict';
import {createZipBytes} from '../dist/ui/zip.js';

test('browser ZIP export includes every artifact name and a valid central directory', () => {
  const bytes = createZipBytes([
    {filename: 'site.conf', content: 'server {}\n'},
    {filename: 'http-shared.conf', content: 'map $a $b {}\n'},
  ]);
  const text = new TextDecoder().decode(bytes);
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.ok(text.includes('site.conf'));
  assert.ok(text.includes('http-shared.conf'));
  assert.equal(new DataView(bytes.buffer).getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(new DataView(bytes.buffer).getUint16(bytes.length - 12, true), 2);
});
