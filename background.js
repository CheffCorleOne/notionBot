// Service worker (module). Вся логика и сетевые запросы живут здесь —
// host_permissions на notion / openrouter / kgd избавляют от CORS в этом контексте.

const NOTION_VERSION = "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_API = "https://api.openai.com/v1/chat/completions";
const OFFSCREEN_DOCUMENT = "offscreen.html";
const PDF_CHANNEL = "notionbot-pdf-text";
const MAX_TEXT_CHARS = 12000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PDF_RENDER_TIMEOUT_MS = 45000;

// Пауза между запросами к Notion (лимит ~3 req/sec).
const RATE_LIMIT_MS = 400;

// «Последние N строк» отсчитываются так же, как их видит пользователь в таблице:
// view отсортирован по этой колонке по убыванию, берём верхние N строк.
const SORT_COLUMN = "Дата оплаты";
const SORT_DIRECTION = "descending";

// Значения по умолчанию для настроек.
const DEFAULTS = {
  fileColumn: "Счет",
  resultColumn: "Налоговый режим",
  vatColumn: "Плательщик НДС",
  recentRowsLimit: 50,
  provider: "openrouter",
  openrouterModel: "google/gemma-4-31b-it:free",
  openaiModel: "gpt-4o-mini",
  portalHost: "https://portal.kgd.gov.kz",
};

// Цепочка запасных моделей OpenRouter — только бесплатные (все с vision).
// Если основная модель не отвечает (сеть / не-200 / пустой или невалидный
// ответ) — пробуем следующую. Модель из настроек всегда идёт первой; если она
// совпадает с одной из цепочки, дубль убирается (dedupe в textModels/visionModels).
const FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

const VISION_FALLBACK_MODELS = FALLBACK_MODELS;

// Модели OpenAI (используются, если в настройках выбран провайдер OpenAI и указан
// его API-ключ). Все они мультимодальные — умеют читать изображения (vision),
// поэтому один список работает и для текста, и для сканов/фото.
const OPENAI_FALLBACK_MODELS = ["gpt-4o-mini", "gpt-4o"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let creatingOffscreenDocument = null;
let pdfRequestCounter = 0;
let keepAliveTimer = null;

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 15000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ---------------------------------------------------------------------------
// Точка входа: сообщение от content.js по клику на плавающую кнопку.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "START_CHECK") {
    (async () => {
      let tabId;
      try {
        tabId = await resolveTabId(sender);
        if (tabId == null) {
          throw new Error("не удалось определить вкладку Notion");
        }
        startKeepAlive();
        progress(tabId, { stage: "start", text: "Запуск..." });
        await runBatch(tabId);
      } catch (err) {
        progress(tabId, { stage: "error", text: `Ошибка: ${String(err?.message || err)}` });
      } finally {
        stopKeepAlive();
      }
    })();
    sendResponse({ ok: true, started: true });
    return false;
  }
});

async function resolveTabId(sender) {
  if (sender.tab?.id != null) return sender.tab.id;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const notionTab = tabs.find((tab) => /notion\.(so|com)/.test(tab.url || ""));
  return notionTab?.id ?? tabs[0]?.id;
}

function progress(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "PROGRESS", ...payload }).catch(() => {});
}

function makeReporter(tabId, base) {
  return (text) => {
    if (!text) return;
    progress(tabId, { stage: "processing", text: base ? `${base}: ${text}` : text });
  };
}

function textModels(cfg) {
  if (cfg.provider === "openai") {
    return dedupe([cfg.openaiModel, ...OPENAI_FALLBACK_MODELS].filter(Boolean));
  }
  return dedupe([cfg.openrouterModel, ...FALLBACK_MODELS].filter(Boolean));
}

function visionModels(cfg) {
  if (cfg.provider === "openai") {
    return dedupe([cfg.openaiModel, ...OPENAI_FALLBACK_MODELS].filter(Boolean));
  }
  return dedupe([cfg.openrouterModel, ...VISION_FALLBACK_MODELS].filter(Boolean));
}

// ---------------------------------------------------------------------------
// Основной сценарий: пройти по всем необработанным строкам базы.
// ---------------------------------------------------------------------------
async function runBatch(tabId) {
  const cfg = await loadConfig();

  progress(tabId, { stage: "start", text: "Подготовка..." });

  try {
    await ensureOffscreenDocument();
  } catch {
    // pdf.js недоступен — продолжим, упадём позже при чтении PDF
  }

  progress(tabId, { stage: "start", text: "Проверяю базу Notion..." });
  await ensureResultColumns(cfg);

  progress(tabId, { stage: "start", text: "Ищу необработанные счета..." });
  const pages = await queryPendingPages(cfg);
  const total = pages.length;

  if (total === 0) {
    progress(tabId, { stage: "done", text: `В последних ${cfg.recentRowsLimit} строках нет новых счетов для обработки.` });
    return { total: 0, done: 0, errors: 0 };
  }

  progress(tabId, { stage: "start", text: `Найдено ${total} счетов, начинаю...` });

  let done = 0;
  let errors = 0;

  for (let i = 0; i < total; i++) {
    const page = pages[i];
    const rowLabel = `Обрабатываю ${i + 1}/${total}`;
    progress(tabId, { stage: "processing", current: i + 1, total, text: `${rowLabel}...` });

    let result;
    try {
      result = await processPage(page, cfg, makeReporter(tabId, rowLabel));
    } catch (err) {
      const error = `Ошибка: ${String(err?.message || err)}`;
      result = { taxMode: error, vatStatus: error };
      errors++;
    }

    progress(tabId, { stage: "processing", current: i + 1, total, text: `${rowLabel}: записываю в Notion...` });

    try {
      await writeResult(page, cfg, result);
    } catch (err) {
      errors++;
    }
    done++;

    await sleep(RATE_LIMIT_MS);
  }

  progress(tabId, { stage: "done", text: `Готово: ${done}/${total}${errors ? `, ошибок: ${errors}` : ""}.` });
  return { total, done, errors };
}

