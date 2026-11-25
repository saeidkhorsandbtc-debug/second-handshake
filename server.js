'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

/* ============================================================================
   1. CONFIGURATION (تنظیم از Environment Variables در پنل Render)
   ============================================================================ */
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || '').trim().replace(/^["']|["']$/g, '');
const SERPER_API_KEY = String(process.env.SERPER_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
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
   2. OPTIONAL POSTGRESQL PERSISTENT BLACKLIST (NEON / SUPABASE)
   ============================================================================ */
let pgPool = null;
let pgReady = false;

async function initPostgresBlacklist() {
  if (!DATABASE_URL) return;
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 9000
    });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS blacklist (
        seller_id TEXT PRIMARY KEY,
        platform TEXT DEFAULT 'unknown',
        reports INTEGER DEFAULT 1,
        reason TEXT DEFAULT '',
        last_reported TEXT DEFAULT '',
        updated_at BIGINT DEFAULT 0
      )
    `);
    pgReady = true;
    console.log('PostgreSQL persistent blacklist initialized successfully.');
  } catch (err) {
    pgReady = false;
    console.warn('PostgreSQL init warning (falling back to local JSON file):', err.message);
  }
}

initPostgresBlacklist();

/* ============================================================================
   3. MIDDLEWARES (CORS + JSON 15MB + STATIC + RATE LIMITER)
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
const RATE_MAX_REQ = 60;

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
   4. HELPERS, FULL 10-CATEGORY METADATA & HYBRID BLACKLIST STORAGE
   ============================================================================ */
const PLATFORM_NAMES = {
  divar: 'دیوار',
  instagram: 'اینستاگرام',
  bama: 'خودرو/باما',
  sheypoor: 'شیپور',
  telegram: 'تلگرام/سایر'
};

const CATEGORY_NAMES = {
  real_estate: 'املاک',
  car: 'وسایل نقلیه',
  mobile: 'کالای دیجیتال',
  home: 'خانه و آشپزخانه',
  services: 'خدمات',
  shop: 'وسایل شخصی',
  entertainment: 'سرگرمی و فراغت',
  social: 'اجتماعی',
  industrial: 'تجهیزات و صنعتی',
  jobs: 'استخدام و کاریابی',
  other: 'سایر'
};

const DETAIL_FIELD_LABELS = {
  city: 'شهر معامله',
  sellerBadge: 'وضعیت احراز هویت و سابقه فروشنده',
  safePay: 'پذیرش پرداخت امن',
  dealType: 'روش تحویل و تسویه',
  igFollowers: 'تعداد فالوور پیج اینستاگرام',
  igNameChanges: 'تعداد تغییر نام کاربری پیج (About This Account)',
  igComments: 'وضعیت کامنت‌های پیج',
  igTrust: 'وضعیت آدرس حضوری / اینماد / سایت',
  carSellerRole: 'سمت آگهی‌دهنده خودرو',
  carInspection: 'پذیرش کارشناسی رنگ/فنی به انتخاب خریدار',
  tgChannelType: 'نوع فروشنده در تلگرام/سایر',
  tgViewsRatio: 'تناسب بازدید پست‌ها با اعضا',
  tgEscrow: 'روش پرداخت در تلگرام',
  itemModel: 'عنوان / مدل دقیق کالا یا ملک',
  batteryHealth: 'سلامت باتری / مدت کارکرد',
  registryStatus: 'وضعیت رجیستری و انتقال مالکیت همتا',
  boxRepair: 'وضعیت جعبه، لوازم و تعمیری بودن',
  carMileage: 'کارکرد خودرو (کیلومتر)',
  carPaint: 'وضعیت رنگ و شاسی خودرو',
  carInsurance: 'مهلت بیمه شخص ثالث',
  usageDuration: 'مدت کارکرد دستگاه',
  homeCondition: 'وضعیت کارتن، گارانتی و تعمیر',
  shopReturn: 'امکان مرجوعی / پرداخت در محل',
  reNeighborhood: 'محله / منطقه دقیق ملک',
  reArea: 'متراژ (متر مربع)',
  reBuildYear: 'سال ساخت',
  reDeposit: 'مبلغ رهن / ودیعه یا پیش‌پرداخت',
  reDocType: 'وضعیت سند و قرارداد (تک‌برگ / کدرهگیری)',
  reVisitStatus: 'وضعیت بازدید حضوری و درخواست بیعانه',
  srvPrepay: 'درخواست پیش‌پرداخت یا هزینه ایاب‌وذهاب',
  srvLicense: 'مجوز صنفی / محل کار ثابت / قرارداد',
  entEventInfo: 'تاریخ رویداد/تور یا اصالت بلیط و کالا',
  entTransfer: 'نحوه تحویل و تضمین اصالت',
  socMoneyReq: 'درخواست وجه، مژدگانی قبلی یا کد پیامکی',
  socIdentity: 'هویت و شفافیت برگزارکننده / آگهی‌دهنده',
  indSpec: 'مشخصات فنی (توان، ظرفیت، سال ساخت)',
  indTest: 'امکان تست زیر بار، فاکتور رسمی و گارانتی',
  jobCompany: 'نام شرکت / کارفرما و آدرس حضوری',
  jobWorkType: 'نوع همکاری (حضوری / دورکاری / پاره وقت)',
  jobFeeReq: 'درخواست هزینه ثبت‌نام، پکیج، وثیقه یا مدارک بانکی',
  otherCondition: 'وضعیت ظاهری و فنی'
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

function formatDetailsForPrompt(details) {
  if (!details || typeof details !== 'object') return 'ثبت نشده';
  const lines = [];
  for (const [k, v] of Object.entries(details)) {
    const val = String(v || '').trim();
    if (!val || val === 'نامشخص' || val === 'هنوز نپرسیده‌ام' || val === 'چک نکرده‌ام') continue;
    const label = DETAIL_FIELD_LABELS[k] || k;
    lines.push(`- ${label}: ${val}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'ثبت نشده';
}

function detectSiteLabel(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('divar.ir')) return 'دیوار';
  if (u.includes('sheypoor.com')) return 'شیپور';
  if (u.includes('bama.ir')) return 'باما';
  if (u.includes('kilid.com')) return 'کیلید';
  if (u.includes('shabesh.com')) return 'شابش';
  if (u.includes('delta.ir')) return 'دلتا';
  if (u.includes('torob.com')) return 'ترب';
  if (u.includes('emalls.ir')) return 'ایمالز';
  if (u.includes('digikala.com')) return 'دیجی‌کالا';
  if (u.includes('hamrah-mechanic.com')) return 'همراه‌مکانیک';
  if (u.includes('jobinja.ir')) return 'جابینجا';
  if (u.includes('jobvision.ir')) return 'جاب‌ویژن';
  if (u.includes('instagram.com')) return 'اینستاگرام';
  return 'سایر';
}

function extractPriceHintFromText(text) {
  const norm = toEnDigits(String(text || '')).replace(/[٬،]/g, ',');
  const mFull = norm.match(/(\d{1,3}(?:,\d{3}){2,3}|\d{7,12})\s*(?:تومان|تومن)/);
  if (mFull) {
    const n = parseInt(mFull[1].replace(/,/g, ''), 10);
    if (n >= 100000) return `${n.toLocaleString('en-US')} تومان`;
  }
  const mShort = norm.match(/(\d+(?:[./]\d+)?)\s*(میلیارد|میلیون)/);
  if (mShort) {
    return `${mShort[1].replace('/', '.')} ${mShort[2]} تومان`;
  }
  if (/توافقی/.test(norm)) return 'توافقی';
  return '';
}

