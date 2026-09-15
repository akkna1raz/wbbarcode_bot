import Redis from 'ioredis';
import { CONFIG } from './config.js';

let redisClient = null;

function isValidRedisUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') return false;
    if (!parsed.hostname) return false;
    return true;
  } catch (e) {
    return false;
  }
}

if (CONFIG.REDIS_URL && isValidRedisUrl(CONFIG.REDIS_URL)) {
  const options = {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 100, 2000);
    }
  };
  if (CONFIG.REDIS_URL.startsWith('rediss://')) {
    options.tls = {};
  }
  try {
    redisClient = new Redis(CONFIG.REDIS_URL, options);
    redisClient.on('error', () => {});
  } catch (e) {
    redisClient = null;
  }
}

export async function getStaticCache(barcode) {
  if (!redisClient) return null;
  try {
    const data = await redisClient.get(`v2:static:${barcode}`);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

export async function setStaticCache(barcode, data) {
  if (!redisClient) return;
  try {
    await redisClient.setex(`v2:static:${barcode}`, CONFIG.CACHE_STATIC_TTL, JSON.stringify(data));
  } catch (e) {}
}

export async function getDynamicCache(article) {
  if (!redisClient) return null;
  try {
    const data = await redisClient.get(`v2:dynamic:${article}`);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

export async function setDynamicCache(article, data) {
  if (!redisClient) return;
  try {
    await redisClient.setex(`v2:dynamic:${article}`, CONFIG.CACHE_DYNAMIC_TTL, JSON.stringify(data));
  } catch (e) {}
}

export async function getNegativeCache(barcode) {
  if (!redisClient) return null;
  try {
    const data = await redisClient.get(`v2:negative:${barcode}`);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

export async function setNegativeCache(barcode, data) {
  if (!redisClient) return;
  try {
    await redisClient.setex(`v2:negative:${barcode}`, CONFIG.CACHE_NEGATIVE_TTL, JSON.stringify(data));
  } catch (e) {}
}

export async function acquireLock(key, ttlSec) {
  if (!redisClient) return true;
  try {
    const result = await redisClient.set(`v2:lock:${key}`, '1', 'EX', ttlSec, 'NX');
    return result === 'OK';
  } catch (e) {
    return true;
  }
}

export async function releaseLock(key) {
  if (!redisClient) return;
  try {
    await redisClient.del(`v2:lock:${key}`);
  } catch (e) {}
}
