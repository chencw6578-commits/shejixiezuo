import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  figmaToken: req('FIGMA_TOKEN', ''),
  databaseUrl: req(
    'DATABASE_URL',
    'postgres://postgres:postgres@localhost:5432/designhub'
  ),
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localDir: process.env.STORAGE_LOCAL_DIR ?? 'storage',
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      bucket: process.env.S3_BUCKET ?? 'designhub',
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? '',
    },
  },
};

export const isFigmaConfigured = () => config.figmaToken.length > 0;
