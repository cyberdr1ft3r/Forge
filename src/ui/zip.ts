import type {OutputArtifact} from '../core/types.js';

const encoder = new TextEncoder();
const SAFE_ARTIFACT_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function uint32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

/** Creates a deterministic, uncompressed ZIP locally without executing or uploading configuration content. */
export function createZipBytes(artifacts: readonly Pick<OutputArtifact, 'filename' | 'content'>[]): Uint8Array {
  if (artifacts.length === 0 || artifacts.length > 65_535) throw new Error('ZIP export requires between 1 and 65535 artifacts.');
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const filenames = new Set<string>();
  let offset = 0;
  for (const artifact of artifacts) {
    if (!SAFE_ARTIFACT_FILENAME.test(artifact.filename)) throw new Error(`Unsafe ZIP artifact filename: ${artifact.filename}.`);
    if (filenames.has(artifact.filename)) throw new Error(`Duplicate ZIP artifact filename: ${artifact.filename}.`);
    filenames.add(artifact.filename);
    const name = encoder.encode(artifact.filename);
    const data = encoder.encode(artifact.content);
    if (data.length > 0xffffffff) throw new Error(`ZIP artifact is too large: ${artifact.filename}.`);
    const checksum = crc32(data);
    const local = concat([uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0), uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name, data]);
    localParts.push(local);
    centralParts.push(concat([uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0), uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset), name]));
    offset += local.length;
  }
  const central = concat(centralParts);
  const end = concat([uint32(0x06054b50), uint16(0), uint16(0), uint16(artifacts.length), uint16(artifacts.length), uint32(central.length), uint32(offset), uint16(0)]);
  return concat([...localParts, central, end]);
}

export function createZipBlob(artifacts: readonly Pick<OutputArtifact, 'filename' | 'content'>[]): Blob {
  const bytes = createZipBytes(artifacts);
  return new Blob([bytes.buffer as ArrayBuffer], {type: 'application/zip'});
}