// ---------------------------------------------------------------------------
// Обработка одной строки: вложения → текст/vision → БИН поставщика → КГД → результаты.
// ---------------------------------------------------------------------------
async function processPage(page, cfg, report) {
  const files = extractFiles(page, cfg.fileColumn);
  if (!files.length) return errorResult("Ошибка: файл счёта не найден в колонке");

  let lastProblem = "";
  for (const file of files) {
    let attachment;
    try {
      report?.("скачиваю файл");
      attachment = await downloadAttachment(file);
      const { xin, confidence, note } = await extractSupplierXinFromAttachment(attachment, cfg, report);
      if (!xin) {
        lastProblem = note
          ? `БИН поставщика не найден (${attachment.name}): ${note}`
          : `БИН поставщика не найден (${attachment.name})`;
        continue;
      }

      report?.("запрос в КГД");
      const kgd = await fetchCounterpartyData(xin, cfg);
      if (kgd.error) return errorResult(kgd.error);

      const confidenceNote = confidence && confidence !== "high" ? ` (уверенность: ${confidence})` : "";
      return {
        taxMode: `${kgd.taxMode}${confidenceNote}`,
        vatStatus: `${kgd.vatStatus}${confidenceNote}`,
      };
    } catch (err) {
      lastProblem = `${attachment?.name || file.name || "файл"}: ${String(err?.message || err)}`;
    }
  }

  return errorResult(`Ошибка: ${lastProblem || "не удалось обработать прикреплённые файлы"}`);
}

function errorResult(message) {
  return { taxMode: message, vatStatus: message };
}

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
async function loadConfig() {
  const stored = await chrome.storage.local.get(null);
  const cfg = { ...DEFAULTS, ...stored };

  cfg.provider = cfg.provider === "openai" ? "openai" : "openrouter";

  const missing = [];
  if (!cfg.notionToken) missing.push("Notion Integration Token");
  if (!cfg.databaseId) missing.push("ID базы данных Notion");
  if (cfg.provider === "openai") {
    if (!cfg.openaiKey) missing.push("OpenAI API Key");
  } else if (!cfg.openrouterKey) {
    missing.push("OpenRouter API Key");
  }
  if (!cfg.portalToken) missing.push("X-Portal-Token (КГД)");
  if (missing.length) {
    throw new Error(`Заполните настройки: ${missing.join(", ")}`);
  }
  cfg.databaseId = normalizeId(cfg.databaseId);
  cfg.ownXin = onlyDigits(cfg.ownXin || "");
  cfg.recentRowsLimit = parseRecentRowsLimit(cfg.recentRowsLimit);
  return cfg;
}

function normalizeId(id) {
  const clean = String(id).replace(/-/g, "").trim();
  // 32-символьный id → в дефисный формат UUID (Notion принимает оба, но нормализуем).
  if (/^[0-9a-fA-F]{32}$/.test(clean)) {
    return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
  }
  return String(id).trim();
}

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");

function parseRecentRowsLimit(value) {
  const n = Number.parseInt(String(value ?? DEFAULTS.recentRowsLimit), 10);
  if (!Number.isFinite(n)) return DEFAULTS.recentRowsLimit;
  return Math.min(Math.max(n, 1), 1000);
}

// ---------------------------------------------------------------------------
// Notion API
// ---------------------------------------------------------------------------
function notionHeaders(cfg) {
  return {
    Authorization: `Bearer ${cfg.notionToken}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function ensureResultColumns(cfg) {
  const res = await fetch(`${NOTION_API}/databases/${cfg.databaseId}`, {
    method: "GET",
    headers: notionHeaders(cfg),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Notion: не удалось прочитать базу (${res.status}). ${body}`);
  }
  const db = await res.json();

  if (!db.properties?.[cfg.fileColumn]) {
    throw new Error(`В базе нет колонки с файлом «${cfg.fileColumn}» — проверьте название в настройках`);
  }
  if (cfg.resultColumn === cfg.vatColumn) {
    throw new Error("Названия колонок налогового режима и НДС должны отличаться");
  }

  const properties = {};
  if (!db.properties?.[cfg.resultColumn]) properties[cfg.resultColumn] = { rich_text: {} };
  if (!db.properties?.[cfg.vatColumn]) properties[cfg.vatColumn] = { rich_text: {} };
  if (!Object.keys(properties).length) return;

  const patch = await fetch(`${NOTION_API}/databases/${cfg.databaseId}`, {
    method: "PATCH",
    headers: notionHeaders(cfg),
    body: JSON.stringify({ properties }),
  });
  if (!patch.ok) {
    const body = await safeText(patch);
    throw new Error(`Notion: не удалось создать колонки результата (${patch.status}). ${body}`);
  }
}

