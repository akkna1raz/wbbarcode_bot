import { CONFIG } from './config.js';
import { transliterate, similarity, extractNumbers } from './utils.js';
import nodeFetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

let wbLastRequestAt = 0;

async function wbThrottle() {
  const now = Date.now();
  const wait = Math.max(0, wbLastRequestAt + CONFIG.WB_RATE_LIMIT_MS - now);
  wbLastRequestAt = now + wait;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

function normalizeBrand(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.toLowerCase().trim();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/ä/g, 'a')
       .replace(/ö/g, 'o')
       .replace(/ü/g, 'u')
       .replace(/ß/g, 'ss')
       .replace(/ё/g, 'е');
  s = transliterate(s);
  s = s.replace(/['’`"«»\-_. ,:;!/\\()&#+]/g, '');
  return s;
}

function extractWeightsAndVolumes(text) {
  if (!text || typeof text !== 'string') return [];
  const regex = /(?:^|\D)(\d+(?:[.,]\d+)?)\s*(мл|ml|л|l|литр(?:а|ов)?|г|g|гр|грамм(?:а|ов)?|кг|kg|килограмм(?:а|ов)?)(?=\D|$)/gi;
  const list = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    const rawVal = parseFloat(m[1].replace(',', '.'));
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue;

    let inBase = rawVal;
    let type = 'weight';

    if (['мл', 'ml'].includes(unit)) {
      inBase = rawVal;
      type = 'vol';
    } else if (['л', 'l', 'литр', 'литра', 'литров'].some(u => unit.startsWith(u))) {
      inBase = rawVal * 1000;
      type = 'vol';
    } else if (['кг', 'kg', 'килограмм', 'килограмма', 'килограммов'].some(u => unit.startsWith(u))) {
      inBase = rawVal * 1000;
      type = 'weight';
    } else {
      inBase = rawVal;
      type = 'weight';
    }

    list.push({ rawVal, unit, inBase, type });
  }
  return list;
}

function buildFallbackQuery(sourceProduct, originalQuery) {
  const parts = [];
  if (sourceProduct.brand) parts.push(sourceProduct.brand);
  if (sourceProduct.model) parts.push(sourceProduct.model);

  if (!sourceProduct.model && sourceProduct.name) {
    const brandLower = (sourceProduct.brand || '').toLowerCase();
    const words = sourceProduct.name
      .replace(/[«»"'(),.!?/\\-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !w.toLowerCase().includes(brandLower));
    parts.push(...words.slice(0, 3));
  }

  const fallback = parts.join(' ').replace(/\s+/g, ' ').trim();
  return fallback.length >= 3 && fallback.toLowerCase() !== originalQuery.toLowerCase() ? fallback : null;
}

export async function findBestWbOffer(sourceProduct, barcode) {
  if (!sourceProduct) {
    return { found: false, error: 'empty_source' };
  }

  let query = typeof sourceProduct.wb_query === 'string' ? sourceProduct.wb_query.trim() : '';

  if (sourceProduct.brand) {
    const brandTrimmed = sourceProduct.brand.trim();
    if (query) {
      if (!query.toLowerCase().includes(brandTrimmed.toLowerCase())) {
        query = `${brandTrimmed} ${query}`;
      }
    } else {
      query = brandTrimmed;
    }
  }

  if (!query) {
    const parts = [];
    if (sourceProduct.brand) parts.push(sourceProduct.brand);
    if (sourceProduct.model) parts.push(sourceProduct.model);
    if (sourceProduct.name) parts.push(sourceProduct.name);
    if (sourceProduct.quantity && sourceProduct.unit) {
      parts.push(`${sourceProduct.quantity} ${sourceProduct.unit}`);
    }
    query = parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  if (!query) {
    return { found: false, error: 'empty_source' };
  }

  query = query.substring(0, 100);

  let searchResult = await executeWbSearch(query);

  if ((!searchResult.data || searchResult.data.length === 0) && !searchResult.error) {
    const fallbackQuery = buildFallbackQuery(sourceProduct, query);
    if (fallbackQuery) {
      const fallbackResult = await executeWbSearch(fallbackQuery);
      if (fallbackResult.data && fallbackResult.data.length > 0) {
        searchResult = fallbackResult;
      }
    }
  }

  if (searchResult.error) {
    return { found: false, error: searchResult.error };
  }

  const items = searchResult.data || [];
  if (items.length === 0) {
    return { found: false, error: 'not_found' };
  }

  const subjectFreq = new Map();
  const prices = [];

  for (const item of items) {
    const sid = item.subjectId;
    if (sid) {
      subjectFreq.set(sid, (subjectFreq.get(sid) || 0) + 1);
    }
    item.priceRub = extractPrice(item);
    item.oldPriceRub = extractOldPrice(item);
    if (item.priceRub > 0) prices.push(item.priceRub);
  }

  let modeSubjectId = null;
  let maxFreq = 0;
  for (const [sid, freq] of subjectFreq.entries()) {
    if (freq > maxFreq) {
      maxFreq = freq;
      modeSubjectId = sid;
    }
  }

  prices.sort((a, b) => a - b);
  const medianPrice = prices.length > 0 ? prices[Math.floor(prices.length / 2)] : 0;

  const normSrcBrand = normalizeBrand(sourceProduct.brand);
  const srcModel = (sourceProduct.model || '').toLowerCase().trim();
  const srcName = (sourceProduct.name || '').toLowerCase().trim();
  const srcQuery = (sourceProduct.wb_query || '').toLowerCase().trim();

  const srcQueryTrans = transliterate(
    srcQuery || `${sourceProduct.brand || ''} ${sourceProduct.name || ''}`.trim()
  );

  let targetWV = null;
  if (sourceProduct.volume !== null && sourceProduct.volume !== undefined && Number(sourceProduct.volume) > 0) {
    targetWV = Number(sourceProduct.volume);
  } else if (sourceProduct.weight !== null && sourceProduct.weight !== undefined && Number(sourceProduct.weight) > 0) {
    targetWV = Number(sourceProduct.weight);
  }

  const hasExplicitSrcQty = sourceProduct.quantity !== null &&
                            sourceProduct.quantity !== undefined &&
                            Number.isFinite(Number(sourceProduct.quantity)) &&
                            Number(sourceProduct.quantity) > 0;
  const srcQty = hasExplicitSrcQty ? Number(sourceProduct.quantity) : null;

  const numericTargets = [];
  if (srcQty) numericTargets.push(srcQty);
  if (targetWV) numericTargets.push(targetWV);

  for (const item of items) {
    let score = 0;
    const itemName = (item.name || '').toLowerCase();
    const wbBrandRaw = (item.brand || '').trim();
    const normWbBrand = normalizeBrand(wbBrandRaw);
    const normItemName = normalizeBrand(item.name);

    if (modeSubjectId) {
      if (item.subjectId === modeSubjectId) {
        score += 30;
      } else {
        score -= 20;
      }
    }

    if (normSrcBrand) {
      let brandHit = false;

      if (normWbBrand && (normWbBrand.includes(normSrcBrand) || normSrcBrand.includes(normWbBrand))) {
        brandHit = true;
      } else if (normItemName.includes(normSrcBrand)) {
        brandHit = true;
      }

      if (brandHit) {
        score += 50;
      } else {
        const genericBrands = new Set(['', 'nobrand', 'netbrenda', 'bezbrenda', 'rossiya', 'kitay', 'noname']);
        if (!normWbBrand || genericBrands.has(normWbBrand)) {
          score -= 15;
        } else {
          score -= 1000;
        }
      }
    }

    if (srcName) {
      const srcNameTokens = srcName.split(/\s+/).filter(w => w.length > 3);
      if (srcNameTokens.length > 0) {
        let nameHits = 0;
        for (const tok of srcNameTokens) {
          if (itemName.includes(tok)) nameHits++;
        }
        if (nameHits === 0) {
          score -= 20;
        } else {
          score += Math.min(nameHits, 4) * 10;
        }
      }
    }

    if (srcModel && srcModel.length > 1 && itemName.includes(srcModel)) {
      score += 20;
    }

    if (targetWV !== null) {
      const wbWVList = extractWeightsAndVolumes(item.name || '');

      if (wbWVList.length > 0) {
        let matchedWV = false;
        for (const wv of wbWVList) {
          const diff = Math.abs(wv.inBase - targetWV);
          if (diff <= Math.max(5, targetWV * 0.08)) {
            matchedWV = true;
            break;
          }
        }

        if (matchedWV) {
          score += 35;
        } else {
          score -= 1000;
        }
      } else {
        score -= 10;
      }
    }

    const packMatch = itemName.match(/(?:^|\D)(\d+)\s*(?:шт\.?|штук(?:а|и|ов)?)(?=\D|$)/i);
    const multiMatch = itemName.match(/(?:^|\D)(\d+)\s*[xх*×]\s*[\d.,]+/i);
    const wbPackQty = packMatch ? parseInt(packMatch[1], 10) : (multiMatch ? parseInt(multiMatch[1], 10) : null);

    if (srcQty !== null) {
      if (wbPackQty !== null) {
        if (wbPackQty === srcQty) {
          score += 30;
        } else {
          score -= 1000;
        }
      } else {
        if (srcQty > 1 && !itemName.includes(String(srcQty))) {
          score -= 1000;
        }
      }
    } else {
      if (wbPackQty !== null && wbPackQty > 1) {
        score -= 5;
      } else {
        score += 10;
      }
    }

    const wbNumbers = extractNumbers(item.name || '');
    const matchedIdx = new Set();
    for (const target of numericTargets) {
      for (let j = 0; j < wbNumbers.length; j++) {
        if (wbNumbers[j] === target && !matchedIdx.has(j)) {
          score += 10;
          matchedIdx.add(j);
          break;
        }
      }
    }

    const wbNameTrans = transliterate(item.name || '');
    const textSim = similarity(srcQueryTrans, wbNameTrans);
    score += textSim * 25;

    if (medianPrice > 0 && item.priceRub > 0) {
      if (item.priceRub < 0.25 * medianPrice || item.priceRub > 3.0 * medianPrice) {
        score -= 30;
      }
    }

    item.score = score;
  }

  const validItems = items.filter(i => i.score >= 10 && i.priceRub > 0);

  if (validItems.length === 0) {
    return { found: false, error: 'no_relevant' };
  }

  let maxScore = -Infinity;
  for (const i of validItems) {
    if (i.score > maxScore) maxScore = i.score;
  }

  const shortlist = validItems.filter(i => i.score >= maxScore - 15);
  shortlist.sort((a, b) => a.priceRub - b.priceRub);

  const bestOffer = shortlist[0];

  const ourPriceRaw = bestOffer.priceRub * CONFIG.DISCOUNT_MULTIPLIER;
  const ourPrice = Math.round(ourPriceRaw * 100) / 100;

  return {
    found: true,
    article: bestOffer.id,
    name: bestOffer.name,
    brand: bestOffer.brand,
    price: bestOffer.priceRub,
    oldPrice: bestOffer.oldPriceRub,
    rating: bestOffer.rating || 0,
    reviewsCount: bestOffer.feedbacks || 0,
    image: getWbImageUrl(bestOffer.id),
    url: `https://www.wildberries.ru/catalog/${bestOffer.id}/detail.aspx`,
    ourPrice: ourPrice
  };
}

export async function getWbPriceByArticle(article) {
  const endpoints = [
    `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=${CONFIG.WB_GEO_DEST}&nm=${article}`,
    `https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=${CONFIG.WB_GEO_DEST}&nm=${article}`
  ];

  for (const url of endpoints) {
    const result = await fetchWbJson(url);
    if (result && result.data && result.data.products && result.data.products[0]) {
      const product = result.data.products[0];
      const price = extractPrice(product);
      const oldPrice = extractOldPrice(product);
      const rating = product.reviewRating || 0;
      const reviewsCount = product.feedbacks || 0;
      if (price === 0) continue;
      return { price, oldPrice, rating, reviewsCount };
    }
  }

  return null;
}

async function fetchWbJson(url) {
  for (let attempt = 0; attempt < CONFIG.WB_RETRY_ATTEMPTS; attempt++) {
    try {
      await wbThrottle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.WB_TIMEOUT_MS);

      const headers = {
        'Accept': '*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Origin': 'https://www.wildberries.ru',
        'Referer': 'https://www.wildberries.ru/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
      };

      const fetchOptions = { signal: controller.signal, headers };

      if (CONFIG.WB_PROXY_URL) {
        fetchOptions.agent = new HttpsProxyAgent(CONFIG.WB_PROXY_URL);
      }

      const fetchMethod = CONFIG.WB_PROXY_URL ? nodeFetch : globalThis.fetch;
      const res = await fetchMethod(url, fetchOptions);
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        if (attempt < CONFIG.WB_RETRY_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        return null;
      }

      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (attempt < CONFIG.WB_RETRY_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function executeWbSearch(query) {
  const cleanQuery = query.replace(/[^\w\sа-яА-ЯёЁ]/gi, ' ').replace(/\s+/g, ' ').trim();
  const encodedQuery = encodeURIComponent(cleanQuery || query);
  const endpoints = [
    `https://search.wb.ru/exactmatch/ru/common/v18/search?ab_testing=false&appType=1&curr=rub&dest=${CONFIG.WB_GEO_DEST}&lang=ru&page=1&query=${encodedQuery}&resultset=catalog&sort=popular&suppressSpellcheck=false`,
    `https://u-search.wb.ru/exactmatch/ru/common/v18/search?ab_testing=false&appType=1&curr=rub&dest=${CONFIG.WB_GEO_DEST}&lang=ru&page=1&query=${encodedQuery}&resultset=catalog&sort=popular&suppressSpellcheck=false`,
    `https://search.wb.ru/exactmatch/ru/common/v13/search?ab_testing=false&appType=1&curr=rub&dest=${CONFIG.WB_GEO_DEST}&hide_dtype=13&lang=ru&page=1&query=${encodedQuery}&resultset=catalog&sort=popular&suppressSpellcheck=false`,
    `https://search.wb.ru/exactmatch/ru/common/v4/search?appType=1&curr=rub&dest=${CONFIG.WB_GEO_DEST}&page=1&query=${encodedQuery}&resultset=catalog&sort=popular&suppressSpellcheck=false`
  ];

  for (const url of endpoints) {
    const result = await fetchWbSearch(url);
    if (result && Array.isArray(result.data) && result.data.length > 0) {
      return result;
    }
  }

  return { data: [] };
}

async function fetchWbSearch(url) {
  for (let attempt = 0; attempt < CONFIG.WB_RETRY_ATTEMPTS; attempt++) {
    try {
      await wbThrottle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.WB_TIMEOUT_MS);

      const headers = {
        'Accept': '*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Origin': 'https://www.wildberries.ru',
        'Referer': 'https://www.wildberries.ru/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site'
      };

      const fetchOptions = { signal: controller.signal, headers };

      if (CONFIG.WB_PROXY_URL) {
        fetchOptions.agent = new HttpsProxyAgent(CONFIG.WB_PROXY_URL);
      }

      const fetchMethod = CONFIG.WB_PROXY_URL ? nodeFetch : globalThis.fetch;
      const res = await fetchMethod(url, fetchOptions);
      clearTimeout(timer);

      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        if (attempt < CONFIG.WB_RETRY_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        return { data: [] };
      }

      if (!res.ok) return { data: [] };

      const json = await res.json();
      const products = json && json.data ? json.data.products : (json ? json.products : null);
      return { data: Array.isArray(products) ? products : [] };
    } catch (e) {
      if (attempt < CONFIG.WB_RETRY_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return { data: [] };
    }
  }
  return { data: [] };
}

function extractPrice(item) {
  if (item.salePriceU && typeof item.salePriceU === 'number') return item.salePriceU / 100;
  if (item.priceU && typeof item.priceU === 'number') return item.priceU / 100;
  if (item.sizes && Array.isArray(item.sizes) && item.sizes.length > 0) {
    const sz = item.sizes[0];
    if (sz.price && sz.price.total) return sz.price.total / 100;
    if (sz.price && sz.price.product) return sz.price.product / 100;
  }
  return 0;
}

function extractOldPrice(item) {
  if (item.priceU && typeof item.priceU === 'number') return item.priceU / 100;
  if (item.sizes && Array.isArray(item.sizes) && item.sizes.length > 0) {
    const sz = item.sizes[0];
    if (sz.price && sz.price.basic) return sz.price.basic / 100;
  }
  return null;
}

function getWbImageUrl(idNum) {
  const id = parseInt(idNum, 10);
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  let basket = '01';
  if (vol <= 143) basket = '01';
  else if (vol <= 287) basket = '02';
  else if (vol <= 431) basket = '03';
  else if (vol <= 719) basket = '04';
  else if (vol <= 1007) basket = '05';
  else if (vol <= 1061) basket = '06';
  else if (vol <= 1115) basket = '07';
  else if (vol <= 1169) basket = '08';
  else if (vol <= 1313) basket = '09';
  else if (vol <= 1601) basket = '10';
  else if (vol <= 1655) basket = '11';
  else if (vol <= 1919) basket = '12';
  else if (vol <= 2045) basket = '13';
  else if (vol <= 2189) basket = '14';
  else if (vol <= 2405) basket = '15';
  else if (vol <= 2621) basket = '16';
  else if (vol <= 2837) basket = '17';
  else if (vol <= 3053) basket = '18';
  else if (vol <= 3269) basket = '19';
  else if (vol <= 3485) basket = '20';
  else if (vol <= 3701) basket = '21';
  else if (vol <= 3917) basket = '22';
  else {
    const extra = Math.min(30, 23 + Math.floor((vol - 3918) / 216));
    basket = String(extra).padStart(2, '0');
  }
  return `https://basket-${basket}.wbbasket.ru/vol${vol}/part${part}/${id}/images/c516x688/1.webp`;
}
