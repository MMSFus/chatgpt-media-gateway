import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(resolve(projectDirectory, '.env')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

/** Reads a mandatory secret from the process environment and fails startup when it is absent. */
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8080),
  adminKey: required('ADMIN_KEY'),
  apiKey: required('API_KEY'),
  dataKey: Buffer.from(required('DATA_ENCRYPTION_KEY'), 'hex'),
  dataDir: resolve(process.env.DATA_DIR || './data'),
  dbPath: resolve(process.env.DATA_DIR || './data', 'gateway.sqlite'),
  upstream: process.env.CHATGPT_BASE_URL || 'https://chatgpt.com/backend-api',
  tencentSecretId: process.env.TENCENTCLOUD_SECRET_ID || '',
  tencentSecretKey: process.env.TENCENTCLOUD_SECRET_KEY || '',
  tencentCosBucket: process.env.TENCENT_COS_BUCKET || '',
  tencentRegion: process.env.TENCENT_REGION || 'ap-guangzhou',
  // Set to 1 only behind a reverse proxy that overwrites X-Forwarded-Proto (e.g. Caddy).
  trustProxy: process.env.TRUST_PROXY === '1',
  tencentTiiaBaseUrl: process.env.TENCENT_TIIA_BASE_URL || 'https://tiia.tencentcloudapi.com',
  tencentCosBaseUrl: process.env.TENCENT_COS_BASE_URL || '',
};

if (config.dataKey.length !== 32) {
  throw new Error('DATA_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)');
}
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
