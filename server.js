'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

/* ============================================================================
   1. CONFIGURATION (تنظیم از Environment Variables در پنل Render)
   ============================================================================ */
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || '').trim().replace(/^["']|["']$/g, '');
const ENABLE_SEARCH_GROUNDING = process.env.ENABLE_SEARCH_GROUNDING !== 'false';
const APP_SECRET_TOKEN = String(process.env.APP_SECRET_TOKEN || '').trim().replace(/^["']|["']$/g, '');

const STATIC_CANDIDATE_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash'
];

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const BLACKLIST_FILE = path.join(DATA_DIR, 'blacklist.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* ============================================================================
   2. MIDDLEWARES (CORS + JSON 15MB + STATIC + RATE LIMITER)
   ============================================================================ */
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

app.use(express.json({ limit: '15mb' }));

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

function resolveFrontendFile(filename) {
  const allowed = new Set(['index.html', 'manifest.json', 'sw.js']);
  if (!allowed.has(filename)) return null;
  const inPublic = path.join(PUBLIC_DIR, filename);
  if (fs.existsSync(inPublic)) return inPublic;
  const inRoot = path.join(__dirname, filename);
  if (fs.existsSync(inRoot)) return inRoot;
  return null;
}

const rateMap = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_REQ = 45;

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateMap.entries()) {
    if (now - rec.start > RATE_WINDOW_MS) {
      rateMap.delete(ip);
    }
  }
}, RATE_WINDOW_MS).unref();

function rateLimiter(req, res, next) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  const now = Date.now();
  const record = rateMap.get(ip) || { count: 0, start: now };

  if (now - record.start > RATE_WINDOW_MS) {
    record.count = 1;
    record.start = now;
  } else {
    record.count += 1;
  }
  rateMap.set(ip, record);

  if (record.count > RATE_MAX_REQ) {
    return res.status(429).json({
      error: 'تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً دقایقی دیگر تلاش کنید.'
    });
  }
  next();
}

function verifyToken(req, res, next) {
  if (!APP_SECRET_TOKEN) return next();
  const headerAuth = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const provided =
    (req.body && req.body.authToken) ||
    (req.body && req.body.token) ||
    (req.query && req.query.token) ||
    req.headers['x-api-key'] ||
    headerAuth;

  if (provided !== APP_SECRET_TOKEN) {
    return res.status(401).json({ error: 'توکن احراز هویت سرور نامعتبر است.' });
  }
  next();
}

/* ============================================================================
   3. HELPERS, DATE ANCHOR & BLACKLIST STORAGE
   ============================================================================ */
const PLATFORM_NAMES = {
  divar: 'دیوار',
  instagram: 'اینستاگرام',
  bama: 'خودرو/باما',
  sheypoor: 'شیپور',
  telegram: 'تلگرام/سایر'
};

const CATEGORY_NAMES = {
  mobile: 'موبایل و دیجیتال',
  car: 'خودرو و موتورسیکلت',
  home: 'لوازم خانگی',
  shop: 'پوشاک و آنلاین‌شاپ',
  other: 'سایر کالاها'
};

