// Cloudflare R2 object store (S3 API, SigV4, no SDK).
import { createHash, createHmac } from 'node:crypto';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function r2Store({ endpoint, bucket, accessKeyId, secretAccessKey }) {
  const host = new URL(endpoint).host;
  async function request(method, key, { body = Buffer.alloc(0), query = {} } = {}) {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const path = '/' + bucket + (key ? '/' + key.split('/').map(enc).join('/') : '');
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${enc(k)}=${enc(query[k])}`)
      .join('&');
    const payload = sha(body);
    const headers = { host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
    const signed = Object.keys(headers).sort();
    const canonicalText = [
      method,
      path,
      qs,
      signed.map((h) => `${h}:${headers[h]}\n`).join(''),
      signed.join(';'),
      payload,
    ].join('\n');
    const scope = `${day}/auto/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonicalText)].join('\n');
    let k = hmac('AWS4' + secretAccessKey, day);
    for (const part of ['auto', 's3', 'aws4_request']) k = hmac(k, part);
    const signature = createHmac('sha256', k).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
    delete headers.host;
    const res = await fetch(`${endpoint}${path}${qs ? '?' + qs : ''}`, {
      method,
      headers,
      body: method === 'PUT' ? body : undefined,
    });
    if (method === 'GET' && res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 ${method} ${key || '(list)'} failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return {
    async put(key, body) {
      await request('PUT', key, { body });
    },
    get: (key) => request('GET', key),
    remove: (key) => request('DELETE', key),
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
        const xml = (await request('GET', '', { query })).toString('utf8');
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? /<NextContinuationToken>([^<]*)</.exec(xml)?.[1]
          : undefined;
      } while (token);
      return keys;
    },
  };
}
