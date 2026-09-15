import { CONFIG } from './config.js';

const GPT_SYSTEM_PROMPT = `Ты — парсер товаров по штрихкоду. На вход получаешь сырые результаты поисковой выдачи Яндекса, часто с оптовых сайтов.
Определи, что это за товар, и верни СТРОГО один JSON без markdown, без пояснений, без текста до и после.

Формат ответа: { "found": true|false, "brand": "строка или null", "name": "чистое потребительское название (например 'Чипсы Lay's с солью')", "model": "строка или null", "category": "строка или null", "weight": "число в граммах или null", "volume": "число в миллилитрах или null", "quantity": "число штук в упаковке или null", "unit": "шт|г|мл|кг|л или null", "wb_query": "короткий запрос для маркетплейса: бренд + модель + вкус/тип", "confidence": число от 0 до 1 }

ЖЁСТКИЕ ПРАВИЛА:
1. name — название товара так, как оно написано на ценнике в супермаркете для обычного покупателя.
2. Убери из name и wb_query всё, что относится к опту и упаковке: сведения о смотках, спайках, коробах, блоках, шоубоксах, паллетах, наборах, опте, количестве штук в упаковке. Эти слова не должны остаться в ответе.
3. Убери маркетинговые прилагательные размера и статуса (большая, маленькая, гигантская, огромная, мега, супер, акция), если они не являются частью официального названия бренда или вкуса.
4. Сохрани всё, что относится к самому товару: бренд, вкус, тип, модель, назначение, вес, объём.
5. НИКОГДА не выдумывай вес, объем или количество. Если точной цифры в тексте нет — возвращай null.
6. Если в сниппетах упоминаются разные варианты одного бренда, выбирай тот, который встречается чаще.
7. Если товар невозможно определить — верни {"found": false}.`;

export async function searchAllDatabases(barcode) {
  if (!CONFIG.YANDEX_SEARCH_API_KEY || !CONFIG.YANDEX_GPT_API_KEY || !CONFIG.YANDEX_FOLDER_ID) {
    return { productData: null, hasUpstreamSuccess: false };
  }

  const snippets = await searchYandex(barcode);
  if (!Array.isArray(snippets) || snippets.length === 0) {
    return { productData: null, hasUpstreamSuccess: false };
  }

  const extracted = await extractProductWithGpt(barcode, snippets);

  if (!extracted) {
    return { productData: null, hasUpstreamSuccess: false };
  }

  if (extracted.found !== true) {
    return { productData: null, hasUpstreamSuccess: true };
  }

  const name = cleanString(extracted.name);
  const wbQuery = cleanString(extracted.wb_query);

  if (!name && !wbQuery) {
    return { productData: null, hasUpstreamSuccess: true };
  }

  const productData = {
    found: true,
    barcode,
    brand: cleanString(extracted.brand),
    name: name || wbQuery,
    model: cleanString(extracted.model),
    category: cleanString(extracted.category),
    weight: cleanNumber(extracted.weight),
    volume: cleanNumber(extracted.volume),
    quantity: cleanNumber(extracted.quantity),
    unit: cleanString(extracted.unit),
    wb_query: wbQuery || '',
    confidence: typeof extracted.confidence === 'number' && Number.isFinite(extracted.confidence) ? extracted.confidence : 0,
    image: null
  };

  return { productData, hasUpstreamSuccess: true };
}

async function searchYandex(barcode) {
  const queries = [
    `site:ean13.info ${barcode}`,
    `site:barcode-list.ru ${barcode}`,
    `site:goodsmatrix.ru ${barcode}`,
    `site:olegon.ru ${barcode}`,
    `${barcode}`
  ];

  const allSnippets = [];
  const seenUrls = new Set();

  for (const queryText of queries) {
    const batch = await runYandexQuery(queryText);
    for (const s of batch) {
      const key = (s.url || '') + '|' + (s.title || '');
      if (!seenUrls.has(key)) {
        seenUrls.add(key);
        allSnippets.push(s);
      }
    }
    if (allSnippets.length >= 12) break;
  }

  return allSnippets.slice(0, 12);
}

