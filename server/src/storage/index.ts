import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

export interface Storage {
  /** 存储对象并返回可访问的 URL。 */
  put(key: string, data: Buffer, contentType: string): Promise<string>;
  /** 读取对象。 */
  get(key: string): Promise<Buffer>;
}

class LocalStorage implements Storage {
  constructor(private dir: string) {}

  private abs(key: string) {
    // 防目录穿越
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(path.resolve(this.dir))) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, data: Buffer): Promise<string> {
    const p = this.abs(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
    return `/storage/${key}`;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.abs(key));
  }
}

class S3Storage implements Storage {
  private constructor(
    private s3: typeof import('@aws-sdk/client-s3'),
    private client: S3Client
  ) {}

  static async create(): Promise<S3Storage> {
    const s3 = await import('@aws-sdk/client-s3');
    const client = new s3.S3Client({
      endpoint: config.storage.s3.endpoint,
      region: config.storage.s3.region,
      forcePathStyle: true, // MinIO 兼容
      credentials: {
        accessKeyId: config.storage.s3.accessKeyId,
        secretAccessKey: config.storage.s3.secretAccessKey,
      },
    });
    return new S3Storage(s3, client);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<string> {
    const { PutObjectCommand } = this.s3;
    await this.client.send(
      new PutObjectCommand({
        Bucket: config.storage.s3.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );
    if (config.storage.s3.publicBaseUrl) {
      return `${config.storage.s3.publicBaseUrl.replace(/\/$/, '')}/${config.storage.s3.bucket}/${key}`;
    }
    // 无公网基址时使用预签名 URL（最长 7 天）
    const { GetObjectCommand } = this.s3;
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }),
      { expiresIn: 7 * 24 * 3600 }
    );
  }

  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = this.s3;
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: key })
    );
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
}

let storage: Promise<Storage> | null = null;

export function getStorage(): Promise<Storage> {
  if (!storage) {
    storage =
      config.storage.driver === 's3'
        ? S3Storage.create()
        : Promise.resolve(new LocalStorage(config.storage.localDir));
  }
  return storage;
}