function getTodayDates() {
  const now = new Date();
  let faDate = '';
  let faYear = '';
  try {
    faDate = new Intl.DateTimeFormat('fa-IR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(now);
    faYear = new Intl.DateTimeFormat('fa-IR', { year: 'numeric' }).format(now);
  } catch (_) {
    faDate = now.toISOString().slice(0, 10);
    faYear = String(now.getFullYear());
  }
  const enDate = now.toISOString().slice(0, 10);
  return { faDate, faYear, enDate };
}

function toEnDigits(str) {
  return String(str || '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function normalizeSellerId(str) {
  return toEnDigits(str)
    .trim()
    .toLowerCase()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک');
}

function readBlacklist() {
  try {
    if (!fs.existsSync(BLACKLIST_FILE)) return {};
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeBlacklist(db) {
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Blacklist write warning:', err.message);
  }
}

function extractJsonSafe(raw) {
  if (raw && typeof raw === 'object') return raw;
  let cleaned = String(raw || '').trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) {
    cleaned = fence[1].trim();
  } else {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }
  }
  return JSON.parse(cleaned);
}

function formatReadableError(err) {
  const msg = String(err?.message || err || '');
  if (err?.name === 'AbortError') {
    return 'پاسخ‌دهی هوش مصنوعی بیش از حد طول کشید (Timeout) — دوباره تلاش کنید';
  }
  if (msg.includes('API_KEY_INVALID') || msg.includes('API key not valid')) {
    return 'کلید GEMINI_API_KEY در Render نامعتبر است';
  }
  if (msg.includes('GEMINI_HTTP_403') || msg.includes('User location is not supported')) {
    return 'دسترسی کلید API یا منطقه سرور Render توسط گوگل محدود شده است (403)';
  }
  if (msg.includes('GEMINI_HTTP_429') || msg.includes('RESOURCE_EXHAUSTED')) {
    return 'سهمیه رایگان کلید Gemini موقتاً پر شده است؛ ۱ دقیقه دیگر تست کنید (429)';
  }
  if (msg.includes('GEMINI_HTTP_404')) {
    return 'مدل انتخاب‌شده در API گوگل یافت نشد (404) — آدرس /api/models را بررسی کنید';
  }
  if (msg.includes('GEMINI_HTTP_400')) {
    return `درخواست نامعتبر به جمینی (400): ${msg.slice(0, 120)}`;
  }
  return `خطا در ارتباط با هوش مصنوعی: ${msg.slice(0, 130)}`;
}

/* ============================================================================
   4. LIVE MODEL DISCOVERY + 2-STEP LIVE SEARCH & JSON ENGINE
   ============================================================================ */
let cachedDiscoveredModels = [];
let lastDiscoveryTime = 0;
let lastWorkingModel = GEMINI_MODEL || '';
const DISCOVERY_TTL_MS = 30 * 60 * 1000;

function scoreModelPriority(id) {
  const m = id.toLowerCase();
  if (/(embedding|tts|imagen|veo|aqa|bison|gecko|whisper|audio|robotics|computer-use)/i.test(m)) {
    return -100;
  }
  let score = 10;
  if (m.includes('gemini')) score += 50;
  if (m.includes('flash')) score += 30;
  if (m.includes('hydrogen')) score += 25;
  if (m.includes('lite')) score += 10;
  if (m.includes('gemma')) score += 5;
  if (m.includes('pro')) score += 8;
  const verMatch = m.match(/gemini-(\d+(?:\.\d+)?)/);
  if (verMatch) {
    score += parseFloat(verMatch[1]) * 10;
  }
  if (m.includes('exp') || m.includes('preview')) score -= 2;
  return score;
}

async function fetchLiveAvailableModels(forceRefresh = false) {
  if (!GEMINI_API_KEY) throw new Error('MISSING_API_KEY');
  const now = Date.now();
  if (!forceRefresh && cachedDiscoveredModels.length > 0 && (now - lastDiscoveryTime < DISCOVERY_TTL_MS)) {
    return cachedDiscoveredModels;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}&pageSize=100`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const e = new Error(`GEMINI_HTTP_${res.status}: ${errBody.slice(0, 220)}`);
      e.httpStatus = res.status;
      throw e;
    }

    const data = await res.json();
    const models = (data.models || [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((id) => id && scoreModelPriority(id) > 0)
      .sort((a, b) => scoreModelPriority(b) - scoreModelPriority(a));

    cachedDiscoveredModels = models;
    lastDiscoveryTime = now;
    return models;
  } finally {
    clearTimeout(timeout);
  }
}

async function getOrderedModels() {
  let liveModels = [];
  try {
    liveModels = await fetchLiveAvailableModels(false);
  } catch (err) {
    console.warn('Live model discovery warning:', err.message);
    if (err.httpStatus === 403 || String(err.message).includes('API_KEY_INVALID')) {
      throw err;
    }
  }

  return Array.from(new Set([
    ...(lastWorkingModel ? [lastWorkingModel] : []),
    ...(GEMINI_MODEL ? [GEMINI_MODEL] : []),
    ...liveModels,
    ...STATIC_CANDIDATE_MODELS
  ])).slice(0, 7);
}

async function invokeGeminiRaw(modelName, promptText, base64Images, { useSearch = false, expectJson = true, timeoutMs = 42000 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const parts = [{ text: promptText }];
  if (Array.isArray(base64Images)) {
    for (const img of base64Images.slice(0, 4)) {
      if (typeof img === 'string' && img.length > 50) {
        const clean = img.includes(',') ? img.split(',')[1] : img;
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: clean } });
      }
    }
  }

  const isGemma = /^gemma/i.test(modelName);
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: useSearch ? 0.1 : 0.2 }
  };

  if (useSearch && !isGemma) {
    body.tools = [{ google_search: {} }];
  } else if (expectJson && !isGemma) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const e = new Error(`GEMINI_HTTP_${res.status}: ${errBody.slice(0, 220)}`);
      e.httpStatus = res.status;
      throw e;
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
      const blockReason = data.promptFeedback?.blockReason || 'EMPTY_CANDIDATE';
      throw new Error(`NO_CANDIDATE:${blockReason}`);
    }

    const textOut = (candidate.content?.parts || [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim();

    if (!textOut) {
      throw new Error('EMPTY_TEXT_RESPONSE');
    }

    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const searchQueries = candidate?.groundingMetadata?.webSearchQueries || [];
    const sources = [];
    for (const ch of chunks) {
      if (ch.web && ch.web.uri && /^https?:\/\//i.test(ch.web.uri)) {
        if (!sources.some((s) => s.uri === ch.web.uri)) {
          sources.push({
            title: String(ch.web.title || ch.web.uri).slice(0, 65),
            uri: ch.web.uri
          });
        }
      }
    }

    lastWorkingModel = modelName;
    return { textOut, sources, searchQueries, usedModel: modelName };
  } finally {
    clearTimeout(timeout);
  }
}

/* گام ۱ اختصاصی: جستجوی زنده قیمت روز بازار ایران در گوگل (متن آزاد بدون شکست JSON) */
async function runLiveMarketResearch(p, orderedModels) {
  if (!ENABLE_SEARCH_GROUNDING) {
    return { searchSucceeded: false, researchText: '', sources: [], reason: 'DISABLED_IN_ENV' };
  }

  const { faDate, faYear, enDate } = getTodayDates();
  const catHint = {
    mobile: 'ترب (torob.com)، ایمالز، دیجی‌کالا، موبایل.آی‌آر و دیوار',
    car: 'باما (bama.ir)، همراه مکانیک، دیوار خودرو و کارنامه',
    home: 'ترب (torob.com)، ایمالز، دیجی‌کالا و دیوار',
    shop: 'ترب، دیجی‌کالا و اینستاگرام',
    other: 'ترب (torob.com)، دیجی‌کالا و دیوار'
  }[p.category] || 'ترب، دیجی‌کالا و دیوار';

  const researchPrompt = `تاریخ دقیق امروز: ${faDate} (میلادی: ${enDate}).
حتماً از ابزار Google Search استفاده کن و قیمت **به‌روز امروز (سال ${faYear})** در بازار ایران را پیدا کن.

اطلاعات آگهی کاربر:
- پلتفرم: ${PLATFORM_NAMES[p.platform] || p.platform}
- دسته‌بندی: ${CATEGORY_NAMES[p.category] || p.category}
- شناسه فروشنده: ${p.sellerId || 'نامشخص'}
- قیمت پیشنهادی فروشنده: ${p.price || 'نامشخص'} تومان
- متن آگهی / لینک: ${p.rawText || '(از روی تصویر ضمیمه نام دقیق کالا را تشخیص بده)'}

لطفاً حتماً در گوگل جستجو کن و در یک گزارش کوتاه و دقیق (حداکثر ۶ خط فارسی) بنویس:
1. نام دقیق کالا و مدل/ظرفیت آن چیست؟
2. قیمت آکبند (نو) امروز آن در سایت‌های ایرانی (${catHint}) در بازه چند تومان است؟ (بازه دقیق به تومان و تاریخ منبع)
3. قیمت عرف کارکرده/دست‌دوم سالم آن امروز در بازار ایران چقدر است؟
4. آیا برای شناسه فروشنده (${p.sellerId || 'نامشخص'}) گزارش کلاهبرداری یا شکایتی در وب پیدا شد؟

مهم: به هیچ وجه قیمت‌های قدیمی سال‌های قبل را از حافظه نگو؛ فقط عددی را گزارش بده که همین الان در نتایج جستجوی زنده گوگل می‌بینی.`;

  // اگر متن آگهی خیلی کوتاه است، تا ۲ تصویر را برای تشخیص نام کالا بفرست
  const researchImages = (String(p.rawText || '').trim().length < 20 && Array.isArray(p.images))
    ? p.images.slice(0, 2)
    : [];

  const searchModels = orderedModels.filter((m) => !/^gemma/i.test(m)).slice(0, 3);

  for (const model of searchModels) {
    try {
      const res = await invokeGeminiRaw(model, researchPrompt, researchImages, {
        useSearch: true,
        expectJson: false,
        timeoutMs: 24000
      });
      const actuallySearched = res.sources.length > 0 || res.searchQueries.length > 0;
      if (actuallySearched) {
        return {
          searchSucceeded: true,
          researchText: res.textOut,
          sources: res.sources,
          searchModel: res.usedModel
        };
      }
      console.warn(`Model ${model} answered without triggering Google Search.`);
    } catch (err) {
      console.warn(`Live search step failed on ${model}:`, err.message);
      if (err.httpStatus === 403 || String(err.message).includes('API_KEY_INVALID')) {
        throw err;
      }
    }
  }

  return { searchSucceeded: false, researchText: '', sources: [], reason: 'SEARCH_UNAVAILABLE' };
}

/* گام ۲ اختصاصی: تحلیل نهایی و صدور JSON دقیق با استناد به قیمت زنده */
async function callGeminiJson(promptText, base64Images = [], orderedModelsOverride = null) {
  if (!GEMINI_API_KEY) {
    throw new Error('MISSING_API_KEY');
  }
  const orderedModels = orderedModelsOverride || await getOrderedModels();
  let lastErr = null;

  for (const model of orderedModels) {
    try {
      const res = await invokeGeminiRaw(model, promptText, base64Images, {
        useSearch: false,
        expectJson: true,
        timeoutMs: 42000
      });
      const parsed = extractJsonSafe(res.textOut);
      return { parsed, usedModel: res.usedModel };
    } catch (err) {
      console.warn(`JSON analysis failed on ${model}:`, err.message);
      lastErr = err;
      if (err.httpStatus === 403 || String(err.message).includes('API_KEY_INVALID')) {
        throw err;
      }
    }
  }

  throw lastErr || new Error('ALL_MODELS_FAILED');
}

/* ============================================================================
   5. PROMPTS (ANCHORED TO TODAY'S DATE + ANTI-STALE-PRICE GUARD)
   ============================================================================ */
function buildAnalyzePrompt(p, blacklistRecord, liveResearch) {
  const { faDate, enDate } = getTodayDates();

  const blNote = blacklistRecord
    ? `هشدار بسیار مهم از دیتابیس لیست سیاه سرور: برای این شناسه قبلاً ${blacklistRecord.reports} گزارش کلاهبرداری ثبت شده است (دلیل: ${blacklistRecord.reason}). این موضوع باید شاخص ریسک را شدیداً بالا ببرد.`
    : 'سابقه‌ای در لیست سیاه سرور ثبت نشده است.';

  const marketSection = liveResearch.searchSucceeded
    ? `گزارش جستجوی زنده گوگل برای تاریخ امروز (${faDate} / ${enDate}):
"""
${liveResearch.researchText}
"""
قانون الزامی قیمت‌گذاری:
- برای مقایسه قیمت پیشنهادی فروشنده، **فقط و فقط** به اعداد موجود در گزارش جستجوی زنده بالا استناد کن و هرگز قیمت‌های قدیمی حافظه خودت را جایگزین نکن.
- در خلاصه کارشناسی (summary) دقیقاً بازه قیمت امروز بازار را با قیمت فروشنده مقایسه کن.`
    : `توجه مهم درباره قیمت روز (${faDate}):
- اتصال به جستجوی زنده قیمت در این درخواست برقرار نشد.
- **قانون اکید:** به هیچ وجه قیمت قدیمی و منقضی از حافظه آموزشی خودت (سال‌های گذشته) به‌عنوان «قیمت روز بازار» اعلام نکن. در عوض به کاربر تذکر بده که قیمت پیشنهادی فروشنده را حتماً همین الان با سایت‌های ترب، ایمالز یا باما چک کند و تحلیل را روی نشانه‌های کلاهبرداری، تصاویر و لحن فروشنده متمرکز کن.`;

  return `تو کارشناس ارشد ضدکلاهبرداری و معاملات دست‌دوم بازار ایران هستی (دیوار، شیپور، اینستاگرام، باما، تلگرام).
تاریخ امروز: ${faDate} (${enDate}).

اطلاعات پرونده:
- پلتفرم: ${PLATFORM_NAMES[p.platform] || p.platform}
- دسته‌بندی: ${CATEGORY_NAMES[p.category] || p.category}
- شناسه فروشنده: ${p.sellerId || 'نامشخص'}
- وضعیت لیست سیاه مشترک: ${blNote}
- قیمت پیشنهادی فروشنده: ${p.price || 'نامشخص'} تومان
- نشانه‌های مشکوک انتخاب‌شده: ${Array.isArray(p.quickFlags) && p.quickFlags.length ? p.quickFlags.join(' | ') : 'ندارد'}
- متن آگهی / لینک / چت: ${p.rawText || 'ثبت نشده'}

${marketSection}

وظایف تو:
1. قیمت فروشنده را مطابق قوانین بالا ارزیابی کن و اگر قیمت به‌طرز مشکوکی زیر کف واقعی امروز است، به‌عنوان تله کلاهبرداری یا تعمیری بودن هشدار بده.
2. تصاویر ضمیمه‌شده (عکس کالا، پروفایل، تاریخچه تغییر نام پیج یا اسکرین‌شات چت) را با دقت بررسی کن.
3. خروجی را فقط و فقط به صورت یک آبجکت JSON معتبر فارسی برگردان (بدون هیچ توضیح اضافه بیرون از JSON):
{
  "risk_score": عدد صحیح 0 تا 100 (عدد بالاتر = خطر بیشتر),
  "verdict": "حکم کوتاه و صریح کارشناسی",
  "summary": "تحلیل شفاف در ۲ تا ۳ جمله (شامل مقایسه دقیق قیمت امروز در صورت وجود گزارش زنده)",
  "scores": { "seller": 0-100, "visual": 0-100, "price": 0-100, "text": 0-100 },
  "red_flags": ["فهرست هشدارها و نکات مشکوک"],
  "green_flags": ["فهرست نکات مثبت و اطمینان‌بخش"],
  "verification_message": "پیام دقیق و مودبانه مچ‌گیری برای ارسال به فروشنده در چت",
  "checklist": ["چک‌لیست عملی بررسی حضوری و قبل از واریز وجه"]
}`;
}

function buildFollowupPrompt(p) {
  const { faDate } = getTodayDates();
  return `تو کارآگاه و کارشناس ضدکلاهبرداری معاملات دست‌دوم بازار ایران هستی. تاریخ امروز: ${faDate}.
اطلاعات پرونده قبلی:
- پلتفرم: ${PLATFORM_NAMES[p.platform] || p.platform} | فروشنده: ${p.sellerId || 'نامشخص'}
- شاخص ریسک قبلی: ${p.previousRisk ?? 50}%
پاسخ جدید فروشنده (و تصویر ضمیمه در صورت وجود):
"${p.sellerReply || '(تصویر جدید ارسال شده است)'}"

بررسی کن آیا فروشنده در حال طفره‌رفتن، بهانه‌تراشی برای گرفتن بیعانه یا ارسال مدارک جعلی است یا پاسخ منطقی داده است.
فقط و فقط JSON معتبر فارسی برگردان:
{
  "updated_risk_score": عدد صحیح 0 تا 100,
  "analysis": "تحلیل دقیق پاسخ جدید فروشنده در ۲ تا ۳ جمله",
  "next_reply": "دقیق‌ترین پیام پیشنهادی بعدی برای ارسال به فروشنده"
}`;
}

/* ============================================================================
   6. API ROUTES
   ============================================================================ */
app.get('/healthz', (req, res) => {
  const { faDate } = getTodayDates();
  res.json({
    ok: true,
    service: 'separ-kharid-pro-server',
    version: '4.0-live-price-pipeline',
    todayFa: faDate,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    model: lastWorkingModel || GEMINI_MODEL || 'auto',
    searchGrounding: ENABLE_SEARCH_GROUNDING,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/api/models', verifyToken, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY تنظیم نشده است.' });
  }
  try {
    const models = await fetchLiveAvailableModels(true);
    return res.json({
      ok: true,
      count: models.length,
      recommended: models[0] || null,
      models
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      readableError: formatReadableError(err),
      rawError: err.message
    });
  }
});

// تست کامل هم اتصال مدل و هم کارکرد واقعی Google Search Grounding
app.get('/api/test-gemini', verifyToken, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY تنظیم نشده است.' });
  }
  try {
    const orderedModels = await getOrderedModels();
    const jsonResult = await callGeminiJson('فقط این JSON را برگردان: {"status":"ok"}', [], orderedModels);

    let searchOk = false;
    let searchSourcesCount = 0;
    let searchNote = ENABLE_SEARCH_GROUNDING ? 'در حال بررسی' : 'غیرفعال در Environment Variables';

    if (ENABLE_SEARCH_GROUNDING) {
      try {
        const { faDate } = getTodayDates();
        const sRes = await invokeGeminiRaw(jsonResult.usedModel, `تاریخ امروز ${faDate} است. با Google Search قیمت امروز یک گوشی پرچمدار سامسونگ در ایران (تومان) را در یک خط بگو.`, [], {
          useSearch: true,
          expectJson: false,
          timeoutMs: 20000
        });
        searchSourcesCount = sRes.sources.length;
        searchOk = sRes.sources.length > 0 || sRes.searchQueries.length > 0;
        searchNote = searchOk ? 'جستجوی زنده گوگل فعال است' : 'مدل بدون اجرای سرچ پاسخ داد';
      } catch (sErr) {
        searchNote = `خطای سرچ زنده: ${sErr.message.slice(0, 100)}`;
      }
    }

    return res.json({
      ok: true,
      usedModel: `${jsonResult.usedModel}${searchOk ? ' • 🌐 سرچ زنده فعال' : ' • ⚠️ سرچ غیرفعال'}`,
      searchOk,
      searchSourcesCount,
      searchNote,
      response: jsonResult.parsed
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      readableError: formatReadableError(err),
      rawError: err.message
    });
  }
});

app.post(['/api/analyze', '/webhook/analyze'], rateLimiter, verifyToken, async (req, res) => {
  try {
    const body = req.body || {};

    if (body.test === true) {
      return res.json({
        ok: true,
        message: 'اتصال به سرور Node.js برقرار است',
        geminiConfigured: Boolean(GEMINI_API_KEY),
        model: lastWorkingModel || GEMINI_MODEL || 'auto'
      });
    }

    const orderedModels = await getOrderedModels();

    if (body.action === 'followup') {
      const prompt = buildFollowupPrompt(body);
      const { parsed, usedModel } = await callGeminiJson(prompt, body.images || [], orderedModels);
      return res.json({
        updated_risk_score: Math.max(0, Math.min(100, Number(parsed.updated_risk_score) || 50)),
        analysis: String(parsed.analysis || 'پاسخ فروشنده تحلیل شد.'),
        next_reply: String(parsed.next_reply || ''),
        usedModel
      });
    }

    // کارشناسی ۲ مرحله‌ای: ۱) استعلام زنده قیمت امروز از گوگل  ۲) صدور کارنامه JSON دقیق
    const normSeller = normalizeSellerId(body.sellerId || '');
    const blDb = readBlacklist();
    const blRecord = normSeller.length >= 3 ? blDb[normSeller] : null;

    const liveResearch = await runLiveMarketResearch(body, orderedModels);
    const prompt = buildAnalyzePrompt(body, blRecord, liveResearch);
    const { parsed, usedModel } = await callGeminiJson(prompt, body.images || [], orderedModels);

    const statusTag = liveResearch.searchSucceeded ? '🌐 قیمت زنده' : '⚠️ بدون سرچ زنده';

    return res.json({
      ...parsed,
      sources: liveResearch.sources,
      liveSearchUsed: liveResearch.searchSucceeded,
      usedModel: `${usedModel} • ${statusTag}`
    });
  } catch (err) {
    console.error('Analyze Error:', err.message);
    if (err.message === 'MISSING_API_KEY') {
      return res.status(500).json({ error: 'متغیر محیطی GEMINI_API_KEY روی سرور Render تنظیم نشده است.' });
    }
    return res.status(502).json({
      error: formatReadableError(err),
      detail: err.message
    });
  }
});

app.get(['/api/blacklist', '/webhook/blacklist'], verifyToken, (req, res) => {
  const sellerId = normalizeSellerId(req.query.sellerId || '');
  if (sellerId.length < 3) {
    return res.json({ found: false, blacklisted: false, reports: 0 });
  }
  const db = readBlacklist();
  const entry = db[sellerId];
  if (!entry) {
    return res.json({ found: false, blacklisted: false, reports: 0 });
  }
  return res.json({
    found: true,
    blacklisted: true,
    reports: entry.reports || 1,
    reason: entry.reason || 'گزارش‌شده توسط کاربران',
    lastReported: entry.lastReported
  });
});

app.post(['/api/blacklist', '/webhook/blacklist'], rateLimiter, verifyToken, (req, res) => {
  const body = req.body || {};
  const sellerId = normalizeSellerId(body.sellerId || '');
  if (sellerId.length < 3) {
    return res.status(400).json({ error: 'شناسه فروشنده معتبر نیست.' });
  }

  const db = readBlacklist();
  const existing = db[sellerId];
  db[sellerId] = {
    sellerId,
    platform: String(body.platform || 'unknown').slice(0, 30),
    reports: (existing?.reports || 0) + 1,
    reason: String(body.reason || existing?.reason || 'گزارش کلاهبرداری').slice(0, 220),
    lastReported: body.date || new Date().toLocaleDateString('fa-IR'),
    updatedAt: Date.now()
  };

  writeBlacklist(db);
  return res.json({ ok: true, reports: db[sellerId].reports });
});

app.get('/manifest.json', (req, res) => {
  const file = resolveFrontendFile('manifest.json');
  if (file) return res.sendFile(file);
  res.status(404).end();
});

app.get('/sw.js', (req, res) => {
  const file = resolveFrontendFile('sw.js');
  if (file) return res.sendFile(file);
  res.status(404).end();
});

app.get('*', (req, res) => {
  const file = resolveFrontendFile('index.html');
  if (file) return res.sendFile(file);
  res.status(404).send('فایل index.html پیدا نشد. لطفاً آن را داخل پوشه public قرار دهید.');
});

app.listen(PORT, () => {
  console.log(`Separ Kharid Pro server v4 (live-price-pipeline) running on port ${PORT}`);
});
