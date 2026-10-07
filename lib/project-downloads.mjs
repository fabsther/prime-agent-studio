import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';

const DEFAULT_DOWNLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
const contentTypes = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

export function downloadLimit(value = process.env.STUDIO_DOWNLOAD_LIMIT_BYTES) {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_DOWNLOAD_LIMIT;
}

export const downloadContentType = (name) =>
  contentTypes[extname(name).toLowerCase()] || 'application/octet-stream';

// Single ranges only. Suffix ranges and multipart ranges are not part of fleet v1.
// null means unsatisfiable/invalid; undefined means the whole representation.
export function parseDownloadRange(value, size) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]),
    end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function matchesIfRange(value, file) {
  if (value === undefined) return true;
  if (value === file.etag) return true;
  // HTTP dates have second precision. Never accept weak entity tags.
  const date = Date.parse(value);
  return Number.isFinite(date) && Math.floor(file.modifiedAtMs / 1000) * 1000 === date;
}

export async function sendProjectDownload(req, res, file) {
  try {
    const headers = {
      'Content-Type': downloadContentType(file.name),
      'Content-Disposition': `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(file.name.toWellFormed()).replace(/['()*]/g, (value) => '%' + value.charCodeAt(0).toString(16))}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      ETag: file.etag,
      'Last-Modified': new Date(file.modifiedAtMs).toUTCString(),
    };
    // Range applies to GET, not HEAD (RFC 9110).
    const range =
      req.method === 'GET' && matchesIfRange(req.headers['if-range'], file)
        ? parseDownloadRange(req.headers.range, file.size)
        : undefined;
    if (range === null) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}`, 'Content-Length': 0 });
      res.end();
      return;
    }
    const length = range ? range.end - range.start + 1 : file.size;
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'Content-Length': length,
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${file.size}` } : {}),
    });
    if (req.method === 'HEAD' || !length) {
      res.end();
      return;
    }
    // Bound the stream to the stat snapshot, even if the file grows during transfer.
    await pipeline(
      file.handle.createReadStream({
        start: range?.start ?? 0,
        end: range?.end ?? file.size - 1,
        autoClose: false,
      }),
      res,
    );
  } finally {
    await file.handle.close();
  }
}
