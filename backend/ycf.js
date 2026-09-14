import { handleProductRequest } from './core.js';
import { CONFIG } from './config.js';

export async function handler(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CONFIG.HEADERS,
      body: ''
    };
  }

  const path = event.url || event.path || '';
  const barcode = (event.queryStringParameters && event.queryStringParameters.barcode) || '';

  if (path.includes('/api/health')) {
    return {
      statusCode: 200,
      headers: CONFIG.HEADERS,
      body: JSON.stringify({ status: 'ok', timestamp: Date.now() })
    };
  }

  if (path.includes('/api/product') || barcode) {
    const headers = event.headers || {};
    const tgInitData = headers['x-telegram-init-data'] || headers['X-Telegram-Init-Data'] || '';
    const botToken = process.env.TG_BOT_TOKEN || '';

    const chunks = [];

    const emit = (evt, data) => {
      chunks.push(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await handleProductRequest(barcode, tgInitData, botToken, emit);
    } catch (e) {
      chunks.push(`event: error\ndata: ${JSON.stringify({ error: 'server_error', message: e.message })}\n\n`);
    }

    const responseHeaders = Object.assign({}, CONFIG.HEADERS);
    responseHeaders['Content-Type'] = 'text/event-stream; charset=utf-8';
    responseHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0';
    responseHeaders['Pragma'] = 'no-cache';
    responseHeaders['Expires'] = '0';
    responseHeaders['Connection'] = 'keep-alive';
    responseHeaders['X-Accel-Buffering'] = 'no';

    return {
      statusCode: 200,
      headers: responseHeaders,
      body: chunks.join('')
    };
  }

  return {
    statusCode: 200,
    headers: CONFIG.HEADERS,
    body: JSON.stringify({ status: 'ok', timestamp: Date.now() })
  };
}