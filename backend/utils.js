export function validateEAN(barcode) {
  if (!/^\d{8}|^\d{12}|^\d{13}|^\d{14}/.test(barcode)) return false;
  const digits = barcode.split('').map(Number);
  const checkDigit = digits.pop();
  const multiplier = digits.length % 2 === 0 ? [1, 3] : [3, 1];
  let sum = 0;
  digits.forEach((d, i) => {
    sum += d * multiplier[i % 2];
  });
  const expected = (10 - (sum % 10)) % 10;
  return expected === checkDigit;
}

export function logger(level, message, data = {}) {
  const payload = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data });
  if (level === 'error' || level === 'warn') {
    console.error(payload);
  } else {
    console.log(payload);
  }
}

export async function validateTgInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    const keys = Array.from(urlParams.keys()).sort();
    const dataCheckString = keys.map(k => `${k}=${urlParams.get(k)}`).join('\n');
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode("WebAppData"),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const botTokenHash = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
    const signingKey = await crypto.subtle.importKey(
      'raw',
      botTokenHash,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(dataCheckString));
    const hexHash = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hexHash === hash;
  } catch (e) {
    return false;
  }
}

export function transliterate(text) {
  if (!text) return '';
  const map = {"а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"h","ц":"c","ч":"ch","ш":"sh","щ":"sch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"};
  return text.toLowerCase().split('').map(c => map[c] || c).join('');
}

export function getBigrams(str) {
  const bigrams = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
}

export function similarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);
  if (b1.size === 0 && b2.size === 0) return 1;
  if (b1.size === 0 || b2.size === 0) return 0;
  let intersection = 0;
  for (const b of b1) {
    if (b2.has(b)) intersection++;
  }
  return (2.0 * intersection) / (b1.size + b2.size);
}

export function normalizeBarcode(str) {
  if (!str) return '';
  return String(str).replace(/\D/g, '').replace(/^0+/, '');
}

export function getCountryByPrefix(code) {
  if (!code || code.length < 3) return null;
  const p3 = parseInt(code.substring(0, 3), 10);
  if (p3 >= 460 && p3 <= 469) return 'Россия';
  if (p3 === 481) return 'Беларусь';
  if (p3 === 482) return 'Украина';
  if (p3 === 487) return 'Казахстан';
  if (p3 === 478) return 'Узбекистан';
  if (p3 === 485) return 'Армения';
  if (p3 === 486) return 'Грузия';
  if (p3 === 484) return 'Молдова';
  if (p3 === 476) return 'Азербайджан';
  if (p3 === 470) return 'Кыргызстан';
  if (p3 === 488) return 'Таджикистан';
  if (p3 === 483) return 'Туркменистан';
  if (p3 >= 400 && p3 <= 440) return 'Германия';
  if (p3 >= 300 && p3 <= 379) return 'Франция';
  if (p3 >= 800 && p3 <= 839) return 'Италия';
  if (p3 >= 840 && p3 <= 849) return 'Испания';
  if (p3 >= 500 && p3 <= 509) return 'Великобритания';
  if (p3 >= 690 && p3 <= 699) return 'Китай';
  if ((p3 >= 450 && p3 <= 459) || (p3 >= 490 && p3 <= 499)) return 'Япония';
  if (p3 === 880) return 'Южная Корея';
  if (p3 === 869) return 'Турция';
  if (p3 <= 139) return 'США / Канада';
  return null;
}

export function extractNumbers(text) {
  if (!text) return [];
  const matches = text.match(/\d+/g);
  return matches ? matches.map(Number) : [];
}