async function runYandexQuery(queryText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.YANDEX_TIMEOUT_MS);
  try {
    const body = {
      query: {
        searchType: 'SEARCH_TYPE_RU',
        queryText,
        familyMode: 'FAMILY_MODE_MODERATE',
        page: '0'
      },
      groupSpec: {
        groupsOnPage: '10',
        docsInGroup: '1'
      },
      maxPassages: '3',
      region: '225',
      l10n: 'LOCALIZATION_RU'
    };

    const res = await fetch('https://searchapi.api.cloud.yandex.net/v2/web/search', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Api-Key ${CONFIG.YANDEX_SEARCH_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    clearTimeout(timer);

    if (!res.ok) return [];

    const json = await res.json();

    if (Array.isArray(json.documents) && json.documents.length > 0) {
      return json.documents.slice(0, 10).map(d => {
        const title = d.title || '';
        const url = d.url || '';
        let snippet = '';
        if (Array.isArray(d.passages) && d.passages.length > 0) {
          snippet = d.passages.join(' ');
        } else if (d.snippet) {
          snippet = d.snippet;
        } else if (d.description) {
          snippet = d.description;
        }
        return { title, snippet, url };
      }).filter(s => s.title || s.snippet);
    }

    if (typeof json.rawData === 'string' && json.rawData.length > 0) {
      let xml = '';
      try {
        xml = Buffer.from(json.rawData, 'base64').toString('utf-8');
      } catch (e) {
        return [];
      }
      return parseYandexXml(xml);
    }

    return [];
  } catch (e) {
    clearTimeout(timer);
    return [];
  }
}

function parseYandexXml(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const snippets = [];
  const docRegex = /<doc\b[^>]*>([\s\S]*?)<\/doc>/gi;
  let m;
  while ((m = docRegex.exec(xml)) !== null) {
    if (snippets.length >= 10) break;
    const docXml = m[1];
    const title = extractTag(docXml, 'title');
    const url = extractTag(docXml, 'url');
    const passage = extractFirstTag(docXml, 'passage');
    if (title || passage) {
      snippets.push({ title, snippet: passage, url });
    }
  }
  if (snippets.length === 0) {
    const titles = extractAllTags(xml, 'title');
    const urls = extractAllTags(xml, 'url');
    const passages = extractAllTags(xml, 'passage');
    const total = Math.min(10, Math.max(titles.length, passages.length));
    for (let i = 0; i < total; i++) {
      const title = titles[i] || '';
      const snippet = passages[i] || '';
      const url = urls[i] || '';
      if (title || snippet) snippets.push({ title, snippet, url });
    }
  }
  return snippets;
}

function extractTag(xml, tag) {
  if (!xml) return '';
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? cleanXmlText(m[1]) : '';
}

function extractFirstTag(xml, tag) {
  return extractTag(xml, tag);
}

function extractAllTags(xml, tag) {
  if (!xml) return [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push(cleanXmlText(m[1]));
  }
  return out;
}

function cleanXmlText(input) {
  if (!input) return '';
  let t = String(input);
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&lt;/g, '<');
  t = t.replace(/&gt;/g, '>');
  t = t.replace(/&quot;/g, '"');
  t = t.replace(/&apos;/g, "'");
  t = t.replace(/&#39;/g, "'");
  t = t.replace(/&nbsp;/g, ' ');
  t = t.replace(/&amp;/g, '&');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

async function extractProductWithGpt(barcode, snippets) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.GPT_TIMEOUT_MS);
  try {
    const userText = buildUserPrompt(barcode, snippets);
    const res = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Api-Key ${CONFIG.YANDEX_GPT_API_KEY}`
      },
      body: JSON.stringify({
        modelUri: `gpt://${CONFIG.YANDEX_FOLDER_ID}/yandexgpt/latest`,
        completionOptions: {
          stream: false,
          temperature: 0.1,
          maxTokens: 800
        },
        messages: [
          { role: 'system', text: GPT_SYSTEM_PROMPT },
          { role: 'user', text: userText }
        ]
      })
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const json = await res.json();
    const text = json && json.result && json.result.alternatives && json.result.alternatives[0]
      && json.result.alternatives[0].message
      ? json.result.alternatives[0].message.text
      : '';
    if (!text) return null;
    return parseGptJson(text);
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

function buildUserPrompt(barcode, snippets) {
  const lines = [`Штрихкод: ${barcode}`, '', 'Результаты поиска:'];
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i] || {};
    lines.push(`${i + 1}. ${s.title || ''}`);
    lines.push(`${s.snippet || ''}`);
    lines.push(`URL: ${s.url || ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

function parseGptJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '');
  t = t.replace(/\s*```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = t.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'null') return null;
  if (trimmed.toLowerCase() === 'undefined') return null;
  return trimmed;
}

function cleanNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}