async function queryPendingPages(cfg) {
  const recentPages = [];
  let cursor;
  do {
    const remaining = cfg.recentRowsLimit - recentPages.length;
    if (remaining <= 0) break;

    const body = {
      page_size: Math.min(100, remaining),
      sorts: [{ property: SORT_COLUMN, direction: SORT_DIRECTION }],
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`${NOTION_API}/databases/${cfg.databaseId}/query`, {
      method: "POST",
      headers: notionHeaders(cfg),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await safeText(res);
      if (res.status === 400 && errText.includes(SORT_COLUMN)) {
        throw new Error(
          `Notion: в базе нет колонки «${SORT_COLUMN}», по которой сортируются строки. ` +
            `Переименуйте колонку с датой оплаты в «${SORT_COLUMN}» или измените SORT_COLUMN в background.js.`
        );
      }
      throw new Error(`Notion: ошибка запроса строк (${res.status}). ${errText}`);
    }
    const data = await res.json();
    recentPages.push(...(data.results || []));
    cursor = data.has_more && recentPages.length < cfg.recentRowsLimit ? data.next_cursor : undefined;
    if (cursor) await sleep(RATE_LIMIT_MS);
  } while (cursor);

  return recentPages.filter((page) => {
    const fileProp = page.properties?.[cfg.fileColumn];
    const resultProp = page.properties?.[cfg.resultColumn];
    const vatProp = page.properties?.[cfg.vatColumn];
    return hasFiles(fileProp) && (isEmptyNotionProperty(resultProp) || isEmptyNotionProperty(vatProp));
  });
}

function hasFiles(prop) {
  return Array.isArray(prop?.files) && prop.files.length > 0;
}

function isEmptyNotionProperty(prop) {
  if (!prop) return true;
  switch (prop.type) {
    case "rich_text":
      return !prop.rich_text?.length;
    case "title":
      return !prop.title?.length;
    case "files":
      return !prop.files?.length;
    case "multi_select":
      return !prop.multi_select?.length;
    case "select":
      return !prop.select;
    case "date":
      return !prop.date;
    case "number":
      return prop.number == null;
    case "email":
      return !prop.email;
    case "phone_number":
      return !prop.phone_number;
    case "url":
      return !prop.url;
    case "checkbox":
      return prop.checkbox !== true;
    default:
      return false;
  }
}

function extractFiles(page, fileColumn) {
  const prop = page.properties?.[fileColumn];
  if (!Array.isArray(prop?.files)) return [];

  return prop.files
    .map((file) => {
      const url = file.file?.url || file.external?.url || null;
      return {
        name: file.name || filenameFromUrl(url) || "attachment",
        url,
      };
    })
    .filter((file) => file.url);
}

function filenameFromUrl(url) {
  if (!url) return "";
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

async function writeResult(page, cfg, result) {
  const properties = {};
  if (isEmptyNotionProperty(page.properties?.[cfg.resultColumn])) {
    properties[cfg.resultColumn] = richTextValue(result.taxMode);
  }
  if (isEmptyNotionProperty(page.properties?.[cfg.vatColumn])) {
    properties[cfg.vatColumn] = richTextValue(result.vatStatus);
  }
  if (!Object.keys(properties).length) return;

  const res = await fetch(`${NOTION_API}/pages/${page.id}`, {
    method: "PATCH",
    headers: notionHeaders(cfg),
    body: JSON.stringify({
      properties,
    }),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Notion: не удалось записать результат (${res.status}). ${body}`);
  }
}

function richTextValue(text) {
  return { rich_text: [{ type: "text", text: { content: String(text).slice(0, 1900) } }] };
}

// ---------------------------------------------------------------------------
// Вложения → текст. PDF.js работает в offscreen-документе, потому что в MV3
// service worker нельзя использовать fallback PDF.js через dynamic import().
// ---------------------------------------------------------------------------
async function downloadAttachment(file) {
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`не удалось скачать файл (${res.status})`);

  const contentType = normalizeContentType(res.headers.get("Content-Type"));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const name = file.name || filenameFromUrl(file.url) || "attachment";
  return {
    ...file,
    name,
    bytes,
    contentType,
    ext: extensionFromName(name),
  };
}

function normalizeContentType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

function extensionFromName(name) {
  const clean = String(name || "").split("?")[0].split("#")[0];
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

async function extractSupplierXinFromAttachment(attachment, cfg, report) {
  const kind = detectAttachmentKind(attachment);

  if (kind === "image") {
    report?.("распознаю изображение (AI)");
    return extractSupplierXinFromImage(attachment, cfg, report);
  }

  let text = "";
  let localError = "";
  try {
    if (kind === "pdf") report?.("читаю PDF");
    else report?.("извлекаю текст файла");
    text = await extractAttachmentText(attachment, kind);
  } catch (err) {
    localError = String(err?.message || err);
  }

  if (isReadableText(text)) {
    report?.("ищу БИН в тексте (AI)");
    const result = await extractSupplierXin(text, cfg);
    if (result.xin) return result;
  }

  if (canUseVisionFallback(kind, attachment)) {
    report?.(kind === "pdf" ? "распознаю скан PDF (AI vision)" : "распознаю файл (AI vision)");
    return extractSupplierXinViaVision(attachment, cfg, kind, report);
  }

  throw new Error(localError || "не удалось распознать текст файла");
}

function detectAttachmentKind(attachment) {
  const bytes = attachment.bytes;
  if (looksLikeImage(bytes)) return "image";
  if (looksLikePdf(bytes)) return "pdf";
  if (isImageAttachment(attachment)) return "image";
  if (isPdfAttachment(attachment)) return "pdf";
  if (isSpreadsheetAttachment(attachment)) return "spreadsheet";
  if (isDocxAttachment(attachment)) return "docx";
  if (isTextAttachment(attachment)) return "text";
  if (attachment.ext === "xls") return "spreadsheet";
  return "unknown";
}

function looksLikePdf(bytes) {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function looksLikeImage(bytes) {
  if (bytes.length < 4) return false;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return true;
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function isReadableText(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.length < 10) return false;
  const alnum = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
  return alnum / trimmed.length >= 0.2;
}

function canUseVisionFallback(kind, attachment) {
  return kind === "pdf" || kind === "image" || looksLikePdf(attachment.bytes) || looksLikeImage(attachment.bytes);
}

async function extractAttachmentText(attachment, kind) {
  const k = kind || detectAttachmentKind(attachment);
  if (k === "pdf") return extractPdfText(attachment.bytes);
  if (k === "spreadsheet") return extractSpreadsheetText(attachment);
  if (k === "docx") return extractDocxText(attachment.bytes);
  if (k === "text") return decodeTextBytes(attachment.bytes);

  if (attachment.ext === "xls") {
    const text = extractReadableBinaryStrings(attachment.bytes);
    if (text.trim().length >= 10) return text;
  }

  throw new Error(`неподдерживаемый тип файла ${attachment.ext ? `.${attachment.ext}` : attachment.contentType || ""}`);
}

function isPdfAttachment({ contentType, ext }) {
  return contentType === "application/pdf" || ext === "pdf";
}

function isImageAttachment({ contentType, ext }) {
  return (
    contentType.startsWith("image/") ||
    ["jpg", "jpeg", "jfif", "png", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "heif"].includes(ext)
  );
}

function isSpreadsheetAttachment({ contentType, ext }) {
  return (
    ["xlsx", "xlsm", "xltx", "xltm", "csv", "tsv"].includes(ext) ||
    contentType.includes("spreadsheet") ||
    contentType.includes("excel") ||
    contentType === "text/csv" ||
    contentType === "text/tab-separated-values"
  );
}

function isDocxAttachment({ contentType, ext }) {
  return ext === "docx" || contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function isTextAttachment({ contentType, ext }) {
  return contentType.startsWith("text/") || ["txt", "csv", "tsv", "xml", "html", "htm"].includes(ext);
}

async function extractPdfText(bytes) {
  await ensureOffscreenDocument();

  const id = `pdf-${Date.now()}-${++pdfRequestCounter}`;
  const channel = new BroadcastChannel(PDF_CHANNEL);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("PDF: тайм-аут извлечения текста"));
    }, 120000);

    function cleanup() {
      clearTimeout(timeout);
      channel.removeEventListener("message", onMessage);
      channel.close();
    }

    function onMessage(event) {
      const msg = event.data;
      if (msg?.type !== "PDF_TEXT_RESULT" || msg.id !== id) return;

      cleanup();
      if (msg.ok) {
        resolve(msg.text || "");
      } else {
        reject(new Error(msg.error || "PDF: не удалось извлечь текст"));
      }
    }

    channel.addEventListener("message", onMessage);
    channel.postMessage({ type: "EXTRACT_PDF_TEXT", id, buffer });
  });
}

async function renderPdfToImages(bytes) {
  await ensureOffscreenDocument();

  const id = `pdf-img-${Date.now()}-${++pdfRequestCounter}`;
  const channel = new BroadcastChannel(PDF_CHANNEL);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("PDF: тайм-аут рендера страниц"));
    }, PDF_RENDER_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      channel.removeEventListener("message", onMessage);
      channel.close();
    }

    function onMessage(event) {
      const msg = event.data;
      if (msg?.type !== "PDF_IMAGES_RESULT" || msg.id !== id) return;

      cleanup();
      if (msg.ok) {
        resolve(Array.isArray(msg.images) ? msg.images : []);
      } else {
        reject(new Error(msg.error || "PDF: не удалось отрендерить страницы"));
      }
    }

    channel.addEventListener("message", onMessage);
    channel.postMessage({ type: "RENDER_PDF_TO_IMAGES", id, buffer });
  });
}

async function extractSpreadsheetText(attachment) {
  if (["csv", "tsv"].includes(attachment.ext) || attachment.contentType === "text/csv") {
    return normalizeDelimitedText(decodeTextBytes(attachment.bytes), attachment.ext === "tsv" ? "\t" : ",");
  }

  if (["xlsx", "xlsm", "xltx", "xltm"].includes(attachment.ext) || attachment.contentType.includes("spreadsheet")) {
    return extractXlsxText(attachment.bytes);
  }

  if (attachment.ext === "xls") {
    return extractReadableBinaryStrings(attachment.bytes);
  }

  throw new Error(`неподдерживаемый формат таблицы .${attachment.ext || "unknown"}`);
}

function normalizeDelimitedText(text, delimiter) {
  return text
    .split(/\r?\n/)
    .slice(0, 250)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()).filter(Boolean).join(" | "))
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);
}

async function extractDocxText(bytes) {
  const entries = await readZipTextEntries(bytes, ["word/document.xml"]);
  const xml = entries["word/document.xml"];
  if (!xml) throw new Error("не удалось прочитать DOCX");

  return extractXmlText(xml).slice(0, MAX_TEXT_CHARS);
}

async function extractXlsxText(bytes) {
  const entries = await readZipTextEntries(bytes);
  const sharedStrings = parseSharedStrings(entries["xl/sharedStrings.xml"] || "");
  const sheetNames = parseWorkbookSheetNames(entries);
  const sheetPaths = Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (!sheetPaths.length) throw new Error("не удалось найти листы XLSX");

  const chunks = [];
  for (let i = 0; i < sheetPaths.length; i++) {
    const path = sheetPaths[i];
    const sheetText = parseWorksheetText(entries[path], sharedStrings);
    if (!sheetText) continue;
    chunks.push(`Лист: ${sheetNames[path] || `sheet${i + 1}`}\n${sheetText}`);
    if (chunks.join("\n\n").length >= MAX_TEXT_CHARS) break;
  }

  return chunks.join("\n\n").slice(0, MAX_TEXT_CHARS);
}

async function readZipTextEntries(bytes, wantedNames = null) {
  const wanted = wantedNames ? new Set(wantedNames) : null;
  const entries = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findZipEndOfCentralDirectory(view);
  if (eocdOffset < 0) throw new Error("некорректный ZIP/XLSX файл");

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("некорректная структура ZIP");

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));

    if (!wanted || wanted.has(name) || isUsefulOfficeXml(name)) {
      const fileBytes = await readZipEntryBytes(bytes, localHeaderOffset, compressedSize, method);
      entries[name] = decodeUtf8(fileBytes);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function isUsefulOfficeXml(name) {
  return (
    name === "xl/sharedStrings.xml" ||
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    /^xl\/worksheets\/sheet\d+\.xml$/i.test(name) ||
    name === "word/document.xml"
  );
}

function findZipEndOfCentralDirectory(view) {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function readZipEntryBytes(bytes, localHeaderOffset, compressedSize, method) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
    throw new Error("некорректный локальный ZIP-заголовок");
  }

  const nameLength = view.getUint16(localHeaderOffset + 26, true);
  const extraLength = view.getUint16(localHeaderOffset + 28, true);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = bytes.slice(dataStart, dataStart + compressedSize);

  if (method === 0) return compressed;
  if (method === 8) return inflateRaw(compressed);
  throw new Error(`неподдерживаемое сжатие ZIP (${method})`);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("браузер не поддерживает распаковку XLSX");
  }

  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

function parseSharedStrings(xml) {
  const strings = [];
  for (const match of xml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    strings.push(extractXmlText(match[0]));
  }
  return strings;
}

function parseWorkbookSheetNames(entries) {
  const workbookXml = entries["xl/workbook.xml"] || "";
  const relsXml = entries["xl/_rels/workbook.xml.rels"] || "";
  const rels = {};
  const names = {};

  for (const match of relsXml.matchAll(/<Relationship\b([^>]+)>/g)) {
    const attrs = parseXmlAttributes(match[1]);
    if (!attrs.Id || !attrs.Target) continue;
    rels[attrs.Id] = normalizeWorkbookTarget(attrs.Target);
  }

  for (const match of workbookXml.matchAll(/<sheet\b([^>]+)>/g)) {
    const attrs = parseXmlAttributes(match[1]);
    const relId = attrs["r:id"] || attrs.id;
    if (relId && rels[relId]) names[rels[relId]] = attrs.name || relId;
  }

  return names;
}

function normalizeWorkbookTarget(target) {
  const clean = String(target || "").replace(/^\/+/, "");
  if (clean.startsWith("xl/")) return clean;
  if (clean.startsWith("worksheets/")) return `xl/${clean}`;
  return `xl/${clean}`;
}

function parseWorksheetText(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = parseXmlAttributes(cellMatch[1]);
      const body = cellMatch[2];
      let value = "";

      if (attrs.t === "s") {
        const index = Number.parseInt(extractXmlTagValue(body, "v"), 10);
        value = Number.isFinite(index) ? sharedStrings[index] || "" : "";
      } else if (attrs.t === "inlineStr") {
        value = extractXmlText(body);
      } else {
        value = extractXmlTagValue(body, "v") || extractXmlText(body);
      }

      value = String(value).replace(/\s+/g, " ").trim();
      if (value) cells.push(value);
    }

    if (cells.length) rows.push(cells.join(" | "));
    if (rows.length >= 250) break;
  }

  return rows.join("\n");
}

function parseXmlAttributes(source) {
  const attrs = {};
  for (const match of String(source || "").matchAll(/([:\w-]+)=["']([^"']*)["']/g)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function extractXmlText(xml) {
  const parts = [];
  for (const match of String(xml || "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
    parts.push(decodeXml(match[1]));
  }
  if (parts.length) return parts.join(" ").replace(/\s+/g, " ").trim();
  return decodeXml(String(xml || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractXmlTagValue(xml, tagName) {
  const match = String(xml || "").match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? decodeXml(match[1]).trim() : "";
}

function decodeXml(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeTextBytes(bytes) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!utf8.includes("\uFFFD")) return utf8.slice(0, MAX_TEXT_CHARS);
  return new TextDecoder("windows-1251", { fatal: false }).decode(bytes).slice(0, MAX_TEXT_CHARS);
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function extractReadableBinaryStrings(bytes) {
  const asciiParts = [];
  let ascii = "";

  for (const byte of bytes) {
    if (byte >= 32 && byte <= 126) {
      ascii += String.fromCharCode(byte);
    } else {
      if (ascii.length >= 4) asciiParts.push(ascii);
      ascii = "";
    }
  }
  if (ascii.length >= 4) asciiParts.push(ascii);

  const utf16Parts = [];
  let utf16 = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (isPrintableCodePoint(code)) {
      utf16 += String.fromCharCode(code);
    } else {
      if (utf16.length >= 4) utf16Parts.push(utf16);
      utf16 = "";
    }
  }
  if (utf16.length >= 4) utf16Parts.push(utf16);

  return dedupe([...utf16Parts, ...asciiParts])
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);
}

function isPrintableCodePoint(code) {
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x04ff);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function mimeFromExtension(ext) {
  switch (ext) {
    case "jpg":
    case "jpeg":
    case "jfif":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "avif":
      return "image/avif";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    default:
      return "";
  }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("PDF: текущий Chrome не поддерживает offscreen-документы");
  }

  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  if ("getContexts" in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    if (contexts.length > 0) return;
  } else {
    const matchedClients = await self.clients.matchAll();
    if (matchedClients.some((client) => client.url === offscreenUrl)) return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = createOffscreenDocument();
  }

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function createOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ["WORKERS", "BLOBS"],
      justification: "Parse locally downloaded PDF invoices with PDF.js.",
    });
  } catch (err) {
    const message = String(err?.message || err);
    if (message.includes("Only a single offscreen document")) return;
    if (!message.includes("WORKERS") && !message.includes("reasons") && !message.includes("Value must be one of")) {
      throw err;
    }
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT,
        reasons: ["BLOBS"],
        justification: "Parse locally downloaded PDF invoices with PDF.js.",
      });
    } catch (fallbackErr) {
      if (!String(fallbackErr?.message || fallbackErr).includes("Only a single offscreen document")) {
        throw fallbackErr;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Извлечение БИН/ИИН ПОСТАВЩИКА через OpenRouter (с фолбэком по моделям).
// ---------------------------------------------------------------------------
async function extractSupplierXin(invoiceText, cfg) {
  const models = textModels(cfg);
  const prompt = buildXinPrompt(`=== ТЕКСТ ФАЙЛА ===\n${invoiceText.slice(0, MAX_TEXT_CHARS)}`, cfg);
  return tryModelsForXin(models, cfg, (model) => callOpenRouter(model, prompt, cfg));
}

async function extractSupplierXinViaVision(attachment, cfg, kind, report) {
  if (kind === "pdf" || (looksLikePdf(attachment.bytes) && !looksLikeImage(attachment.bytes))) {
    return extractSupplierXinFromPdfVision(attachment, cfg, report);
  }
  return extractSupplierXinFromImage(attachment, cfg, report);
}

async function extractSupplierXinFromImage(attachment, cfg, report) {
  if (attachment.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`изображение слишком большое (${Math.round(attachment.bytes.byteLength / 1024 / 1024)} МБ)`);
  }

  const models = visionModels(cfg);
  const prompt = buildXinPrompt(
    "Ниже прикреплено изображение счёта, скана, фото или табличного документа. Прочитай его визуально.",
    cfg
  );
  const imageUrl = `data:${attachment.contentType || mimeFromExtension(attachment.ext) || "image/jpeg"};base64,${bytesToBase64(attachment.bytes)}`;

  return tryModelsForXin(models, cfg, async (model) => {
    report?.(`vision: ${shortModelName(model)}`);
    return callChatMessages(
      model,
      [
        { role: "system", content: "Ты извлекаешь данные из счетов и отвечаешь только валидным JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      cfg
    );
  });
}

function extractEmbeddedImagesFromPdf(bytes) {
  const candidates = [];
  let i = 0;

  while (i < bytes.length - 3) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      let end = i + 3;
      while (end < bytes.length - 1) {
        if (bytes[end] === 0xff && bytes[end + 1] === 0xd9) {
          end += 2;
          break;
        }
        end++;
      }
      const slice = bytes.slice(i, end);
      if (slice.length >= 5000) {
        candidates.push({
          size: slice.length,
          url: `data:image/jpeg;base64,${bytesToBase64(slice)}`,
        });
      }
      i = end;
      continue;
    }
    i++;
  }

  return candidates
    .sort((a, b) => b.size - a.size)
    .slice(0, 3)
    .map((item) => item.url);
}

async function extractSupplierXinFromPdfVision(attachment, cfg, report) {
  if (attachment.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`PDF слишком большой (${Math.round(attachment.bytes.byteLength / 1024 / 1024)} МБ)`);
  }

  let images = [];
  let renderError = "";

  try {
    report?.("рендер страниц PDF");
    images = await renderPdfToImages(attachment.bytes);
  } catch (err) {
    renderError = String(err?.message || err);
  }

  if (!images.length) {
    report?.("извлекаю фото из PDF");
    images = extractEmbeddedImagesFromPdf(attachment.bytes);
  }

  if (!images.length) {
    return {
      xin: "",
      confidence: "low",
      note: renderError || "не удалось получить изображение из PDF (проверьте lib/pdf.js в расширении)",
    };
  }

  const rendered = await extractSupplierXinFromRenderedImages(images, cfg, report);
  if (rendered.xin) return rendered;

  return {
    xin: "",
    confidence: "low",
    note: rendered.note || renderError || "БИН не найден",
  };
}

async function extractSupplierXinFromRenderedImages(imageUrls, cfg, report) {
  const models = visionModels(cfg);
  const prompt = buildXinPrompt(
    "Ниже страницы PDF счёта (возможно скан или фото). Прочитай документ визуально.",
    cfg
  );
  const content = [{ type: "text", text: prompt }];
  for (const url of imageUrls) {
    content.push({ type: "image_url", image_url: { url } });
  }

  return tryModelsForXin(models, cfg, async (model) => {
    report?.(`vision: ${shortModelName(model)}`);
    return callChatMessages(
      model,
      [
        { role: "system", content: "Ты извлекаешь данные из счетов и отвечаешь только валидным JSON." },
        { role: "user", content },
      ],
      cfg
    );
  });
}

function shortModelName(model) {
  const name = String(model || "");
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

async function tryModelsForXin(models, cfg, callModel) {
  // Собираем ошибку каждой модели, чтобы в Notion было видно, что именно
  // произошло по всей цепочке, а не только у последней модели.
  const errors = [];
  for (const model of models) {
    try {
      const raw = await callModel(model);
      const parsed = parseXinJson(raw);
      if (parsed) {
        let xin = onlyDigits(parsed.xin);
        if (xin.length !== 12) xin = "";
        if (xin && cfg.ownXin && xin === cfg.ownXin) xin = "";
        if (xin) return { xin, confidence: parsed.confidence || "medium" };
      }
      errors.push(`${shortModelName(model)}: пустой/невалидный БИН`);
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("HTTP 402") && msg.includes("files")) {
        errors.push(`${shortModelName(model)}: для PDF-файлов нужен баланс`);
        continue;
      }
      errors.push(`${shortModelName(model)}: ${msg.slice(0, 160)}`);
    }
  }
  return { xin: "", confidence: "low", note: errors.join("; ") };
}

function buildXinPrompt(sourceText, cfg) {
  const excludeLine = cfg.ownXin
    ? `БИН/ИИН НАШЕЙ компании (покупателя) — ${cfg.ownXin}. Никогда не возвращай именно этот номер.`
    : `Если в счёте есть блок «Покупатель», его БИН/ИИН возвращать нельзя.`;

  return (
    `Найди БИН или ИИН именно ПОСТАВЩИКА в счёте на оплату (Казахстан): ` +
    `(того, кто выставил счёт; обычно блок «Поставщик» / «Бенефициар»), а НЕ покупателя.\n` +
    `${excludeLine}\n` +
    `БИН/ИИН — это ровно 12 цифр. В документе цифры могут быть разделены пробелами ` +
    `или точками (например «721 027 300 595») — это тоже валидный БИН/ИИН, ` +
    `верни его как 12 цифр подряд без разделителей.\n` +
    `Ответь СТРОГО одним JSON-объектом без markdown и пояснений: ` +
    `{"xin":"12 цифр или null","confidence":"high|medium|low"}.\n\n` +
    sourceText
  );
}

async function callOpenRouter(model, prompt, cfg) {
  return callChatMessages(
    model,
    [
      { role: "system", content: "Ты извлекаешь данные из счетов и отвечаешь только валидным JSON." },
      { role: "user", content: prompt },
    ],
    cfg
  );
}

// Единая точка вызова чат-модели: маршрутизирует запрос в OpenAI или OpenRouter
// в зависимости от выбранного в настройках провайдера. Формат сообщений (включая
// image_url для vision) совместим у обоих API.
async function callChatMessages(model, messages, cfg, plugins) {
  if (cfg.provider === "openai") {
    return callOpenAIMessages(model, messages, cfg);
  }
  return callOpenRouterMessages(model, messages, cfg, plugins);
}

async function callOpenAIMessages(model, messages, cfg) {
  const res = await fetch(OPENAI_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 100,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`OpenAI ${model}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error(`OpenAI ${model}: пустой ответ`);
  return content;
}

async function callOpenRouterMessages(model, messages, cfg, plugins) {
  const res = await fetch(OPENROUTER_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openrouterKey}`,
      "Content-Type": "application/json",
      "X-Title": "Notion KGD Checker",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 100,
      messages,
      ...(plugins ? { plugins } : {}),
    }),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`OpenRouter ${model}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error(`OpenRouter ${model}: пустой ответ`);
  return content;
}

function parseXinJson(raw) {
  // Убираем возможные ```json ... ``` обёртки и вытаскиваем первый JSON-объект.
  const cleaned = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : cleaned;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API КГД МФ РК — "Сведения по контрагентам": налоговый режим и статус НДС.
// ---------------------------------------------------------------------------
async function fetchCounterpartyData(xin, cfg) {
  const url = `${cfg.portalHost.replace(/\/+$/, "")}/services/isnaportal/public/get-sur-data`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "X-Portal-Token": cfg.portalToken, "Content-Type": "application/json" },
      body: JSON.stringify({ xin }),
    });
  } catch (err) {
    return { error: `Ошибка: КГД недоступен (${String(err?.message || err)})` };
  }

  if (res.status === 400) return { error: "Ошибка КГД 400: запрос содержит синтаксическую ошибку" };
  if (res.status === 401) return { error: "Ошибка КГД 401: пользователь не авторизован" };
  if (res.status === 404) return { error: "Ошибка КГД 404: доступ к сервису запрещён" };
  if (res.status === 500) return { error: "Ошибка КГД 500: сбой на сервере" };
  if (!res.ok) return { error: `Ошибка КГД ${res.status}` };

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: "Ошибка КГД: некорректный ответ (не JSON)" };
  }

  if (data?.status && data.status !== "SUCCESS") {
    const apiError = formatKgdApiError(data.error);
    return { error: `Ошибка КГД: ${apiError || data.status}` };
  }
  if (data?.error) {
    return { error: `Ошибка КГД: ${formatKgdApiError(data.error) || "неизвестная ошибка"}` };
  }

  const payload = unwrapKgdPayload(data);
  const taxMode = formatSurTaxMode(payload);
  const vatStatus = formatVatStatus(payload);
  const summary = summarizeKgdPayload(payload);
  const suffix = `(БИН ${xin}${summary ? `; ${summary}` : ""})`;
  return {
    taxMode: taxMode || `Нет данных о налоговом режиме ${suffix}`,
    vatStatus: vatStatus || `Нет данных о статусе НДС ${suffix}`,
  };
}

