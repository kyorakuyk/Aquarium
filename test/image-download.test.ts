import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadImageAsDataUrl } from '../src/core/images.ts';

const imageUrl = 'https://images.example.test/cat.png';
const maxImageBytes = 5 * 1024 * 1024;

test('HTTP 图片下载后按响应类型转换为 data URL', async () => {
  const requested: Array<{ url: string; signal?: AbortSignal | null }> = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    requested.push({ url, signal: init?.signal });
    return new Response(Uint8Array.of(1, 2, 3), {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    });
  };

  const result = await downloadImageAsDataUrl(imageUrl, fetcher);

  assert.equal(result, 'data:image/png;base64,AQID');
  assert.equal(requested[0]?.url, imageUrl);
  assert.ok(requested[0]?.signal instanceof AbortSignal);
});

test('只接受 jpeg、png、gif 和 webp 响应类型', async () => {
  for (const mediaType of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
    const result = await downloadImageAsDataUrl(imageUrl, async () => new Response(Uint8Array.of(1), {
      status: 200,
      headers: { 'content-type': `${mediaType}; charset=binary` },
    }));
    assert.ok(result.startsWith(`data:${mediaType};base64,`));
  }
  await assert.rejects(
    downloadImageAsDataUrl(imageUrl, async () => new Response(Uint8Array.of(1), {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
    })),
    /content-type/u,
  );
});

test('已有图片 data URL 不发起下载', async () => {
  let fetchCount = 0;
  const result = await downloadImageAsDataUrl('data:image/jpeg;base64,AQID', async () => {
    fetchCount += 1;
    throw new Error('data URL must not be fetched');
  });

  assert.equal(result, 'data:image/jpeg;base64,AQID');
  assert.equal(fetchCount, 0);
});

test('下载超时会由 abort signal 中止', async () => {
  const fetcher = (_url: string, init?: RequestInit): Promise<Response> => new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return reject(new Error('missing abort signal'));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  await assert.rejects(downloadImageAsDataUrl(imageUrl, fetcher, 5), /timeout|abort/iu);
});

test('非 2xx 响应与不支持的 content-type 均被拒绝', async () => {
  await assert.rejects(
    downloadImageAsDataUrl(imageUrl, async () => new Response('missing', { status: 404 })),
    /HTTP 404/u,
  );
  await assert.rejects(
    downloadImageAsDataUrl(imageUrl, async () => new Response('not an image', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })),
    /content-type/u,
  );
});

test('声明或实际内容超过 5 MiB 时下载会被拒绝', async () => {
  await assert.rejects(
    downloadImageAsDataUrl(imageUrl, async () => new Response(Uint8Array.of(1), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(maxImageBytes + 1) },
    })),
    /5 MiB/u,
  );
  await assert.rejects(
    downloadImageAsDataUrl(imageUrl, async () => new Response(new Uint8Array(maxImageBytes + 1), {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    })),
    /5 MiB/u,
  );
});
