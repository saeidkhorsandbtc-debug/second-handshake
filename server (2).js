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
// حذف خودکار فاصله یا کوتیشن اضافه اطراف کلید API
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim().replace(/^["']|["']$/g, '');
const ENABLE_SEARCH_GROUNDING = process.env.ENABLE_SEARCH_GROUNDING !== 'false';
const APP_SECRET_TOKEN = String(process.env.APP_SECRET_TOKEN || '').trim().replace(/^["']|["']$/g, '');

const FALLBACK_MODELS = Array.from(new Set([
  GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite'
]));

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
   3. HELPERS & BLACKLIST STORAGE
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
    return `مدل ${GEMINI_MODEL} یافت نشد (404)`;
  }
  if (msg.includes('GEMINI_HTTP_400')) {
    return `درخواست نامعتبر به جمینی (400): ${msg.slice(0, 110)}`;
  }
  return `خطا در ارتباط با هوش مصنوعی: ${msg.slice(0, 120)}`;
}

/* ============================================================================
   4. RESILIENT GEMINI API CLIENT (AUTO-FALLBACK ON SEARCH/JSON/MODEL ERRORS)
   ============================================================================ */
async function invokeGeminiOnce(modelName, promptText, base64Images, useSearch) {
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

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2 }
  };

  if (useSearch) {
    body.tools = [{ google_search: {} }];
  } else {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

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

    // نادیده گرفتن بخش‌های داخلی thinking و فقط خواندن متن پاسخ نهایی
    const textOut = (candidate.content?.parts || [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim();

    if (!textOut) {
      throw new Error('EMPTY_TEXT_RESPONSE');
    }

    const parsed = extractJsonSafe(textOut);

    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
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

    return { parsed, sources, usedModel: modelName };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(promptText, base64Images = [], wantSearch = true) {
  if (!GEMINI_API_KEY) {
    throw new Error('MISSING_API_KEY');
  }

  const trySearch = Boolean(wantSearch && ENABLE_SEARCH_GROUNDING);
  let lastErr = null;

  // گام ۱: تلاش با مدل اصلی (در صورت فعال بودن، با سرچ زنده گوگل)
  if (trySearch) {
    try {
      return await invokeGeminiOnce(GEMINI_MODEL, promptText, base64Images, true);
    } catch (err) {
      console.warn(`Search grounding attempt failed on ${GEMINI_MODEL}:`, err.message);
      lastErr = err;
      // اگر کلید نامعتبر یا تحریم منطقه بود، تلاش مجدد فایده‌ای ندارد
      if (err.httpStatus === 403 || String(err.message).includes('API_KEY_INVALID')) {
        throw err;
      }
    }
  }

  // گام ۲: تلاش با حالت اجباری JSON روی مدل اصلی و مدل‌های جایگزین
  for (const model of FALLBACK_MODELS) {
    try {
      return await invokeGeminiOnce(model, promptText, base64Images, false);
    } catch (err) {
      console.warn(`JSON mode failed on ${model}:`, err.message);
      lastErr = err;
      if (err.httpStatus === 403 || String(err.message).includes('API_KEY_INVALID')) {
        throw err;
      }
    }
  }

  throw lastErr || new Error('ALL_MODELS_FAILED');
}

/* ============================================================================
   5. PROMPTS
   ============================================================================ */
function buildAnalyzePrompt(p, blacklistRecord) {
  const blNote = blacklistRecord
    ? `هشدار بسیار مهم از دیتابیس لیست سیاه سرور: برای این شناسه قبلاً ${blacklistRecord.reports} گزارش کلاهبرداری ثبت شده است (دلیل: ${blacklistRecord.reason}). این موضوع باید شاخص ریسک را شدیداً بالا ببرد.`
    : 'سابقه‌ای در لیست سیاه سرور ثبت نشده است.';

  return `تو کارشناس ارشد ضدکلاهبرداری و معاملات دست‌دوم بازار ایران هستی (دیوار، شیپور، اینستاگرام، باما، تلگرام).
اطلاعات پرونده:
- پلتفرم: ${PLATFORM_NAMES[p.platform] || p.platform}
- دسته‌بندی: ${CATEGORY_NAMES[p.category] || p.category}
- شناسه فروشنده: ${p.sellerId || 'نامشخص'}
- وضعیت لیست سیاه مشترک: ${blNote}
- قیمت پیشنهادی فروشنده: ${p.price || 'نامشخص'} تومان
- نشانه‌های مشکوک انتخاب‌شده: ${Array.isArray(p.quickFlags) && p.quickFlags.length ? p.quickFlags.join(' | ') : 'ندارد'}
- متن آگهی / لینک / چت: ${p.rawText || 'ثبت نشده'}

وظایف تو:
1. در صورت فعال بودن سرچ وب، قیمت روز کالای مشابه در بازار ایران و سابقه شکایت درباره آیدی/شماره فروشنده را بررسی کن.
2. تصاویر ضمیمه‌شده (عکس کالا، پروفایل، تاریخچه تغییر نام پیج یا اسکرین‌شات چت) را با دقت بررسی کن.
3. خروجی را فقط و فقط به صورت یک آبجکت JSON معتبر فارسی برگردان (بدون هیچ توضیح اضافه بیرون از JSON):
{
  "risk_score": عدد صحیح 0 تا 100 (عدد بالاتر = خطر بیشتر),
  "verdict": "حکم کوتاه و صریح کارشناسی",
  "summary": "تحلیل شفاف در ۲ تا ۳ جمله (همراه با مقایسه قیمت بازار در صورت امکان)",
  "scores": { "seller": 0-100, "visual": 0-100, "price": 0-100, "text": 0-100 },
  "red_flags": ["فهرست هشدارها و نکات مشکوک"],
  "green_flags": ["فهرست نکات مثبت و اطمینان‌بخش"],
  "verification_message": "پیام دقیق و مودبانه مچ‌گیری برای ارسال به فروشنده در چت",
  "checklist": ["چک‌لیست عملی بررسی حضوری و قبل از واریز وجه"]
}`;
}

function buildFollowupPrompt(p) {
  return `تو کارآگاه و کارشناس ضدکلاهبرداری معاملات دست‌دوم بازار ایران هستی.
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
  res.json({
    ok: true,
    service: 'separ-kharid-pro-server',
    geminiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL,
    searchGrounding: ENABLE_SEARCH_GROUNDING,
    uptimeSec: Math.round(process.uptime())
  });
});

// مسیر عیب‌یابی سریع در مرورگر: https://your-app.onrender.com/api/test-gemini
app.get('/api/test-gemini', verifyToken, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY تنظیم نشده است.' });
  }
  try {
    const result = await callGemini('فقط این JSON را برگردان: {"status":"ok"}', [], false);
    return res.json({ ok: true, usedModel: result.usedModel, response: result.parsed });
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
        geminiConfigured: Boolean(GEMINI_API_KEY)
      });
    }

    if (body.action === 'followup') {
      const prompt = buildFollowupPrompt(body);
      const { parsed } = await callGemini(prompt, body.images || [], false);
      return res.json({
        updated_risk_score: Math.max(0, Math.min(100, Number(parsed.updated_risk_score) || 50)),
        analysis: String(parsed.analysis || 'پاسخ فروشنده تحلیل شد.'),
        next_reply: String(parsed.next_reply || '')
      });
    }

    const normSeller = normalizeSellerId(body.sellerId || '');
    const blDb = readBlacklist();
    const blRecord = normSeller.length >= 3 ? blDb[normSeller] : null;

    const prompt = buildAnalyzePrompt(body, blRecord);
    const { parsed, sources } = await callGemini(prompt, body.images || [], true);

    return res.json({
      ...parsed,
      sources
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
  console.log(`Separ Kharid Pro server running on port ${PORT}`);
});
