import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { put as blobPut, head as blobHead, list as blobList, del as blobDel } from '@vercel/blob';
import { config, privateTeamStorage } from '../config.js';

const PRIVATE_ASSET_PREFIX = '/api/storage/';
const designObjectKey = /^(?:files|assets)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

export function privateAssetKey(url: string): string | null {
  if (!url.startsWith(PRIVATE_ASSET_PREFIX)) return null;
  try {
    const segments = url.slice(PRIVATE_ASSET_PREFIX.length).split('/').map(decodeURIComponent);
    if (segments.some((part) => !part || part === '.' || part === '..' || /[/\\\x00-\x1f\x7f]/.test(part))) {
      return null;
    }
    const key = segments.join('/');
    return assetFileId(key) ? key : null;
  } catch {
    return null;
  }
}

export function assetFileId(key: string): string | null {
  return designObjectKey.exec(key)?.[1] ?? null;
}

export function storageKeyFromUrl(url: string): string | null {
  return url.startsWith('/storage/') ? url.slice('/storage/'.length) : privateAssetKey(url);
}

export interface Storage {
  /** 存储对象并返回可访问的 URL。 */
  put(key: string, data: Buffer, contentType: string): Promise<string>;
  /** 读取对象。 */
  get(key: string): Promise<Buffer>;
  /** 删除指定前缀下的全部对象（用于删除设计稿时清理孤儿图片）。 */
  delPrefix(prefix: string): Promise<number>;
}

/**
 * 清洗 key 中的 Windows 非法字符（尤其 Figma node id 的冒号，如 301:680@2x.png）。
 * 含冒号的路径在 NTFS 上会被写成「备用数据流」：表面是 0 字节文件，数据藏在
 * 流里，普通复制/备份会静默丢失——曾导致整板位图与切图全部读不到、导出退化成空图。
 * 读写入口统一映射后，历史 DB 里的冒号 URL 仍可读，新写入的 URL 不再含冒号。
 */
const safeKey = (key: string) =>
  key.split('/').map((seg) => seg.replace(/[:<>"\\|?*]/g, '_')).join('/');

class LocalStorage implements Storage {
  constructor(private dir: string) {}

  private abs(key: string) {
    // 防目录穿越
    const p = path.resolve(this.dir, safeKey(key));
    if (!p.startsWith(path.resolve(this.dir))) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, data: Buffer): Promise<string> {
    const p = this.abs(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
    return `/storage/${safeKey(key)}`;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.abs(key));
  }

  async delPrefix(prefix: string): Promise<number> {
    const dir = path.resolve(this.dir, safeKey(prefix));
    if (!dir.startsWith(path.resolve(this.dir))) throw new Error('invalid storage key');
    try {
      await rm(dir, { recursive: true, force: true });
      return 1;
    } catch {
      return 0;
    }
  }
}

/**
 * S3 兼容客户端工厂（R2 / MinIO / AWS S3 通用）。预签名直传路由也复用它，
 * 保证签名 URL 与实际读写走同一份 endpoint / bucket / 凭据配置。
 */
export async function createS3Client(): Promise<{
  s3: typeof import('@aws-sdk/client-s3');
  client: S3Client;
}> {
  const s3 = await import('@aws-sdk/client-s3');
  const client = new s3.S3Client({
    endpoint: config.storage.s3.endpoint,
    region: config.storage.s3.region,
    forcePathStyle: true, // MinIO / Cloudflare R2 兼容
    credentials: {
      accessKeyId: config.storage.s3.accessKeyId,
      secretAccessKey: config.storage.s3.secretAccessKey,
    },
  });
  return { s3, client };
}

class S3Storage implements Storage {
  private constructor(
    private s3: typeof import('@aws-sdk/client-s3'),
    private client: S3Client
  ) {}

  static async create(): Promise<S3Storage> {
    const { s3, client } = await createS3Client();
    return new S3Storage(s3, client);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<string> {
    const privateUrl = privateTeamStorage
      ? PRIVATE_ASSET_PREFIX + key.split('/').map(encodeURIComponent).join('/')
      : null;
    if (privateUrl && !privateAssetKey(privateUrl)) throw new Error('Invalid private asset key');
    const { PutObjectCommand } = this.s3;
    await this.client.send(
      new PutObjectCommand({
        Bucket: config.storage.s3.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );
    if (privateUrl) return privateUrl;
    if (config.storage.s3.publicBaseUrl) {
      const base = config.storage.s3.publicBaseUrl.replace(/\/$/, '');
      const prefix = config.storage.s3.publicIncludeBucket ? `/${config.storage.s3.bucket}` : '';
      return `${base}${prefix}/${key}`;
    }
    // 无公网基址时使用预签名 URL（最长 7 天）。
    // 注意：生产环境必须配置 S3_PUBLIC_BASE_URL，否则存进数据库的图片地址会过期。
    const { GetObjectCommand } = this.s3;
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }),
      { expiresIn: 7 * 24 * 3600 }
    );
  }

  async open(key: string) {
    const { GetObjectCommand } = this.s3;
    return this.client.send(new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.open(key);
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async delPrefix(prefix: string): Promise<number> {
    const { ListObjectsV2Command, DeleteObjectsCommand } = this.s3;
    let continuation: string | undefined;
    let deleted = 0;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: config.storage.s3.bucket,
          Prefix: prefix,
          ContinuationToken: continuation,
        })
      );
      const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: config.storage.s3.bucket,
            Delete: { Objects: keys, Quiet: true },
          })
        );
        deleted += keys.length;
      }
      continuation = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuation);
    return deleted;
  }
}