function readBlacklistLocal() {
  try {
    if (!fs.existsSync(BLACKLIST_FILE)) return {};
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeBlacklistLocal(db) {
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Blacklist write warning:', err.message);
  }
}

async function getBlacklistEntry(sellerId) {
  const norm = normalizeSellerId(sellerId);
  if (norm.length < 3) return null;

  if (pgReady && pgPool) {
    try {
      const { rows } = await pgPool.query(
        'SELECT seller_id, platform, reports, reason, last_reported FROM blacklist WHERE seller_id = $1 LIMIT 1',
        [norm]
      );
      if (rows.length > 0) {
        const r = rows[0];
        return {
          sellerId: r.seller_id,
          platform: r.platform,
          reports: Number(r.reports) || 1,
          reason: r.reason || 'گزارش‌شده توسط کاربران',
          lastReported: r.last_reported || ''
        };
      }
      return null;
    } catch (err) {
      console.warn('PG read blacklist warning:', err.message);
    }
  }

  const db = readBlacklistLocal();
  return db[norm] || null;
}

async function upsertBlacklistEntry({ sellerId, platform, reason, date }) {
  const norm = normalizeSellerId(sellerId);
  const safePlat = String(platform || 'unknown').slice(0, 30);
  const safeReason = String(reason || 'گزارش کلاهبرداری').slice(0, 220);
  const safeDate = String(date || new Date().toLocaleDateString('fa-IR')).slice(0, 32);
  const now = Date.now();

  if (pgReady && pgPool) {
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO blacklist (seller_id, platform, reports, reason, last_reported, updated_at)
         VALUES ($1, $2, 1, $3, $4, $5)
         ON CONFLICT (seller_id) DO UPDATE SET
           reports = blacklist.reports + 1,
           platform = EXCLUDED.platform,
           reason = COALESCE(NULLIF(EXCLUDED.reason, ''), blacklist.reason),
           last_reported = EXCLUDED.last_reported,
           updated_at = EXCLUDED.updated_at
         RETURNING reports`,
        [norm, safePlat, safeReason, safeDate, now]
      );
      return { reports: Number(rows[0]?.reports) || 1, storage: 'postgresql' };
    } catch (err) {
      console.warn('PG write blacklist warning:', err.message);
    }
  }

  const db = readBlacklistLocal();
  const existing = db[norm];
  db[norm] = {
    sellerId: norm,
    platform: safePlat,
    reports: (existing?.reports || 0) + 1,
    reason: safeReason || existing?.reason || 'گزارش کلاهبرداری',
    lastReported: safeDate,
    updatedAt: now
  };
  writeBlacklistLocal(db);
  return { reports: db[norm].reports, storage: 'local-file' };
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
   5. REVERSE IMAGE SEARCH (STOLEN / STOCK PHOTO DETECTOR VIA SERPER LENS)
   ============================================================================ */
const tempImageStore = new Map();
const TEMP_IMG_TTL_MS = 90 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [tok, item] of tempImageStore.entries()) {
    if (now > item.expiresAt) {
      tempImageStore.delete(tok);
    }
  }
}, 30 * 1000).unref();

function getPublicBaseForRequest(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = req.get('host') || '';
  if (!host || /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return '';
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

async function runReverseImageLookup(base64Str, req) {
  if (!SERPER_API_KEY) {
    return { checked: false, reason: 'NO_SERPER_KEY', message: 'برای ردیابی عکس دزدی، متغیر SERPER_API_KEY را در Render تنظیم کنید.' };
  }
  const publicBase = getPublicBaseForRequest(req);
  if (!publicBase) {
    return { checked: false, reason: 'NO_PUBLIC_URL', message: 'ردیابی معکوس تصویر فقط روی دامنه آنلاین (Render) قابل اجراست.' };
  }

  const cleanB64 = String(base64Str || '').includes(',') ? String(base64Str).split(',')[1] : String(base64Str || '');
  if (cleanB64.length < 100) {
    return { checked: false, reason: 'INVALID_IMAGE', message: 'تصویر معتبری برای بررسی ارسال نشد.' };
  }

  if (tempImageStore.size >= 20) {
    const oldestKey = tempImageStore.keys().next().value;
    if (oldestKey) tempImageStore.delete(oldestKey);
  }

  const token = crypto.randomBytes(20).toString('hex');
  const buf = Buffer.from(cleanB64, 'base64');
  if (buf.length > 4 * 1024 * 1024) {
    return { checked: false, reason: 'TOO_LARGE', message: 'حجم تصویر برای جستجوی معکوس زیاد است.' };
  }

  tempImageStore.set(token, { buffer: buf, expiresAt: Date.now() + TEMP_IMG_TTL_MS });
  const tempUrl = `${publicBase}/api/temp-img/${token}.jpg`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);

  try {
    const res = await fetch('https://google.serper.dev/lens', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: tempUrl, gl: 'ir', hl: 'fa' }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`LENS_HTTP_${res.status}: ${errBody.slice(0, 120)}`);
    }

    const data = await res.json();
    const rawList = Array.isArray(data.organic) ? data.organic : (Array.isArray(data.visual_matches) ? data.visual_matches : []);

    const matches = [];
    let iranAdMatches = 0;
    let storeOrStockMatches = 0;

    for (const item of rawList.slice(0, 10)) {
      const link = String(item.link || '').trim();
      const title = String(item.title || '').trim();
      const source = String(item.source || detectSiteLabel(link)).trim();
      if (!link || !/^https?:\/\//i.test(link)) continue;

      const lower = link.toLowerCase();
      const isIranAd = /(divar\.ir|sheypoor\.com|bama\.ir|esam\.ir|instagram\.com|kilid\.com|shabesh\.com)/i.test(lower);
      const isStoreStock = /(digikala|torob|emalls|amazon|ebay|aliexpress|gsmarena|apple\.com|samsung\.com|pinterest|shutterstock|istock|unsplash|wikimedia)/i.test(lower);
      if (isIranAd) iranAdMatches++;
      if (isStoreStock) storeOrStockMatches++;

      matches.push({
        title: (title || source || link).slice(0, 80),
        source: source.slice(0, 35),
        link,
        tag: isIranAd ? 'آگهی/پست مشابه' : (isStoreStock ? 'عکس فروشگاهی/اینترنتی' : 'منبع وب')
      });
    }

    let risk_level = 'safe';
    let verdict = '✅ این تصویر در آگهی‌ها یا سایت‌های دیگر پیدا نشد (احتمالاً عکس واقعی و اختصاصی است).';

    if (iranAdMatches >= 1) {
      risk_level = 'danger';
      verdict = `🚨 هشدار جدی عکس تکراری: این تصویر یا نمونه بسیار مشابه آن در ${iranAdMatches} آگهی/پست دیگر (دیوار، شیپور، باما یا اینستاگرام) دیده شده است! حتماً عکس جدید همراه با کاغذ تاریخ امروز بخواهید.`;
    } else if (storeOrStockMatches >= 2 || matches.length >= 4) {
      risk_level = 'warn';
      verdict = `⚠️ احتمال عکس اینترنتی/کاتالوگی: ${matches.length} نمونه مشابه در سایت‌ها و فروشگاه‌های اینترنتی پیدا شد؛ ممکن است عکس واقعی کالای دست‌دوم نباشد.`;
    } else if (matches.length > 0) {
      risk_level = 'warn';
      verdict = `⚠️ تعداد ${matches.length} تصویر مشابه در وب پیدا شد؛ لینک‌های زیر را مقایسه کنید و عکس اختصاصی از خود مورد بخواهید.`;
    }

    return {
      checked: true,
      risk_level,
      verdict,
      match_count: matches.length,
      iran_ad_matches: iranAdMatches,
      matches: matches.slice(0, 6)
    };
  } catch (err) {
    console.warn('Reverse image lookup warning:', err.message);
    return {
      checked: false,
      reason: 'LENS_ERROR',
      message: `خطا در جستجوی معکوس تصویر: ${err.message.slice(0, 90)}`
    };
  } finally {
    clearTimeout(timeout);
    setTimeout(() => tempImageStore.delete(token), 8000).unref();
  }
}

/* ============================================================================
   6. SERPER.DEV MARKET ENGINE (ALL 10 CATEGORIES + DIVAR/SHEYPOOR/BAMA)
   ============================================================================ */
async function querySerper(query, num = 6, extraParams = {}) {
  if (!SERPER_API_KEY) throw new Error('MISSING_SERPER_KEY');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 11000);

  const payload = {
    q: String(query).slice(0, 240),
    gl: 'ir',
    hl: 'fa',
    num,
    ...extraParams
  };

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`SERPER_HTTP_${res.status}: ${errBody.slice(0, 140)}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function formatSerperItems(data, label, maxItems = 5, isComparable = false) {
  const lines = [];
  const sources = [];
  const comparables = [];

  if (data?.answerBox) {
    const ab = data.answerBox;
    const ans = ab.answer || ab.snippet || '';
    if (ans) lines.push(`[پاسخ مستقیم گوگل - ${label}]: ${ans}`);
  }

  const organic = Array.isArray(data?.organic) ? data.organic.slice(0, maxItems) : [];
  for (const item of organic) {
    const title = String(item.title || '').trim();
    const snippet = String(item.snippet || '').trim();
    const link = String(item.link || '').trim();
    const dateTag = item.date ? ` (${item.date})` : '';
    const serperPrice = item.price ? `${item.price}${item.currency ? ' ' + item.currency : ''}` : '';
    const guessedPrice = serperPrice || extractPriceHintFromText(`${title} ${snippet}`);
    const priceTag = guessedPrice ? ` [قیمت: ${guessedPrice}]` : '';
    const site = detectSiteLabel(link);

    if (title || snippet) {
      lines.push(`- [${site}] ${title}${dateTag}${priceTag} | لینک: ${link} | شرح: ${snippet}`);
    }
    if (link && /^https?:\/\//i.test(link)) {
      sources.push({
        title: (title || link).slice(0, 65),
        uri: link
      });
      if (isComparable && (site === 'دیوار' || site === 'شیپور' || site === 'باما' || site === 'کیلید' || site === 'شابش')) {
        comparables.push({
          title: title.replace(/\s*\|\s*(دیوار|شیپور|باما|کیلید|شابش).*$/i, '').slice(0, 75),
          site,
          price_text: guessedPrice || 'توافقی / نامشخص',
          condition_note: (item.date ? `${item.date} • ` : '') + snippet.slice(0, 70),
          url: link
        });
      }
    }
  }

  return { lines, sources, comparables };
}

function fallbackProductKeyword(rawText, category, subcategory) {
  const cleaned = String(rawText || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length >= 4) {
    return cleaned.split(' ').slice(0, 7).join(' ');
  }
  return subcategory || CATEGORY_NAMES[category] || '';
}

async function extractProductSearchTerm(p, orderedModels) {
  const explicitModel = String(p.details?.itemModel || '').trim();
  if (explicitModel.length >= 3) {
    return explicitModel.slice(0, 75);
  }

  if (p.category === 'real_estate') {
    const parts = [
      p.subcategory || 'ملک',
      p.details?.reArea ? `${p.details.reArea} متر` : '',
      p.details?.reNeighborhood || ''
    ].filter(Boolean);
    if (parts.length >= 2) return parts.join(' ').slice(0, 75);
  }

  if (p.category === 'jobs') {
    const parts = [p.details?.jobCompany || '', p.subcategory || 'استخدام'].filter(Boolean);
    if (parts.length >= 1 && p.details?.jobCompany) return parts.join(' ').slice(0, 75);
  }

  const rawText = String(p.rawText || '').trim();
  const hasImages = Array.isArray(p.images) && p.images.length > 0;
  if (!rawText && !hasImages) return p.subcategory || '';

  const prompt = `از متن یا تصویر زیر، فقط عنوان دقیق و کوتاه کالا/ملک/خدمت (برند + مدل + سال/ظرفیت یا نوع ملک و محله) را برای جستجو در دیوار و شیپور استخراج کن.
دسته‌بندی: ${CATEGORY_NAMES[p.category] || p.category} ${p.subcategory ? `(${p.subcategory})` : ''}
متن آگهی: "${rawText.slice(0, 500)}"
فقط و فقط JSON معتبر برگردان:
{"product_name": "عنوان دقیق و کوتاه برای سرچ (حداکثر ۶ کلمه)"}`;

  const extractImages = rawText.length < 25 && hasImages ? p.images.slice(0, 1) : [];

  for (const model of orderedModels.slice(0, 2)) {
    try {
      const res = await invokeGeminiRaw(model, prompt, extractImages, {
        useSearch: false,
        expectJson: true,
        timeoutMs: 11000
      });
      const parsed = extractJsonSafe(res.textOut);
      const name = String(parsed?.product_name || '').trim();
      if (name.length >= 2) return name;
    } catch (err) {
      console.warn(`Product extraction warning (${model}):`, err.message);
    }
  }

  return fallbackProductKeyword(rawText, p.category, p.subcategory);
}

async function runSerperMarketResearch(p, orderedModels) {
  if (!SERPER_API_KEY) {
    return { searchSucceeded: false, researchText: '', sources: [], rawComparables: [], productName: '', provider: 'none' };
  }

  const productName = await extractProductSearchTerm(p, orderedModels);
  const sellerId = String(p.sellerId || '').trim();
  const city = String(p.details?.city || '').trim();
  const cityPart = city.length >= 2 ? ` ${city}` : '';
  const sub = String(p.subcategory || '').trim();

  const queries = [];
  if (productName) {
    if (p.category === 'real_estate') {
      const hood = String(p.details?.reNeighborhood || '').trim();
      const areaPart = p.details?.reArea ? ` ${p.details.reArea} متر` : '';
      const reTerm = `${sub || productName} ${hood}${cityPart}${areaPart}`.replace(/\s+/g, ' ').trim();
      queries.push({
        key: 'divar',
        label: 'آگهی‌های مشابه املاک در دیوار (۳۰ روز اخیر)',
        q: `site:divar.ir/v/ ${reTerm}`,
        num: 6,
        extra: { tbs: 'qdr:m' },
        isComparable: true
      });
      queries.push({
        key: 'sheypoor',
        label: 'آگهی‌های مشابه املاک در شیپور/کیلید',
        q: `(site:sheypoor.com/v/ OR site:kilid.com) ${reTerm}`,
        num: 5,
        extra: { tbs: 'qdr:m' },
        isComparable: true
      });
      queries.push({
        key: 'new_ref',
        label: 'قیمت میانگین هر متر یا اجاره منطقه',
        q: `قیمت هر متر ${hood || productName}${cityPart} تومان`,
        num: 4,
        extra: {},
        isComparable: false
      });
    } else if (p.category === 'car') {
      queries.push({
        key: 'divar',
        label: 'آگهی‌های مشابه خودرو در دیوار (۳۰ روز اخیر)',
        q: `site:divar.ir/v/ ${productName}${cityPart}`,
        num: 6,
        extra: { tbs: 'qdr:m' },
        isComparable: true
      });
      queries.push({
        key: 'bama',
        label: 'آگهی‌های مشابه خودرو در باما (۳۰ روز اخیر)',
        q: `site:bama.ir/car/ ${productName}`,
        num: 5,
        extra: { tbs: 'qdr:m' },
        isComparable: true
      });
      queries.push({
        key: 'new_ref',
        label: 'قیمت روز مرجع خودرو (باما/همراه‌مکانیک)',
        q: `قیمت روز ${productName} باما OR همراه مکانیک`,
        num: 4,
        extra: { tbs: 'qdr:m' },
        isComparable: false
      });
    } else if (p.category === 'jobs') {
      const comp = String(p.details?.jobCompany || '').trim();
      queries.push({
        key: 'divar',
        label: 'آگهی‌های مشابه استخدامی در دیوار',
        q: `site:divar.ir/v/ استخدام ${sub || productName}${cityPart}`,
        num: 5,
        extra: { tbs: 'qdr:m' },
        isComparable: true
      });
      if (comp.length >= 3) {
        queries.push({
          key: 'company_check',
          label: 'بررسی اعتبار شرکت و کارفرما',
          q: `"${comp}" استخدام OR کلاهبرداری OR نظر کارمندان OR جابینجا`,
          num: 4,
          extra: {},
          isComparable: false
        });
      } else {
        queries.push({
          key: 'salary_ref',
          label: 'میانگین حقوق و هشدارهای رایج این شغل',
          q: `حقوق ${sub || productName} ایران ۱۴۰۴ OR کلاهبرداری استخدام`,
          num: 4,
          extra: {},
          isComparable: false
        });
      }
    } else if (p.category === 'services' || p.category === 'social') {
      queries.push({
        key: 'divar',
        label: `آگهی‌های مشابه ${CATEGORY_NAMES[p.category]} در دیوار`,
        q: `site:divar.ir/v/ ${productName}${cityPart}`,
        num: 5,
        extra: { tbs: 'qdr:m' },
        isComparable: true
      });
      queries.push({
        key: 'new_ref',
        label: 'نرخ عرف و بررسی هشدارها',
        q: `تعرفه قیمت ${productName}${cityPart} تومان`,
        num: 4,
        extra: {},
        isComparable: false
      });
    } else {
      // mobile, home, shop, entertainment, industrial, other
      queries.push({
        key: 'divar',
        label: 'آگهی‌های مشابه واقعی در دیوار (۳۰ روز اخیر)',
        q: `site:divar.ir/v/ ${productName}${cityPart}`,
        num: 6,
        extra: { tbs: 'qdr:m' },
        isComparable: true
      });
      queries.push({
        key: 'sheypoor',
        label: 'آگهی‌های مشابه واقعی در شیپور (۳۰ روز اخیر)',
        q: `site:sheypoor.com/v/ ${productName}${cityPart}`,
        num: 5,
        extra: { tbs: 'qdr:m' },
        isComparable: true
      });
      queries.push({
        key: 'new_ref',
        label: 'قیمت آکبند روز بازار (ترب/ایمالز/دیجی‌کالا)',
        q: `قیمت ${productName} ترب OR ایمالز OR دیجی کالا`,
        num: 4,
        extra: {},
        isComparable: false
      });
    }
  }

  if (sellerId.length >= 4 && sellerId !== 'ثبت‌نشده') {
    queries.push({
      key: 'seller',
      label: 'استعلام سابقه کلاهبرداری فروشنده',
      q: `"${sellerId}" کلاهبرداری OR شکایت OR فیشینگ`,
      num: 3,
      extra: {},
      isComparable: false
    });
  }

  if (queries.length === 0) {
    return { searchSucceeded: false, researchText: '', sources: [], rawComparables: [], productName: '', provider: 'serper' };
  }

  const results = await Promise.allSettled(
    queries.map((item) => querySerper(item.q, item.num, item.extra))
  );

  const allLines = [];
  const allSources = [];
  const rawComparables = [];
  let anySuccess = false;

  if (productName) {
    allLines.push(`مورد شناسایی‌شده برای استعلام و مقایسه: ${productName}${sub ? ` (${sub})` : ''}${city ? ` — شهر: ${city}` : ''}`);
  }

  const pushUniqueComparable = (c) => {
    if (!rawComparables.some((x) => x.url === c.url)) {
      rawComparables.push(c);
    }
  };
  const pushUniqueSource = (src) => {
    if (!allSources.some((x) => x.uri === src.uri)) {
      allSources.push(src);
    }
  };

  results.forEach((res, idx) => {
    const qInfo = queries[idx];
    if (res.status === 'fulfilled') {
      const formatted = formatSerperItems(res.value, qInfo.label, qInfo.isComparable ? 5 : 4, qInfo.isComparable);
      if (formatted.lines.length > 0) {
        anySuccess = true;
        allLines.push(`\n### ${qInfo.label}:`);
        allLines.push(...formatted.lines);
        formatted.sources.forEach(pushUniqueSource);
        formatted.comparables.forEach(pushUniqueComparable);
      }
    } else {
      console.warn(`Serper query failed (${qInfo.label}):`, res.reason?.message || res.reason);
    }
  });

  if (productName && rawComparables.length < 2) {
    try {
      const broadDivar = await querySerper(`site:divar.ir/v/ ${productName}`, 6, {});
      const formatted = formatSerperItems(broadDivar, 'آگهی‌های مشابه دیوار (سراسری)', 5, true);
      if (formatted.lines.length > 0) {
        anySuccess = true;
        allLines.push('\n### آگهی‌های مشابه دیوار (سراسری):');
        allLines.push(...formatted.lines);
        formatted.sources.forEach(pushUniqueSource);
        formatted.comparables.forEach(pushUniqueComparable);
      }
    } catch (err) {
      console.warn('Broad Divar fallback warning:', err.message);
    }
  }

  if (!anySuccess) {
    return { searchSucceeded: false, researchText: '', sources: [], rawComparables: [], productName, provider: 'serper' };
  }

  return {
    searchSucceeded: true,
    researchText: allLines.join('\n').slice(0, 6200),
    sources: allSources.slice(0, 10),
    rawComparables: rawComparables.slice(0, 8),
    productName,
    provider: 'serper'
  };
}

function sanitizeMarketComparison(aiComp, rawComparables = [], fallbackProductName = '') {
  const realMap = new Map();
  for (const rc of rawComparables) {
    realMap.set(rc.url, rc);
  }

  const outComps = [];
  if (aiComp && Array.isArray(aiComp.comparables)) {
    for (const item of aiComp.comparables) {
      if (!item || typeof item !== 'object') continue;
      let safeUrl = String(item.url || '').trim();
      if (!/^https?:\/\//i.test(safeUrl)) safeUrl = '';
      if (safeUrl && realMap.size > 0 && !realMap.has(safeUrl)) {
        const matched = rawComparables.find((rc) => rc.url.includes(safeUrl) || safeUrl.includes(rc.url));
        safeUrl = matched ? matched.url : '';
      }
      if (!safeUrl && rawComparables.length > 0) continue;

      const title = String(item.title || '').trim().slice(0, 80);
      if (!title) continue;
      if (outComps.some((c) => safeUrl && c.url === safeUrl)) continue;

      outComps.push({
        title,
        site: String(item.site || detectSiteLabel(safeUrl)).slice(0, 20),
        price_text: String(item.price_text || 'توافقی / نامشخص').slice(0, 45),
        condition_note: String(item.condition_note || '').slice(0, 90),
        url: safeUrl
      });
    }
  }

  if (outComps.length < 2 && rawComparables.length > 0) {
    for (const rc of rawComparables) {
      if (outComps.length >= 6) break;
      if (outComps.some((c) => c.url === rc.url)) continue;
      outComps.push({
        title: rc.title,
        site: rc.site,
        price_text: rc.price_text,
        condition_note: rc.condition_note,
        url: rc.url
      });
    }
  }

  if (!aiComp && outComps.length === 0) return null;

  const diffNum = Number(aiComp?.price_diff_percent);
  return {
    product_detected: String(aiComp?.product_detected || fallbackProductName || '').slice(0, 80),
    new_price_range: String(aiComp?.new_price_range || 'نامشخص').slice(0, 80),
    used_price_range: String(aiComp?.used_price_range || 'نامشخص').slice(0, 80),
    price_status: String(aiComp?.price_status || 'نامشخص').slice(0, 40),
    price_diff_percent: Number.isFinite(diffNum) ? Math.max(-95, Math.min(300, Math.round(diffNum))) : null,
    comparables: outComps.slice(0, 6)
  };
}

/* ============================================================================
   7. LIVE MODEL DISCOVERY + GEMINI CLIENT
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

async function invokeGeminiRaw(modelName, promptText, base64Images, { useSearch = false, expectJson = true, timeoutMs = 36000 } = {}) {
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

async function runGeminiSearchFallback(p, orderedModels) {
  if (!ENABLE_SEARCH_GROUNDING) {
    return { searchSucceeded: false, researchText: '', sources: [], rawComparables: [], productName: '', provider: 'none' };
  }

  const { faDate, faYear, enDate } = getTodayDates();
  const modelHint = String(p.details?.itemModel || p.subcategory || '').trim();
  const researchPrompt = `تاریخ امروز: ${faDate} (${enDate}).
حتماً با Google Search قیمت روز امروز (سال ${faYear}) در دیوار، شیپور، ترب و باما را برای این آگهی پیدا کن:
پلتفرم: ${PLATFORM_NAMES[p.platform] || p.platform} | دسته: ${CATEGORY_NAMES[p.category] || p.category} ${p.subcategory ? `(${p.subcategory})` : ''} | مورد: ${modelHint || 'از متن/عکس بخوان'} | قیمت پیشنهادی: ${p.price || 'نامشخص'} تومان
متن آگهی: ${p.rawText || '(از روی تصویر تشخیص بده)'}
در حداکثر ۵ خط فارسی: نام دقیق مورد، بازه قیمت/عرف امروز در دیوار و شیپور، قیمت مرجع و هر سابقه کلاهبرداری فروشنده را بنویس. از حافظه قدیمی عدد نگو.`;

  const researchImages = (String(p.rawText || '').trim().length < 20 && Array.isArray(p.images))
    ? p.images.slice(0, 1)
    : [];

  const searchModels = orderedModels.filter((m) => !/^gemma/i.test(m)).slice(0, 2);

  for (const model of searchModels) {
    try {
      const res = await invokeGeminiRaw(model, researchPrompt, researchImages, {
        useSearch: true,
        expectJson: false,
        timeoutMs: 20000
      });
      if (res.sources.length > 0 || res.searchQueries.length > 0) {
        const rawComparables = res.sources
          .filter((s) => /(divar\.ir|sheypoor\.com|bama\.ir|kilid\.com)/i.test(s.uri))
          .map((s) => ({
            title: s.title,
            site: detectSiteLabel(s.uri),
            price_text: extractPriceHintFromText(s.title) || 'مشاهده در آگهی',
            condition_note: 'پیداشده در جستجوی زنده',
            url: s.uri
          }));
        return {
          searchSucceeded: true,
          researchText: res.textOut,
          sources: res.sources,
          rawComparables,
          productName: modelHint,
          provider: 'gemini'
        };
      }
    } catch (err) {
      console.warn(`Gemini fallback search failed on ${model}:`, err.message);
      if (err.httpStatus === 403 || String(err.message).includes('API_KEY_INVALID')) {
        throw err;
      }
    }
  }

  return { searchSucceeded: false, researchText: '', sources: [], rawComparables: [], productName: modelHint, provider: 'none' };
}

async function runLiveMarketResearch(p, orderedModels) {
  if (SERPER_API_KEY) {
    const serperRes = await runSerperMarketResearch(p, orderedModels);
    if (serperRes.searchSucceeded) {
      return serperRes;
    }
  }
  return await runGeminiSearchFallback(p, orderedModels);
}

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
        timeoutMs: 36000
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
   8. PROMPTS (FULL 10 CATEGORIES + SUBCATEGORIES + ANTI-SCAM EXPERTISE)
   ============================================================================ */
function buildAnalyzePrompt(p, blacklistRecord, liveResearch, reverseImageRes) {
  const { faDate, enDate } = getTodayDates();
  const formattedDetails = formatDetailsForPrompt(p.details);

  const blNote = blacklistRecord
    ? `هشدار بسیار مهم از دیتابیس لیست سیاه سرور: برای این شناسه قبلاً ${blacklistRecord.reports} گزارش کلاهبرداری ثبت شده است (دلیل: ${blacklistRecord.reason}). این موضوع باید شاخص ریسک را شدیداً بالا ببرد.`
    : 'سابقه‌ای در لیست سیاه سرور ثبت نشده است.';

  const reverseNote = (reverseImageRes && reverseImageRes.checked)
    ? `نتیجه جستجوی معکوس تصویر اول (Google Lens): ${reverseImageRes.verdict} (تعداد تطابق‌ها: ${reverseImageRes.match_count}، آگهی‌های مشابه ایرانی: ${reverseImageRes.iran_ad_matches}). اگر تصویر تکراری/آرشیوی است حتماً در red_flags و کاهش امتیاز visual لحاظ کن.`
    : '';

  const categoryExpertHint = {
    real_estate: 'تخصص ویژه املاک ایران: مراقب کلاهبرداری بیعانه اجاره روزانه ویلا/سوئیت بدون بازدید، فروش مال غیر و پیش‌فروش بدون مجوز/پروانه، نبود کدرهگیری املاک، سند وکالتی مشکوک و قیمت متری بسیار زیر عرف محله باش.',
    jobs: 'تخصص ویژه استخدام ایران: مراقب کلاهبرداری‌های رایج دورکاری/تایپ/بسته‌بندی در منزل/ادمین تلگرام باش که پول ثبت‌نام، پکیج آموزشی، سفته سنگین یا احراز هویت با حساب بانکی/صرافی ارز دیجیتال می‌خواهند (خطر پولشویی با حساب اجاره‌ای!).',
    services: 'تخصص ویژه خدمات: مراقب درخواست بیعانه قبل از شروع کار، نبود فاکتور و مجوز اتحادیه، و قیمت‌های غیرمنطقی و دام‌گستر باش.',
    entertainment: 'تخصص ویژه سرگرمی و تور/بلیط: مراقب بلیط کنسرت و تور چارتر جعلی (تیکت فیک)، واریز به حساب شخصی به‌جای آژانس دارای مجوز و خرید حیوانات/دوچرخه با بیعانه باش.',
    social: 'تخصص ویژه آگهی اجتماعی: مراقب درخواست مژدگانی قبل از تحویل شیء گم‌شده، ارسال کد تایید پیامکی (OTP) یا جمع‌آوری کمک مالی جعلی به حساب شخصی باش.',
    industrial: 'تخصص ویژه تجهیزات صنعتی: مراقب دستگاه‌های استوک تعمیری، نبود تست زیر بار، نداشتن فاکتور معتبر و پیش‌پرداخت‌های سنگین قبل از بازدید کارگاهی باش.'
  }[p.category] || '';

  const marketSection = liveResearch.searchSucceeded
    ? `نتایج زنده استعلام آگهی‌های مشابه دیوار/شیپور/باما و قیمت روز (${liveResearch.provider === 'serper' ? 'Serper.dev' : 'Google Search'} — تاریخ ${faDate} / ${enDate}):
---
${liveResearch.researchText}
---
قوانین الزامی قیمت‌گذاری و مقایسه:
- برای برآورد بازه واقعی (used_price_range) و قیمت مرجع (new_price_range)، **فقط و فقط** به آگهی‌ها و اعداد زنده بالا استناد کن و هرگز قیمت قدیمی از حافظه خودت نگو.
- آگهی‌های پرت (مثل کالای اوراقی یا قیمت صوری ۱ هزار تومانی) را از محاسبه بازه واقعی حذف کن.
- در آرایه market_comparison.comparables تا ۶ مورد از بهترین آگهی‌های واقعی دیوار، شیپور، باما یا کیلید را **دقیقاً با همان لینک اصلی موجود در نتایج بالا** بیاور (هرگز لینک نساز!).
- مراقب تفاوت تومان و ریال باش و همه اعداد را به «تومان» استاندارد کن.`
    : `توجه مهم درباره قیمت روز (${faDate}):
- استعلام زنده قیمت در این درخواست در دسترس نبود.
- به هیچ وجه قیمت قدیمی و منقضی از حافظه خودت اعلام نکن؛ در market_comparison مقادیر نامشخص بگذار و تمرکز را روی مشخصات تخصصی فرم، تله‌های کلاهبرداری، تصاویر و لحن فروشنده بگذار.`;

  return `تو کارشناس ارشد ضدکلاهبرداری و معاملات بازار ایران هستی (دیوار، شیپور، اینستاگرام، باما، تلگرام).
تاریخ امروز: ${faDate} (${enDate}).
${categoryExpertHint}

اطلاعات پایه پرونده:
- پلتفرم: ${PLATFORM_NAMES[p.platform] || p.platform}
- دسته‌بندی اصلی: ${CATEGORY_NAMES[p.category] || p.category}
- زیردسته انتخاب‌شده: ${p.subcategory || 'عمومی'}
- شناسه فروشنده/آگهی‌دهنده: ${p.sellerId || 'نامشخص'}
- وضعیت لیست سیاه مشترک: ${blNote}
- مبلغ/قیمت پیشنهادی: ${p.price || 'نامشخص'} تومان
- نشانه‌های مشکوک انتخاب‌شده: ${Array.isArray(p.quickFlags) && p.quickFlags.length ? p.quickFlags.join(' | ') : 'ندارد'}
${reverseNote ? `- ${reverseNote}` : ''}

مشخصات تخصصی تکمیل‌شده توسط کاربر:
${formattedDetails}

متن آگهی / لینک / خلاصه چت:
${p.rawText || 'ثبت نشده'}

${marketSection}

وظایف تو:
1. تمام مشخصات تخصصی بالا، زیردسته انتخاب‌شده و نتیجه ردیابی عکس (در صورت وجود) را در امتیازدهی ریسک و red_flags/green_flags دقیقاً لحاظ کن.
2. مبلغ پیشنهادی را با آگهی‌های مشابه زنده دیوار/شیپور/باما مقایسه کن و درصد اختلاف تقریبی با عرف (price_diff_percent؛ عدد منفی یعنی ارزان‌تر از عرف) را محاسبه کن.
3. تصاویر ضمیمه‌شده را برای نشانه‌های کپی، تناقض، یا جزئیات پروفایل بررسی کن.
4. خروجی را فقط و فقط به صورت یک آبجکت JSON معتبر فارسی برگردان (بدون هیچ متن اضافه بیرون از JSON):
{
  "risk_score": عدد صحیح 0 تا 100 (عدد بالاتر = خطر بیشتر),
  "verdict": "حکم کوتاه و صریح کارشناسی",
  "summary": "تحلیل شفاف در ۲ تا ۳ جمله (شامل مقایسه دقیق با عرف دیوار/شیپور در صورت وجود)",
  "scores": { "seller": 0-100, "visual": 0-100, "price": 0-100, "text": 0-100 },
  "red_flags": ["فهرست هشدارها و نکات مشکوک"],
  "green_flags": ["فهرست نکات مثبت و اطمینان‌بخش"],
  "verification_message": "پیام دقیق و مودبانه مچ‌گیری متناسب با همین پلتفرم، دسته‌بندی و زیردسته برای ارسال به آگهی‌دهنده",
  "checklist": ["چک‌لیست عملی بررسی حضوری و قبل از واریز وجه یا عقد قرارداد"],
  "market_comparison": {
    "product_detected": "عنوان دقیق کالا/ملک/خدمت",
    "new_price_range": "بازه قیمت نو/مرجع امروز به تومان (یا نامشخص)",
    "used_price_range": "بازه عرف دیوار و شیپور امروز به تومان (یا نامشخص)",
    "price_status": "زیر قیمت مشکوک | خوش‌قیمت | مناسب و منصفانه | گران‌تر از عرف | نامشخص",
    "price_diff_percent": عدد صحیح درصد اختلاف نسبت به میانه عرف (مثلاً -22 یا +10 یا null),
    "comparables": [
      {
        "title": "عنوان کوتاه آگهی مشابه",
        "site": "دیوار یا شیپور یا باما یا کیلید",
        "price_text": "قیمت به تومان (یا توافقی)",
        "condition_note": "نکته کوتاه از وضعیت/محله/شهر",
        "url": "لینک دقیق همان آگهی از نتایج بالا"
      }
    ]
  }
}`;
}

function buildFollowupPrompt(p) {
  const { faDate } = getTodayDates();
  return `تو کارآگاه و کارشناس ضدکلاهبرداری معاملات بازار ایران هستی. تاریخ امروز: ${faDate}.
اطلاعات پرونده قبلی:
- پلتفرم: ${PLATFORM_NAMES[p.platform] || p.platform} | دسته: ${CATEGORY_NAMES[p.category] || ''} ${p.subcategory ? `(${p.subcategory})` : ''} | فروشنده: ${p.sellerId || 'نامشخص'}
- شاخص ریسک قبلی: ${p.previousRisk ?? 50}%
پاسخ جدید آگهی‌دهنده (و تصویر ضمیمه در صورت وجود):
"${p.sellerReply || '(تصویر جدید ارسال شده است)'}"

بررسی کن آیا فروشنده در حال طفره‌رفتن، بهانه‌تراشی برای گرفتن بیعانه یا ارسال مدارک جعلی است یا پاسخ منطقی داده است.
فقط و فقط JSON معتبر فارسی برگردان:
{
  "updated_risk_score": عدد صحیح 0 تا 100,
  "analysis": "تحلیل دقیق پاسخ جدید فروشنده در ۲ تا ۳ جمله",
  "next_reply": "دقیق‌ترین پیام پیشنهادی بعدی برای ارسال به فروشنده"
}`;
}

function buildAutofillPrompt() {
  return `تو یک سیستم OCR و استخراج ساختاریافته آگهی‌های بازار ایران هستی (دیوار، شیپور، اینستاگرام، باما، تلگرام).
تصویر اسکرین‌شات ارسالی را با دقت بخوان و اطلاعات دیده‌شده را استخراج کن. اگر فیلدی در عکس مشخص نیست، مقدار آن را رشته خالی "" بگذار.
قوانین مهم:
- platform فقط یکی از مقادیر: "divar" | "instagram" | "bama" | "sheypoor" | "telegram"
- category فقط یکی از مقادیر: "real_estate" | "car" | "mobile" | "home" | "services" | "shop" | "entertainment" | "social" | "industrial" | "jobs"
- subcategory زیردسته دقیق فارسی (مثلاً "فروش مسکونی • آپارتمان"، "اجاره کوتاه‌مدت • ویلا و باغ"، "موبایل و تبلت"، "خودرو سواری"، "دورکاری و آنلاین")
- price فقط عدد انگلیسی به «تومان» (مثلاً "24500000")؛ اگر به ریال بود به تومان تبدیل کن.

فقط و فقط JSON معتبر با ساختار زیر برگردان:
{
  "platform": "divar",
  "category": "mobile",
  "subcategory": "",
  "sellerId": "آیدی پیج یا نام/شماره آگهی‌دهنده اگر در عکس هست",
  "price": "24500000",
  "rawText": "خلاصه دقیق متن و توضیحات کامل آگهی یا بیو/چت خوانده‌شده از عکس",
  "details": {
    "itemModel": "عنوان/مدل دقیق کالا یا ملک",
    "city": "نام شهر (مثلاً تهران)",
    "reNeighborhood": "نام محله اگر ملک بود",
    "reArea": "متراژ (فقط عدد) اگر ملک بود",
    "reBuildYear": "سال ساخت اگر ملک بود",
    "batteryHealth": "سلامت باتری اگر موبایل بود",
    "carMileage": "کارکرد کیلومتر (فقط عدد) اگر خودرو بود",
    "carInsurance": "مهلت بیمه اگر خودرو بود",
    "igFollowers": "تعداد فالوور اگر اینستاگرام بود",
    "jobCompany": "نام شرکت اگر آگهی استخدام بود"
  }
}`;
}

function buildReceiptCheckPrompt(expectedAmount, expectedBank) {
  const { faDate } = getTodayDates();
  return `تو کارشناس ارشد جرم‌شناسی دیجیتال و تشخیص «فیش واریز بانکی جعلی» در سیستم بانکی ایران (آپ، همراه بانک‌ها، بلوبانک، شاپرک، پایا/ساتنا، کارت‌به‌کارت) هستی.
تاریخ امروز: ${faDate}.
اطلاعات اعلامی فروشنده برای تطبیق:
- مبلغ مورد انتظار فروشنده: ${expectedAmount || 'وارد نشده'} تومان
- بانک/حساب مقصد فروشنده: ${expectedBank || 'وارد نشده'}

تصویر رسید ارسالی را با دقت میکروسکوپی بررسی کن:
1. ناهماهنگی فونت (مخلوط شدن فونت ایران‌سنس/وزیر با فونت پیش‌فرض، ضخامت غیرطبیعی ارقام مبلغ، کج یا خارج از تراز بودن ردیف‌ها، پس‌زمینه کدر یا آثار پاک‌کن/فتوشاپ زیر عدد مبلغ یا تاریخ).
2. ساختار منطقی رسیدهای ایرانی (تطابق ریال/تومان، منطقی بودن تاریخ و ساعت نسبت به امروز، فرمت استاندارد شماره پیگیری/مرجع و شماره کارت ماسک‌شده مثل 6037-99**-****-1234).
3. الگوهای معروف اپلیکیشن‌های «رسیدساز جعلی» (مثل فونت نامتعارف، غلط املایی، نبود کارمزد یا لوگوی بی‌کیفیت بانک).
4. تطابق مبلغ استخراج‌شده با مبلغ مورد انتظار فروشنده.

یادآوری مهم: حتی اگر ظاهر رسید تمیز بود، همیشه یادآوری کن که فروشنده باید فقط با پیامک رسمی بانک یا موجودی واقعی همراه‌بانک تحویل کالا را تایید کند.

فقط و فقط JSON معتبر فارسی برگردان:
{
  "fake_risk": عدد صحیح 0 تا 100 (عدد بالاتر = احتمال جعلی بودن بیشتر),
  "verdict": "حکم صریح درباره اصالت ظاهری فیش",
  "summary": "توضیح تخصصی در ۲ تا ۳ جمله",
  "extracted": {
    "amount": "مبلغ خوانده‌شده از فیش (با ذکر ریال/تومان)",
    "date_time": "تاریخ و ساعت خوانده‌شده از فیش",
    "bank_app": "نام بانک یا اپلیکیشن پرداخت",
    "tracking_code": "شماره پیگیری/ارجاع خوانده‌شده",
    "destination": "نام یا شماره کارت/شبای مقصد در فیش"
  },
  "red_flags": ["نشانه‌های مشکوک به جعل یا دستکاری"],
  "green_flags": ["مواردی که ظاهراً منطبق با استاندارد هستند"],
  "advice": "توصیه عملی فوری برای فروشنده قبل از تحویل کالا"
}`;
}

/* ============================================================================
   9. API ROUTES
   ============================================================================ */
app.get('/healthz', (req, res) => {
  const { faDate } = getTodayDates();
  res.json({
    ok: true,
    service: 'separ-kharid-pro-server',
    version: '8.0-full-categories-app',
    todayFa: faDate,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    serperConfigured: Boolean(SERPER_API_KEY),
    blacklistStorage: pgReady ? 'postgresql' : 'local-file',
    model: lastWorkingModel || GEMINI_MODEL || 'auto',
    searchGrounding: ENABLE_SEARCH_GROUNDING,
    uptimeSec: Math.round(process.uptime())
  });
});

app.get('/api/temp-img/:filename', (req, res) => {
  const token = String(req.params.filename || '').replace(/\.jpg$/i, '');
  if (!/^[a-f0-9]{40}$/i.test(token)) return res.status(404).end();
  const item = tempImageStore.get(token);
  if (!item || Date.now() > item.expiresAt) {
    tempImageStore.delete(token);
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(item.buffer);
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
      serperConfigured: Boolean(SERPER_API_KEY),
      blacklistStorage: pgReady ? 'postgresql' : 'local-file',
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

app.get('/api/test-gemini', verifyToken, async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY تنظیم نشده است.' });
  }
  try {
    const orderedModels = await getOrderedModels();
    const jsonResult = await callGeminiJson('فقط این JSON را برگردان: {"status":"ok"}', [], orderedModels);

    let searchOk = false;
    let searchProvider = 'none';
    let searchSourcesCount = 0;
    let searchNote = 'SERPER_API_KEY تنظیم نشده است';

    if (SERPER_API_KEY) {
      try {
        const sData = await querySerper('site:divar.ir/v/ آیفون 13', 3, { tbs: 'qdr:m' });
        const organicCount = Array.isArray(sData?.organic) ? sData.organic.length : 0;
        searchOk = organicCount > 0;
        searchProvider = 'serper';
        searchSourcesCount = organicCount;
        searchNote = searchOk
          ? `Serper.dev + Lens متصل است (${organicCount} آگهی تازه از دیوار دریافت شد)`
          : 'Serper پاسخی برنگرداند';
      } catch (sErr) {
        searchNote = `خطای Serper.dev: ${sErr.message.slice(0, 120)}`;
      }
    } else if (ENABLE_SEARCH_GROUNDING) {
      try {
        const { faDate } = getTodayDates();
        const sRes = await invokeGeminiRaw(jsonResult.usedModel, `تاریخ امروز ${faDate} است. با Google Search قیمت امروز یک گوشی سامسونگ در ایران را در یک خط بگو.`, [], {
          useSearch: true,
          expectJson: false,
          timeoutMs: 18000
        });
        searchSourcesCount = sRes.sources.length;
        searchOk = sRes.sources.length > 0 || sRes.searchQueries.length > 0;
        searchProvider = searchOk ? 'gemini' : 'none';
        searchNote = searchOk ? 'جستجوی زنده داخلی جمینی فعال است' : 'سرچ داخلی جمینی روی این کلید فعال نشد';
      } catch (sErr) {
        searchNote = `خطای سرچ داخلی جمینی: ${sErr.message.slice(0, 100)}`;
      }
    }

    const dbTag = pgReady ? ' • 🗄️ Postgres' : '';
    const searchBadge = searchOk
      ? (searchProvider === 'serper' ? ' • 🌐 Serper + Lens فعال' : ' • 🌐 سرچ جمینی فعال')
      : ' • ⚠️ بدون سرچ زنده';

    return res.json({
      ok: true,
      usedModel: `${jsonResult.usedModel}${searchBadge}${dbTag}`,
      searchOk,
      searchProvider,
      searchSourcesCount,
      searchNote,
      blacklistStorage: pgReady ? 'postgresql' : 'local-file',
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

app.post('/api/autofill', rateLimiter, verifyToken, async (req, res) => {
  try {
    const img = String(req.body?.image || '');
    if (img.length < 100) {
      return res.status(400).json({ error: 'تصویر معتبری ارسال نشده است.' });
    }
    const orderedModels = await getOrderedModels();
    const { parsed, usedModel } = await callGeminiJson(buildAutofillPrompt(), [img], orderedModels);

    const allowedPlatforms = Object.keys(PLATFORM_NAMES);
    const allowedCategories = Object.keys(CATEGORY_NAMES);

    return res.json({
      ok: true,
      usedModel,
      platform: allowedPlatforms.includes(parsed.platform) ? parsed.platform : 'divar',
      category: allowedCategories.includes(parsed.category) ? parsed.category : 'mobile',
      subcategory: String(parsed.subcategory || '').trim().slice(0, 70),
      sellerId: String(parsed.sellerId || '').trim().slice(0, 80),
      price: toEnDigits(String(parsed.price || '')).replace(/[^\d]/g, '').slice(0, 15),
      rawText: String(parsed.rawText || '').trim().slice(0, 1800),
      details: (parsed.details && typeof parsed.details === 'object') ? parsed.details : {}
    });
  } catch (err) {
    console.error('Autofill Error:', err.message);
    if (err.message === 'MISSING_API_KEY') {
      return res.status(500).json({ error: 'کلید GEMINI_API_KEY روی سرور تنظیم نشده است.' });
    }
    return res.status(502).json({ error: formatReadableError(err) });
  }
});

app.post('/api/reverse-image', rateLimiter, verifyToken, async (req, res) => {
  try {
    const img = String(req.body?.image || '');
    if (img.length < 100) {
      return res.status(400).json({ error: 'تصویر معتبری ارسال نشده است.' });
    }
    const result = await runReverseImageLookup(img, req);
    return res.json(result);
  } catch (err) {
    console.error('Reverse Image Error:', err.message);
    return res.status(502).json({ checked: false, message: 'خطا در بررسی معکوس تصویر.' });
  }
});

app.post('/api/check-receipt', rateLimiter, verifyToken, async (req, res) => {
  try {
    const body = req.body || {};
    const img = String(body.image || '');
    if (img.length < 100) {
      return res.status(400).json({ error: 'تصویر فیش بانکی ارسال نشده است.' });
    }
    const orderedModels = await getOrderedModels();
    const prompt = buildReceiptCheckPrompt(body.expectedAmount, body.expectedBank);
    const { parsed, usedModel } = await callGeminiJson(prompt, [img], orderedModels);

    return res.json({
      ok: true,
      usedModel,
      fake_risk: Math.max(0, Math.min(100, Number(parsed.fake_risk) || 50)),
      verdict: String(parsed.verdict || 'نتیجه بررسی فیش'),
      summary: String(parsed.summary || ''),
      extracted: (parsed.extracted && typeof parsed.extracted === 'object') ? parsed.extracted : {},
      red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags.map(String) : [],
      green_flags: Array.isArray(parsed.green_flags) ? parsed.green_flags.map(String) : [],
      advice: String(parsed.advice || 'پیش از تحویل کالا، حتماً واریز وجه را از طریق پیامک رسمی بانک یا موجودی واقعی همراه‌بانک چک کنید.')
    });
  } catch (err) {
    console.error('Receipt Check Error:', err.message);
    if (err.message === 'MISSING_API_KEY') {
      return res.status(500).json({ error: 'کلید GEMINI_API_KEY روی سرور تنظیم نشده است.' });
    }
    return res.status(502).json({ error: formatReadableError(err) });
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
        serperConfigured: Boolean(SERPER_API_KEY),
        blacklistStorage: pgReady ? 'postgresql' : 'local-file',
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

    const blRecord = await getBlacklistEntry(body.sellerId || '');
    const firstImg = Array.isArray(body.images) && body.images.length > 0 ? body.images[0] : '';

    const [liveResearch, reverseImageRes] = await Promise.all([
      runLiveMarketResearch(body, orderedModels),
      (firstImg && SERPER_API_KEY)
        ? runReverseImageLookup(firstImg, req).catch(() => ({ checked: false }))
        : Promise.resolve({ checked: false })
    ]);

    const prompt = buildAnalyzePrompt(body, blRecord, liveResearch, reverseImageRes);
    const { parsed, usedModel } = await callGeminiJson(prompt, body.images || [], orderedModels);

    const marketComparison = sanitizeMarketComparison(
      parsed.market_comparison,
      liveResearch.rawComparables,
      liveResearch.productName
    );

    const compCount = marketComparison?.comparables?.length || 0;
    const statusTag = liveResearch.searchSucceeded
      ? (compCount > 0 ? `🌐 مقایسه با ${compCount} آگهی زنده` : '🌐 قیمت زنده')
      : '⚠️ بدون سرچ زنده';

    return res.json({
      ...parsed,
      market_comparison: marketComparison,
      reverse_image: reverseImageRes && reverseImageRes.checked ? reverseImageRes : null,
      sources: liveResearch.sources,
      liveSearchUsed: liveResearch.searchSucceeded,
      searchProvider: liveResearch.provider,
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

app.get(['/api/blacklist', '/webhook/blacklist'], verifyToken, async (req, res) => {
  try {
    const entry = await getBlacklistEntry(req.query.sellerId || '');
    if (!entry) {
      return res.json({ found: false, blacklisted: false, reports: 0, storage: pgReady ? 'postgresql' : 'local-file' });
    }
    return res.json({
      found: true,
      blacklisted: true,
      reports: entry.reports || 1,
      reason: entry.reason || 'گزارش‌شده توسط کاربران',
      lastReported: entry.lastReported,
      storage: pgReady ? 'postgresql' : 'local-file'
    });
  } catch (err) {
    return res.status(500).json({ found: false, error: err.message });
  }
});

app.post(['/api/blacklist', '/webhook/blacklist'], rateLimiter, verifyToken, async (req, res) => {
  try {
    const body = req.body || {};
    const sellerId = normalizeSellerId(body.sellerId || '');
    if (sellerId.length < 3) {
      return res.status(400).json({ error: 'شناسه فروشنده معتبر نیست.' });
    }
    const result = await upsertBlacklistEntry({
      sellerId,
      platform: body.platform,
      reason: body.reason,
      date: body.date
    });
    return res.json({ ok: true, reports: result.reports, storage: result.storage });
  } catch (err) {
    return res.status(500).json({ error: 'خطا در ثبت لیست سیاه سرور' });
  }
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
  console.log(`Separ Kharid Pro server v8 (Full Categories + App Suite) running on port ${PORT}`);
});
