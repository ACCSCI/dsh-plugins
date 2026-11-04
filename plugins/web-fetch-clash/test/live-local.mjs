import { ClashFetchProvider } from '../index.js';

const limits = { maxResponseBytes: 5e6, maxBodyChars: 1e5, timeoutMs: 30000, maxRedirects: 5, userAgent: 'dsh-clash-test/1.0' };

const run = async (label, url, opts) => {
  const provider = new ClashFetchProvider(limits, opts);
  const started = Date.now();
  try {
    const result = await provider.fetch({ url }, new AbortController().signal);
    console.log(label.padEnd(30), '->', result.statusCode, result.body.kind, `${Date.now() - started}ms`, JSON.stringify(result.body.content.slice(0, 50)));
  } catch (error) {
    console.log(label.padEnd(30), '-> ERR', error.code ?? '', `(${Date.now() - started}ms)`, String(error.message).slice(0, 80));
  }
};

await run('[proxy https:example]', 'https://example.com', {});
await run('[proxy http:example]', 'http://example.com', {});
await run('[proxy https:google]', 'https://www.google.com', {});
await run('[no proxy -> fake-ip 直连]', 'https://example.com', { proxyPort: 7899 });
await run('[private literal]', 'http://127.0.0.1:9/', {});
await run('[cross-origin redirect]', 'http://github.com', {});
