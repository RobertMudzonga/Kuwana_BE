import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as Minio from 'minio';
import { env } from '../config/env';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

let minioClient: Minio.Client | null = null;
const getMinio = () => {
  minioClient ??= new Minio.Client({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL === 'true',
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  });
  return minioClient;
};

/** Store an uploaded image and return its public URL */
export async function storeImage(buffer: Buffer, mimeType: string): Promise<string> {
  const key = `uploads/${new Date().toISOString().slice(0, 7)}/${uuidv4()}.${EXTENSIONS[mimeType] ?? 'bin'}`;

  if (env.STORAGE_DRIVER === 'minio') {
    await getMinio().putObject(env.MINIO_BUCKET_NAME, key, buffer, buffer.length, { 'Content-Type': mimeType });
    const base = env.MINIO_PUBLIC_URL
      ?? `${env.MINIO_USE_SSL === 'true' ? 'https' : 'http'}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}/${env.MINIO_BUCKET_NAME}`;
    return `${base.replace(/\/$/, '')}/${key}`;
  }

  const filePath = path.join(env.UPLOAD_DIR, key.replace(/^uploads\//, ''));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/${key}`;
}

/** Make the MinIO bucket publicly readable so image URLs work in the app */
export async function ensurePublicBucket(): Promise<void> {
  const client = getMinio();
  if (!(await client.bucketExists(env.MINIO_BUCKET_NAME))) {
    await client.makeBucket(env.MINIO_BUCKET_NAME, 'us-east-1');
  }
  await client.setBucketPolicy(env.MINIO_BUCKET_NAME, JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${env.MINIO_BUCKET_NAME}/uploads/*`],
    }],
  }));
}