function unwrapKgdPayload(data) {
  if (!data || typeof data !== "object") return data;
  return data.data || data.result || data.payload || data.response || data;
}

function formatSurTaxMode(data) {
  if (!data || typeof data !== "object") return "";

  const taxMode = localizeKgdValue(data.taxMode || data.taxRegime || data.taxModeName);
  if (!taxMode) return "";

  const taxModeDate = String(data.taxModeDate || data.taxRegimeDate || "").trim();
  return taxModeDate ? `${taxMode} с ${taxModeDate}` : taxMode;
}

function formatVatStatus(data) {
  if (!data || typeof data !== "object") return "";

  const vatStatus = localizeKgdValue(data.vatInfo || data.vatStatus || data.vatPayer);
  if (!vatStatus) return "";

  const vatDate = String(data.vatDate || data.vatRegistrationDate || "").trim();
  return vatDate ? `${vatStatus} с ${vatDate}` : vatStatus;
}

function localizeKgdValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value !== "object") return "";

  const localized = value.ru || value.kk || value.en || value.qq || Object.values(value).find(Boolean);
  return localized == null ? "" : String(localized).trim();
}

function summarizeKgdPayload(data) {
  if (!data || typeof data !== "object") return "пустой ответ КГД";

  const parts = [];
  const name = localizeKgdValue(data.name);
  if (name) parts.push(`контрагент: ${name}`);

  const keys = Object.keys(data).slice(0, 12).join(", ");
  if (keys) parts.push(`поля ответа: ${keys}`);

  return parts.join("; ");
}

function formatKgdApiError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.messageRu || error.message || error.description || JSON.stringify(error)).trim();
}

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------
function dedupe(arr) {
  return [...new Set(arr)];
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