/**
 * Vercel Blob 存储（Serverless 部署专用）。
 *
 * Vercel 函数文件系统只读，缩略图/切图必须落到对象存储。Blob 是 Vercel 自带服务，
 * 建 Store 后自动注入 BLOB_READ_WRITE_TOKEN，无需额外账号、密钥或信用卡。
 * public blob 的 URL 长期有效，存进数据库不会像 S3 预签名 URL 那样 7 天过期。
 */
class BlobStorage implements Storage {
  async put(key: string, data: Buffer, contentType: string): Promise<string> {
    const result = await blobPut(safeKey(key), data, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return result.url;
  }

  async get(key: string): Promise<Buffer> {
    // key 可能是 pathname（直传临时对象），也可能是历史存库的完整 URL
    let url = key;
    if (!/^https?:\/\//i.test(key)) {
      const info = await blobHead(safeKey(key));
      url = info.url;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`读取 Blob 失败 (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delPrefix(prefix: string): Promise<number> {
    let cursor: string | undefined;
    let deleted = 0;
    do {
      const page = await blobList({ prefix: safeKey(prefix), cursor, limit: 1000 });
      const urls = page.blobs.map((b) => b.url);
      if (urls.length) {
        await blobDel(urls);
        deleted += urls.length;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return deleted;
  }
}

let storage: Promise<Storage> | null = null;

export function getStorage(): Promise<Storage> {
  if (!storage) {
    storage =
      config.storage.driver === 's3'
        ? S3Storage.create()
        : config.storage.driver === 'blob'
          ? Promise.resolve(new BlobStorage())
          : Promise.resolve(new LocalStorage(config.storage.localDir));
  }
  return storage;
}

export async function openPrivateAsset(key: string) {
  const storage = await getStorage();
  if (!(storage instanceof S3Storage)) throw new Error('Private assets require S3 storage');
  return storage.open(key);
}

/**
 * 删除一个设计稿关联的全部 Blob 对象。
 *
 * 所有图片 key 都带 fileId 前缀，分两类：
 *   - files/<fileId>/…  画板缩略图、节点渲染、SVG、插件切图、上传图
 *   - assets/<fileId>/… 用户导出的切图
 * 两个前缀都要清；单个前缀失败不影响另一个，也不阻断调用方的 DB 删除。
 */
export async function deleteFileBlobs(fileId: string): Promise<number> {
  const store = await getStorage();
  let deleted = 0;
  for (const prefix of [`files/${fileId}/`, `assets/${fileId}/`]) {
    try {
      deleted += await store.delPrefix(prefix);
    } catch (err) {
      console.warn(`[storage] 清理 ${prefix} 失败:`, err instanceof Error ? err.message : String(err));
    }
  }
  return deleted;
}
