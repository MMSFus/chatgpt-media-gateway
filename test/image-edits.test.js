import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import './helpers/env.js';
import sharp from 'sharp';
import { attachImageReferences, generateImages, parseImageEditInput, uploadReference } from '../src/upstream.js';
import { resizeToTarget } from '../src/resize.js';

function png(width = 2, height = 3) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('multipart and JSON edit inputs validate reference images and reject unsupported fields', () => {
  const boundary = 'edit-input';
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nrepair\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="ref.png"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    png(), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parsed = parseImageEditInput(multipart, `multipart/form-data; boundary=${boundary}`);
  assert.equal(parsed.payload.prompt, 'repair');
  assert.deepEqual(parsed.references.map(({ mimeType, width, height }) => ({ mimeType, width, height })), [{ mimeType: 'image/png', width: 2, height: 3 }]);

  const json = Buffer.from(JSON.stringify({ prompt: 'repair', images: [{ image_url: `data:image/png;base64,${png().toString('base64')}` }] }));
  assert.equal(parseImageEditInput(json, 'application/json').references[0].mimeType, 'image/png');
  assert.throws(() => parseImageEditInput(Buffer.from(JSON.stringify({ prompt: 'x', image: 'https://example.com/a.png' })), 'application/json'), /image_url must be a data: URL or base64/);
  assert.throws(() => parseImageEditInput(Buffer.from(JSON.stringify({ prompt: 'x', image: Buffer.from('no').toString('base64') })), 'application/json'), /PNG, JPEG, or WebP/);
  assert.throws(() => parseImageEditInput(Buffer.from(JSON.stringify({ prompt: 'x', image: Array(5).fill(png().toString('base64')) })), 'application/json'), /between 1 and 4/);
  assert.throws(() => parseImageEditInput(Buffer.from(JSON.stringify({ prompt: 'x', image: png().toString('base64'), mask: 'x' })), 'application/json'), /mask is not supported/);
});

test('reference upload uses three ordered steps and an unauthenticated blob PUT', async () => {
  const calls = [];
  const upstream = async (_account, _chain, path, options) => {
    calls.push({ kind: 'upstream', path, options });
    return { bytes: Buffer.from(JSON.stringify(path === '/files' ? { upload_url: 'https://mock.blob.core.windows.net/container/file', file_id: 'file-1' } : {})) };
  };
  const transport = async (url, options) => {
    calls.push({ kind: 'put', url: String(url), options });
    const response = Readable.from([]); response.statusCode = 201; return response;
  };
  const result = await uploadReference({}, [], { bytes: png(), name: 'ref.png', mimeType: 'image/png', width: 2, height: 3 }, { requestUpstream: upstream, requestThroughProxy: transport });
  assert.equal(result.fileId, 'file-1');
  assert.deepEqual(calls.map((call) => call.kind === 'upstream' ? call.path : call.kind), ['/files', 'put', '/files/file-1/uploaded']);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Cookie, undefined);
  assert.equal(calls[1].options.headers['x-ms-blob-type'], 'BlockBlob');
});

test('untrusted upload host fails before a PUT and n=2 uploads references once', async () => {
  let puts = 0;
  await assert.rejects(uploadReference({}, [], { bytes: png(), name: 'ref.png', mimeType: 'image/png', width: 2, height: 3 }, {
    requestUpstream: async () => ({ bytes: Buffer.from(JSON.stringify({ upload_url: 'https://example.com/file', file_id: 'file-1' })) }),
    requestThroughProxy: async () => { puts += 1; },
  }), /unsupported image upload host/);
  assert.equal(puts, 0);

  let uploads = 0;
  let generations = 0;
  const data = await generateImages({}, [], { prompt: 'edit', n: 2, response_format: 'b64_json' }, [{ bytes: png() }], {
    uploadReference: async () => { uploads += 1; return { fileId: 'file-1', mimeType: 'image/png', name: 'ref.png', sizeBytes: 24, width: 2, height: 3 }; },
    generateOneImage: async (_account, _chain, prompt, references) => {
      generations += 1;
      assert.equal(prompt, 'edit'); assert.equal(references[0].fileId, 'file-1');
      return [{ b64_json: png().toString('base64') }];
    },
  });
  assert.equal(uploads, 1);
  assert.equal(generations, 2);
  assert.equal(data.data.length, 2);
});

test('image references produce multimodal parts and attachment metadata', () => {
  const message = { metadata: {} };
  attachImageReferences(message, 'repair', [{ fileId: 'file-1', mimeType: 'image/png', name: 'ref.png', sizeBytes: 24, width: 2, height: 3 }]);
  assert.deepEqual(message.content.parts[0], { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-1', width: 2, height: 3, size_bytes: 24 });
  assert.equal(message.content.parts[1], 'repair');
  assert.deepEqual(message.metadata.attachments, [{ id: 'file-1', mimeType: 'image/png', name: 'ref.png', size: 24, width: 2, height: 3 }]);
});

test('edit reference images use the same target-size cover resize behavior', async () => {
  const source = await sharp({ create: { width: 1792, height: 1024, channels: 3, background: '#4679a1' } }).png().toBuffer();
  const parsed = parseImageEditInput(Buffer.from(JSON.stringify({
    prompt: 'repair', image: `data:image/png;base64,${source.toString('base64')}`,
  })), 'application/json');
  const resized = await resizeToTarget(parsed.references[0].bytes, { width: 1280, height: 720 });
  const dimensions = await sharp(resized.bytes).metadata();
  assert.equal(resized.resized, true);
  assert.deepEqual([dimensions.width, dimensions.height], [1280, 720]);
});
