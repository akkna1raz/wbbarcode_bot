export const CONFIG = {
  DISCOUNT_MULTIPLIER: 0.5,
  WB_GEO_DEST: -1257786,
  CACHE_STATIC_TTL: 2592000,
  CACHE_DYNAMIC_TTL: 600,
  CACHE_NEGATIVE_TTL: 3600,
  CACHE_LOCK_TTL: 30,
  WB_TIMEOUT_MS: 3200,
  WB_RATE_LIMIT_MS: 120,
  WB_RETRY_ATTEMPTS: 3,
  YANDEX_SEARCH_API_KEY: process.env.YANDEX_SEARCH_API_KEY || '',
  YANDEX_GPT_API_KEY: process.env.YANDEX_GPT_API_KEY || '',
  YANDEX_FOLDER_ID: process.env.YANDEX_FOLDER_ID || '',
  YANDEX_TIMEOUT_MS: 6000,
  GPT_TIMEOUT_MS: 8000,
  HEADERS: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, X-Telegram-Init-Data',
    'Access-Control-Max-Age': '86400'
  },
  REDIS_URL: process.env.REDIS_URL || '',
  WB_PROXY_URL: process.env.WB_PROXY_URL || ''
};