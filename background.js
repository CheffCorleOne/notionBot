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
// Лимит OpenAI на PDF-вложения — 32 МБ / 100 страниц на запрос; base64 добавляет ~33%.
const MAX_PDF_BYTES = 20 * 1024 * 1024;
// Мельче — логотипы и печати, а не страница-скан.
const MIN_SCAN_PIXELS = 500000;
// Больше не имеет смысла: vision-модели всё равно ужимают вход (~2048 px).
const MAX_JPEG_DIMENSION = 2200;
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

// Текущий запуск проверки: { cancelled, controller }. Кнопка «Остановить»
// ставит cancelled и обрывает летящие запросы к AI/КГД через AbortController.
// Записи в Notion не прерываются: строка либо дописывается целиком, либо
// (если остановили посреди обработки) не трогается вовсе.
let activeRun = null;

function throwIfCancelled(run) {
  if (run?.cancelled) {
    const err = new Error("Проверка остановлена");
    err.cancelled = true;
    throw err;
  }
}

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
    if (activeRun) {
      sendResponse({ ok: true, started: false, alreadyRunning: true });
      return false;
    }

    const run = { cancelled: false, controller: new AbortController() };
    activeRun = run;
    (async () => {
      let tabId;
      try {
        tabId = await resolveTabId(sender);
        if (tabId == null) {
          throw new Error("не удалось определить вкладку Notion");
        }
        startKeepAlive();
        progress(tabId, { stage: "start", text: "Запуск..." });
        await runBatch(tabId, run);
      } catch (err) {
        if (run.cancelled) {
          progress(tabId, { stage: "cancelled", text: "Проверка остановлена." });
        } else {
          progress(tabId, { stage: "error", text: `Ошибка: ${String(err?.message || err)}` });
        }
      } finally {
        stopKeepAlive();
        activeRun = null;
      }
    })();
    sendResponse({ ok: true, started: true });
    return false;
  }

  if (msg?.type === "CANCEL_CHECK") {
    const run = activeRun;
    if (run) {
      run.cancelled = true;
      run.controller.abort();
    }
    sendResponse({ ok: true, cancelling: Boolean(run) });
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
async function runBatch(tabId, run) {
  const cfg = await loadConfig();
  cfg.run = run;

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
    if (run?.cancelled) break;

    const page = pages[i];
    const rowLabel = `Обрабатываю ${i + 1}/${total}`;
    progress(tabId, { stage: "processing", current: i + 1, total, text: `${rowLabel}...` });

    let result;
    try {
      result = await processPage(page, cfg, makeReporter(tabId, rowLabel));
    } catch (err) {
      // Остановка посреди строки: ничего не записываем, колонки остались
      // пустыми — следующий запуск подхватит строку заново.
      if (run?.cancelled || err?.cancelled) break;
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

    if (run?.cancelled) break;
    await sleep(RATE_LIMIT_MS);
  }

  if (run?.cancelled) {
    progress(tabId, { stage: "cancelled", text: `Остановлено: обработано ${done} из ${total}.` });
  } else {
    progress(tabId, { stage: "done", text: `Готово: ${done}/${total}${errors ? `, ошибок: ${errors}` : ""}.` });
  }
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
      throwIfCancelled(cfg.run);
      report?.("скачиваю файл");
      attachment = await downloadAttachment(file, cfg);

      // До трёх раундов чтения. КГД отвечает 500 в том числе на несуществующий
      // номер — а неверно прочитанная цифра изредка проходит и контрольную
      // сумму. Поэтому 500 от КГД трактуем как «вероятно, неверное прочтение»:
      // раунд 2 — перечитать, запретив отвергнутое число; раунд 3 — дать модели
      // варианты с одной исправленной цифрой, проходящие контрольную сумму.
      const banned = [];
      for (let round = 0; round < 3; round++) {
        throwIfCancelled(cfg.run);
        const cfgRound = { ...cfg };
        if (banned.length) cfgRound.bannedXins = banned;
        if (round === 2 && banned.length) cfgRound.verifyVariants = generateXinVariants(banned, cfg);

        const result = await extractSupplierXinFromAttachment(attachment, cfgRound, report);
        const { xin, confidence, note } = result;
        if (!xin) {
          // Перечитка вернула ровно те же числа, что КГД уже отверг, и ни
          // одного нового прочтения: номер прочитан верно, просто КГД его не
          // знает (самозанятые и физлица в реестре контрагентов отсутствуют).
          // Подбирать «варианты» в этом случае нельзя — соседнее число может
          // оказаться чужим реальным ИИН, и мы запишем чужой налоговый режим.
          if (result.repeatedOnly && result.repeatedXins?.length) {
            return errorResult(
              `Ошибка: КГД не вернул данные по БИН/ИИН ${result.repeatedXins.join(", ")} — номер перечитан повторно и совпадает с документом. ` +
                `Вероятно, контрагент отсутствует в реестре КГД (самозанятый или физлицо) либо сервис временно недоступен`
            );
          }
          lastProblem = note
            ? `БИН поставщика не найден (${attachment.name}): ${note}`
            : `БИН поставщика не найден (${attachment.name})`;
          // Перечитка провалилась, но есть ещё раунд с вариантами-подсказками.
          if (round < 2 && banned.length) continue;
          break;
        }

        report?.("запрос в КГД");
        const kgd = await fetchCounterpartyData(xin, cfg);
        if (kgd.error) {
          if (kgd.suspectWrongXin && round < 2) {
            banned.push(xin);
            report?.(`КГД не знает БИН ${xin} — перечитываю документ`);
            continue;
          }
          if (kgd.suspectWrongXin && banned.length) {
            // История перечиток: если одно из этих чисел совпадает с документом,
            // дело не в распознавании — контрагента просто нет в реестре.
            return errorResult(
              `${kgd.error}. Ранее КГД также отверг прочтения: ${banned.join(", ")} — если какое-то из них совпадает с документом, контрагента нет в реестре КГД (самозанятый/физлицо)`
            );
          }
          return errorResult(kgd.error);
        }

        const confidenceNote = confidence && confidence !== "high" ? ` (уверенность: ${confidence})` : "";
        // Номер из раунда вариантов-подсказок не прочитан напрямую, а подобран —
        // честно помечаем результат для ручной сверки с документом.
        const variantNote = round === 2 && cfgRound.verifyVariants?.includes(xin)
          ? " (номер подобран по контрольной сумме — сверьте с документом)"
          : "";
        return {
          taxMode: `${kgd.taxMode}${confidenceNote}${variantNote}`,
          vatStatus: `${kgd.vatStatus}${confidenceNote}${variantNote}`,
        };
      }
    } catch (err) {
      if (err?.cancelled || cfg.run?.cancelled) throw err;
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

// Проверка контрольного (12-го) разряда казахстанского БИН/ИИН.
// Позволяет детерминированно отсеять номера, неверно распознанные моделью
// со скана: при перепутанных цифрах контрольная сумма почти всегда не сходится.
// Варианты «неверного» числа с одной исправленной цифрой, проходящие
// контрольную сумму: модель обычно ошибается ровно в одной цифре, и правильный
// номер почти всегда попадает в этот список (~11 вариантов на число).
function generateXinVariants(bannedList, cfg) {
  const banned = new Set(bannedList);
  const variants = [];
  for (const source of bannedList) {
    for (let pos = 0; pos < 12; pos++) {
      for (let digit = 0; digit <= 9 && variants.length < 20; digit++) {
        const candidate = source.slice(0, pos) + digit + source.slice(pos + 1);
        if (candidate === source || banned.has(candidate) || variants.includes(candidate)) continue;
        if (cfg.ownXin && candidate === cfg.ownXin) continue;
        if (!isValidXinChecksum(candidate)) continue;
        variants.push(candidate);
      }
    }
  }
  return variants;
}

function isValidXinChecksum(xin) {
  if (!/^\d{12}$/.test(xin)) return false;
  const d = [...xin].map(Number);
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  let s = d.slice(0, 11).reduce((acc, v, i) => acc + v * w1[i], 0) % 11;
  if (s === 10) s = d.slice(0, 11).reduce((acc, v, i) => acc + v * w2[i], 0) % 11;
  return s !== 10 && s === d[11];
}

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
async function downloadAttachment(file, cfg) {
  const res = await fetch(file.url, { signal: cfg?.run?.controller?.signal });
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
    // Текст был, но БИН в нём не нашёлся — сохраняем детали для примечания.
    localError = result.note
      ? `БИН не найден в тексте файла: ${result.note}`
      : "БИН не найден в тексте файла";
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
  // Реальный формат важнее расширения: встречаются xlsx, переименованные
  // в .xls (ZIP-сигнатура), и старые бинарные xls под именем .xlsx.
  if (looksLikeZip(attachment.bytes)) {
    return extractXlsxText(attachment.bytes);
  }
  if (looksLikeOle2(attachment.bytes)) {
    return extractReadableBinaryStrings(attachment.bytes);
  }

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

function looksLikeZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function looksLikeOle2(bytes) {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  );
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

  // Некоторые счета целиком нарисованы текстовыми блоками поверх листа
  // (DrawingML) — сам лист при этом почти пустой. Забираем и их текст.
  const drawingPaths = Object.keys(entries)
    .filter((name) => /^xl\/drawings\/drawing\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const path of drawingPaths) {
    if (chunks.join("\n\n").length >= MAX_TEXT_CHARS) break;
    const drawingText = extractDrawingText(entries[path]);
    if (drawingText) chunks.push(`Надписи листа:\n${drawingText}`);
  }

  return chunks.join("\n\n").slice(0, MAX_TEXT_CHARS);
}

// Текст из DrawingML: строка на каждый абзац <a:p>, прогоны <a:t> склеиваются.
function extractDrawingText(xml) {
  const lines = [];
  for (const para of String(xml || "").matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
    const runs = [...para[0].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    const line = runs.join("").replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n").slice(0, MAX_TEXT_CHARS);
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
  // Чтение результата должно начаться ДО записи: DecompressionStream
  // останавливается на бэкпрешере (~16 КБ вывода), и «сначала дописать,
  // потом читать» зависает навсегда на любом файле крупнее этого буфера.
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await output);
}

function parseSharedStrings(xml) {
  // Самозакрытые <si/> обязаны давать пустую строку, а не пропуск: иначе
  // индексы всех последующих строк сдвигаются и ячейки читают чужой текст.
  const strings = [];
  for (const match of xml.matchAll(/<si\b[^>]*\/>|<si\b[\s\S]*?<\/si>/g)) {
    strings.push(match[0].includes("</si>") ? extractXmlText(match[0]) : "");
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
  // ВАЖНО: самозакрытые пустые ячейки (<c r="A1" s="1"/>) и строки (<row/>)
  // нужно матчить отдельной ветвью. Иначе ленивое [\s\S]*? заглатывает всё от
  // самозакрытого тега до закрытия следующего настоящего, атрибуты (включая
  // t="s") берутся от пустой ячейки — и вместо текста выводится индекс.
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*\/>|<row\b[\s\S]*?<\/row>/g)) {
    if (!rowMatch[0].includes("</row>")) continue;
    const cells = [];
    for (const cellMatch of rowMatch[0].matchAll(/<c\b[^>]*\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (cellMatch[1] === undefined) continue; // самозакрытая пустая ячейка
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
  // Теги текста бывают с префиксом пространства имён: <t> (xlsx), <w:t> (docx),
  // <a:t> (DrawingML — надписи поверх листа).
  for (const match of String(xml || "").matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)) {
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

  // UTF-16-строки в BIFF лежат с произвольным выравниванием — сканируем
  // и с чётного, и с нечётного смещения, иначе половина строк теряется.
  const utf16Parts = [];
  for (const offset of [0, 1]) {
    let utf16 = "";
    for (let i = offset; i + 1 < bytes.length; i += 2) {
      const code = bytes[i] | (bytes[i + 1] << 8);
      if (isPrintableCodePoint(code)) {
        utf16 += String.fromCharCode(code);
      } else {
        if (utf16.length >= 4) utf16Parts.push(utf16);
        utf16 = "";
      }
    }
    if (utf16.length >= 4) utf16Parts.push(utf16);
  }

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
    // Сначала достаём встроенный скан из объектов PDF сами: модель получает
    // картинку в полном разрешении плюс увеличенный верх страницы с реквизитами.
    // Это читается заметно точнее, чем PDF целиком (OpenAI растеризует его сам
    // в меньшем разрешении, и цифры БИН на сканах плывут).
    let scanNote = "";
    try {
      report?.("достаю скан из PDF");
      const scans = await extractScanImagesFromPdf(attachment.bytes);
      if (scans.length) {
        const result = await extractSupplierXinFromRenderedImages(scans, cfg, report);
        if (result.xin) return result;
        scanNote = result.note || "";
      } else {
        // Видно в примечании Notion: модель читала PDF целиком, без полос-зумов.
        scanNote = "встроенный скан из PDF извлечь не удалось";
      }
    } catch (err) {
      scanNote = String(err?.message || err);
    }

    // Скан не достался или БИН по нему не подтвердился — запасные пути:
    // OpenAI умеет читать PDF-файл целиком, OpenRouter — только рендер страниц.
    const fallback = cfg.provider === "openai"
      ? await extractSupplierXinFromPdfFile(attachment, cfg, report)
      : await extractSupplierXinFromPdfVision(attachment, cfg, report);
    if (!fallback.xin && scanNote) {
      fallback.note = [scanNote, fallback.note].filter(Boolean).join("; ");
    }
    return fallback;
  }
  return extractSupplierXinFromImage(attachment, cfg, report);
}

// Прямая отправка PDF в OpenAI: тип содержимого file с data:-URL, модель сама
// читает и текстовый слой, и сканы (лимит OpenAI — 100 страниц / 32 МБ).
async function extractSupplierXinFromPdfFile(attachment, cfg, report) {
  if (attachment.bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF слишком большой (${Math.round(attachment.bytes.byteLength / 1024 / 1024)} МБ)`);
  }

  const models = visionModels(cfg);
  const prompt = buildXinPrompt("Ниже приложен PDF-файл счёта (возможно скан или фото). Прочитай его.", cfg);
  const fileData = `data:application/pdf;base64,${bytesToBase64(attachment.bytes)}`;
  const filename = /\.pdf$/i.test(attachment.name || "") ? attachment.name : "invoice.pdf";

  return tryModelsForXin(models, cfg, async (model) => {
    report?.(`PDF в модель: ${shortModelName(model)}`);
    return callChatMessages(
      model,
      [
        { role: "system", content: "Ты извлекаешь данные из счетов и отвечаешь только валидным JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "file", file: { filename, file_data: fileData } },
          ],
        },
      ],
      cfg
    );
  });
}

async function extractSupplierXinFromImage(attachment, cfg, report) {
  if (attachment.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`изображение слишком большое (${Math.round(attachment.bytes.byteLength / 1024 / 1024)} МБ)`);
  }

  // Большое фото/скан режем на полосы-зумы (см. bitmapSourceToJpegUrls) —
  // заодно любой формат нормализуется в JPEG, который принимают все провайдеры.
  let imageUrls;
  try {
    const bitmap = await createImageBitmap(new Blob([attachment.bytes]));
    try {
      imageUrls = await bitmapSourceToJpegUrls(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch {
    // формат не декодируется локально (например, heic) — отправляем как есть
    imageUrls = [
      `data:${attachment.contentType || mimeFromExtension(attachment.ext) || "image/jpeg"};base64,${bytesToBase64(attachment.bytes)}`,
    ];
  }

  return extractSupplierXinFromRenderedImages(imageUrls, cfg, report);
}

// ---------------------------------------------------------------------------
// Извлечение скан-изображений напрямую из объектов PDF (без pdf.js).
// Скан-приложения кладут страницу одним XObject /Image: DCTDecode (готовый
// JPEG) или FlateDecode (сырой битмап 8 бит, Gray/RGB, иногда PNG-предикторы).
// pdf.js на части таких файлов навсегда зависает в page.render(), поэтому
// разбираем структуру PDF сами. Для каждой страницы-скана отдаём две картинки:
// вся страница + увеличенный верх (там реквизиты и блок «Поставщик»).
// ---------------------------------------------------------------------------
async function extractScanImagesFromPdf(bytes) {
  const latin = new TextDecoder("latin1").decode(bytes);
  const urls = [];
  const re = /\/Subtype\s*\/Image/g;
  let match;
  let attempts = 0;
  while (urls.length < 8 && attempts < 20 && (match = re.exec(latin))) {
    attempts++;
    try {
      const pageUrls = await decodePdfImageObject(bytes, latin, match.index);
      if (pageUrls) urls.push(...pageUrls);
    } catch {
      // объект не разобрался — пробуем следующий
    }
  }
  return urls.slice(0, 8);
}

async function decodePdfImageObject(bytes, latin, subtypeAt) {
  const objAt = latin.lastIndexOf("obj", subtypeAt);
  const streamAt = latin.indexOf("stream", subtypeAt);
  if (objAt < 0 || streamAt < 0) return null;
  const dict = latin.slice(objAt, streamAt);

  const width = Number(dict.match(/\/Width\s+(\d+)/)?.[1]);
  const height = Number(dict.match(/\/Height\s+(\d+)/)?.[1]);
  if (!width || !height || width * height < MIN_SCAN_PIXELS) return null;

  const filters = pdfFilterList(dict);
  let dataStart = streamAt + 6;
  if (bytes[dataStart] === 0x0d) dataStart++;
  if (bytes[dataStart] === 0x0a) dataStart++;
  const dataEnd = pdfStreamEnd(latin, dict, dataStart);
  if (dataEnd <= dataStart || dataEnd > bytes.length) return null;
  let data = bytes.slice(dataStart, dataEnd);

  // Фильтры применяются по порядку. JPEG (DCTDecode) может быть дополнительно
  // завёрнут в FlateDecode — сканеры пишут /Filter [/FlateDecode /DCTDecode]:
  // снимаем обёртки, пока не дойдём до JPEG или до сырого битмапа.
  for (const filter of filters) {
    if (filter === "FlateDecode") {
      data = await inflateZlib(data);
      continue;
    }
    if (filter === "DCTDecode") {
      const bitmap = await createImageBitmap(new Blob([data], { type: "image/jpeg" }));
      try {
        if (bitmap.width * bitmap.height < MIN_SCAN_PIXELS) return null;
        return await bitmapSourceToJpegUrls(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    }
    return null; // CCITTFax/JBIG2/JPX и прочие не поддерживаем
  }

  // Все фильтры сняты (или их не было) — data содержит сырой битмап.
  const bits = Number(dict.match(/\/BitsPerComponent\s+(\d+)/)?.[1] || 8);
  if (bits !== 8) return null;

  let raw = data;
  let comps = pdfColorComponents(dict, latin);
  const predictor = Number(dict.match(/\/Predictor\s+(\d+)/)?.[1] || 1);
  if (predictor >= 10) {
    const columns = Number(dict.match(/\/Columns\s+(\d+)/)?.[1] || width);
    const colors = Number(dict.match(/\/Colors\s+(\d+)/)?.[1] || comps || 3);
    raw = undoPngPredictors(raw, columns, colors);
    if (!comps) comps = colors;
  }
  if (!comps) comps = Math.round(raw.length / (width * height));
  if ((comps !== 1 && comps !== 3) || raw.length < width * height * comps) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    if (comps === 1) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = raw[i];
    } else {
      rgba[j] = raw[i * 3];
      rgba[j + 1] = raw[i * 3 + 1];
      rgba[j + 2] = raw[i * 3 + 2];
    }
    rgba[j + 3] = 255;
  }
  return bitmapSourceToJpegUrls(new ImageData(rgba, width, height), width, height);
}

function pdfFilterList(dict) {
  const array = dict.match(/\/Filter\s*\[([^\]]*)\]/);
  if (array) return [...array[1].matchAll(/\/(\w+)/g)].map((m) => m[1]);
  const single = dict.match(/\/Filter\s*\/(\w+)/);
  return single ? [single[1]] : [];
}

function pdfStreamEnd(latin, dict, dataStart) {
  const indirect = dict.match(/\/Length\s+(\d+)\s+\d+\s+R/);
  if (indirect) {
    const body = findPdfObjectBody(latin, Number(indirect[1]));
    const n = body.match(/\d+/);
    if (n) return dataStart + Number(n[0]);
  } else {
    const direct = dict.match(/\/Length\s+(\d+)/);
    if (direct) return dataStart + Number(direct[1]);
  }
  const end = latin.indexOf("endstream", dataStart);
  return end < 0 ? -1 : end;
}

function findPdfObjectBody(latin, num) {
  const match = new RegExp(`(?:^|[^\\d])${num}\\s+0\\s+obj`).exec(latin);
  if (!match) return "";
  const start = match.index + match[0].length;
  const end = latin.indexOf("endobj", start);
  return end < 0 ? "" : latin.slice(start, end);
}

// Число цветовых компонент картинки: прямое имя, либо ссылка на объект
// ColorSpace (ICCBased — через второй переход, /N в словаре ICC-потока).
function pdfColorComponents(dict, latin) {
  const named = (name) =>
    ({ DeviceGray: 1, CalGray: 1, DeviceRGB: 3, CalRGB: 3, DeviceCMYK: 4 }[name] || 0);

  const direct = dict.match(/\/ColorSpace\s*\/(\w+)/);
  if (direct) return named(direct[1]);

  const ref = dict.match(/\/ColorSpace\s+(\d+)\s+\d+\s+R/);
  if (!ref) return 0;
  let body = findPdfObjectBody(latin, Number(ref[1]));
  if (!body) return 0;
  if (/\/Indexed/.test(body)) return 0;

  const icc = body.match(/\/ICCBased\s+(\d+)\s+\d+\s+R/);
  if (icc) body = findPdfObjectBody(latin, Number(icc[1])) || body;

  const n = body.match(/\/N\s+(\d+)/);
  if (n) return Number(n[1]);
  const name = body.match(/\/(DeviceGray|CalGray|DeviceRGB|CalRGB|DeviceCMYK)/);
  return name ? named(name[1]) : 0;
}

// Обратные PNG-предикторы (Predictor >= 10): каждая строка начинается с байта
// типа фильтра (0 none, 1 sub, 2 up, 3 average, 4 paeth).
function undoPngPredictors(data, columns, colors) {
  const bpp = colors;
  const rowLen = columns * colors;
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);

  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const dst = out.subarray(r * rowLen, (r + 1) * rowLen);

    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? dst[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      dst[i] = v & 0xff;
    }
    prev = dst;
  }
  return out;
}

// PDF FlateDecode — это zlib-формат ("deflate", с заголовком), в отличие от
// deflate-raw внутри ZIP. Чтение начинается до записи — см. inflateRaw.
async function inflateZlib(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("браузер не поддерживает распаковку Flate");
  }
  const stream = new DecompressionStream("deflate");
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await output);
}

// Из готовой картинки (ImageData или ImageBitmap) — JPEG data:-URL всей
// страницы + горизонтальных полос-зумов. Vision-модели ужимают вход (вписывание
// в 2048 px и короткая сторона до 768 px), из-за чего цифры на целой странице
// «плывут». Полосы подобраны такой высоты, чтобы после этого ужатия остаться
// практически в исходном разрешении — это и есть зум: цифры БИН на полосе
// в 2–3 раза крупнее, чем на целой странице.
async function bitmapSourceToJpegUrls(source, width, height) {
  const full = new OffscreenCanvas(width, height);
  const ctx = full.getContext("2d");
  if (typeof ImageData !== "undefined" && source instanceof ImageData) {
    ctx.putImageData(source, 0, 0);
  } else {
    ctx.drawImage(source, 0, 0);
  }

  const urls = [await canvasToScaledJpegUrl(full, width, height)];

  // Небольшие картинки модель и так видит почти в исходном разрешении.
  if (Math.min(width, height) <= 900) return urls;

  const bandHeight = Math.max(400, Math.floor((768 * width) / 2048));
  if (height > bandHeight * 1.2) {
    const step = Math.floor(bandHeight * 0.85); // ~15% перекрытия, чтобы строка не порезалась
    for (let y = 0; y < height && urls.length < 6; y += step) {
      const h = Math.min(bandHeight, height - y);
      if (y > 0 && h < bandHeight * 0.35) break; // хвост уже покрыт перекрытием
      const band = new OffscreenCanvas(width, h);
      band.getContext("2d").drawImage(full, 0, y, width, h, 0, 0, width, h);
      urls.push(await canvasToScaledJpegUrl(band, width, h));
    }
  }
  return urls;
}

async function canvasToScaledJpegUrl(canvas, width, height) {
  let target = canvas;
  const k = Math.min(MAX_JPEG_DIMENSION / width, MAX_JPEG_DIMENSION / height, 1);
  if (k < 1) {
    target = new OffscreenCanvas(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)));
    target.getContext("2d").drawImage(canvas, 0, 0, target.width, target.height);
  }
  const blob = await target.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}

// Поиск JPEG по сырым байтам PDF даёт ложные срабатывания внутри сжатых потоков
// (кусок Flate-данных случайно начинается с FF D8 FF). Такой «мусор» OpenAI и
// OpenRouter отвергают ошибкой unsupported image, поэтому каждый срез проверяем
// декодированием перед отправкой.
async function filterDecodableImages(dataUrls) {
  const valid = [];
  for (const url of dataUrls) {
    try {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      bitmap.close();
      valid.push(url);
    } catch {
      // не настоящая картинка — пропускаем
    }
  }
  return valid;
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
    images = await filterDecodableImages(extractEmbeddedImagesFromPdf(attachment.bytes));
  }

  if (!images.length) {
    return {
      xin: "",
      confidence: "low",
      note: renderError
        ? `рендер PDF не удался (${renderError}), пригодных изображений в PDF не найдено`
        : "не удалось получить изображение из PDF",
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
    "Ниже изображения счёта (возможно скан или фото): страницы документа и их увеличенные фрагменты-полосы. " +
      "Цифры точнее видны на увеличенных полосах — сверяй прочтения между картинками.",
    cfg
  );
  const content = [{ type: "text", text: prompt }];
  for (const url of imageUrls) {
    content.push({ type: "image_url", image_url: { url, detail: "high" } });
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
  // Если модели при перечитке возвращают ТОЛЬКО уже отвергнутые КГД числа и ни
  // одного нового прочтения — номер в документе прочитан верно, просто КГД его
  // не знает (например, самозанятый). Это сигнал прекратить перечитки.
  const bannedSeen = new Set();
  let freshSeen = false;
  for (const model of models) {
    throwIfCancelled(cfg.run);
    try {
      const raw = await callModel(model);
      const parsed = parseXinJson(raw);
      if (parsed) {
        // Модель возвращает основное прочтение плюс прочтения из каждого места
        // документа: берём первое, которое проходит контрольную сумму — на
        // сканах модель обычно читает верно хотя бы в одном месте.
        const rejected = [];
        const bannedReturned = [];
        const bannedSet = new Set(cfg.bannedXins || []);
        const candidates = [parsed.xin, ...(Array.isArray(parsed.candidates) ? parsed.candidates : [])];
        for (const candidate of candidates) {
          const xin = onlyDigits(candidate);
          if (xin.length !== 12) continue;
          if (cfg.ownXin && xin === cfg.ownXin) continue;
          if (bannedSet.has(xin)) {
            bannedReturned.push(xin);
            bannedSeen.add(xin);
            continue;
          }
          freshSeen = true;
          if (!isValidXinChecksum(xin)) {
            rejected.push(xin);
            continue;
          }
          return { xin, confidence: parsed.confidence || "medium" };
        }
        if (rejected.length || bannedReturned.length) {
          // Все прочтения либо с битой контрольной цифрой, либо уже отвергнуты
          // КГД — ошибка распознавания скана. Пробуем следующую модель цепочки.
          const parts = [];
          if (rejected.length) {
            parts.push(`БИН ${dedupe(rejected).join(", ")} не прошёл контрольную сумму (ошибка распознавания скана)`);
          }
          if (bannedReturned.length) {
            parts.push(`модель снова вернула отвергнутый КГД БИН ${dedupe(bannedReturned).join(", ")}`);
          }
          errors.push(`${shortModelName(model)}: ${parts.join("; ")}`);
          continue;
        }
      }
      errors.push(`${shortModelName(model)}: пустой/невалидный БИН`);
    } catch (err) {
      // Оборванный отменой запрос — не ошибка модели, прерываем всю цепочку.
      if (err?.cancelled || cfg.run?.cancelled) throwIfCancelled(cfg.run);
      const msg = String(err?.message || err);
      if (msg.includes("HTTP 402") && msg.includes("files")) {
        errors.push(`${shortModelName(model)}: для PDF-файлов нужен баланс`);
        continue;
      }
      errors.push(`${shortModelName(model)}: ${msg.slice(0, 160)}`);
    }
  }
  return {
    xin: "",
    confidence: "low",
    note: errors.join("; "),
    repeatedOnly: bannedSeen.size > 0 && !freshSeen,
    repeatedXins: [...bannedSeen],
  };
}

function buildXinPrompt(sourceText, cfg) {
  const excludeLine = cfg.ownXin
    ? `БИН/ИИН НАШЕЙ компании (покупателя) — ${cfg.ownXin}. Никогда не возвращай именно этот номер.`
    : `Если в счёте есть блок «Покупатель», его БИН/ИИН возвращать нельзя.`;

  // Числа, которые КГД уже отверг (несуществующий БИН = неверное прочтение).
  const bannedLine = cfg.bannedXins?.length
    ? `ВАЖНО: числа ${cfg.bannedXins.join(", ")} — НЕВЕРНЫЕ прочтения этого документа ` +
      `(таких БИН не существует). Не возвращай их. Перечитай цифры заново по одной, ` +
      `особенно похожие по написанию: 0/6/8, 1/7, 3/8, 5/6, 2/7.\n`
    : "";

  // Варианты неверного прочтения с одной исправленной цифрой (см. generateXinVariants).
  const variantsLine = cfg.verifyVariants?.length
    ? `Подсказка: правильный номер, скорее всего, один из этих вариантов (каждый отличается ` +
      `от неверного прочтения одной цифрой и проходит контрольную сумму БИН): ` +
      `${cfg.verifyVariants.join(", ")}. Сравни каждый вариант с документом по цифрам и верни ` +
      `тот, который действительно написан. Если ни один не совпадает — прочитай номер заново сам.\n`
    : "";

  return (
    `Найди БИН или ИИН именно ПОСТАВЩИКА в счёте на оплату (Казахстан): ` +
    `(того, кто выставил счёт; обычно блок «Поставщик» / «Бенефициар»), а НЕ покупателя.\n` +
    `${excludeLine}\n` +
    bannedLine +
    variantsLine +
    `БИН/ИИН — это ровно 12 цифр. В документе цифры могут быть разделены пробелами ` +
    `или точками (например «721 027 300 595») — это тоже валидный БИН/ИИН, ` +
    `верни его как 12 цифр подряд без разделителей.\n` +
    `Перепроверь каждую цифру: номер поставщика часто встречается в документе ` +
    `несколько раз (реквизиты, блок «Поставщик», печать) — сверь эти вхождения между собой.\n` +
    `Ответь СТРОГО одним JSON-объектом без markdown и пояснений: ` +
    `{"xin":"12 цифр или null","candidates":["..."],"confidence":"high|medium|low"}.\n` +
    `В candidates перечисли прочтение цифр номера поставщика из КАЖДОГО места документа, ` +
    `где он встречается (реквизиты, блок «Поставщик», печать), по одной записи на место — ` +
    `даже если прочтения совпадают. Читай цифры с картинки, не «исправляй» их по памяти.\n\n` +
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
  // Reasoning-модели OpenAI (o-серия, gpt-5) не принимают max_tokens и
  // temperature — при таком 400-м пересобираем параметры и повторяем запрос.
  const body = { model, temperature: 0, max_tokens: 100, messages };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(OPENAI_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: cfg.run?.controller?.signal,
    });
    if (res.ok) {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) throw new Error(`OpenAI ${model}: пустой ответ`);
      return content;
    }
    const errText = await safeText(res);
    if (res.status === 400 && "max_tokens" in body && errText.includes("max_tokens")) {
      delete body.max_tokens;
      // У reasoning-моделей сюда входят и «мысли», поэтому лимит с запасом.
      body.max_completion_tokens = 2000;
      continue;
    }
    if (res.status === 400 && "temperature" in body && errText.includes("temperature")) {
      delete body.temperature;
      continue;
    }
    throw new Error(`OpenAI ${model}: HTTP ${res.status} ${errText.slice(0, 200)}`);
  }
  throw new Error(`OpenAI ${model}: не удалось подобрать параметры запроса`);
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
    signal: cfg.run?.controller?.signal,
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
  // В каждой ошибке указываем отправленный БИН/ИИН: если модель неверно
  // распознала номер со скана, это сразу видно при сравнении с документом.
  const sent = `(отправлен БИН/ИИН ${xin})`;

  // 500 и сетевые сбои бывают разовыми — пробуем до 3 раз с паузой.
  const KGD_ATTEMPTS = 3;
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "X-Portal-Token": cfg.portalToken, "Content-Type": "application/json" },
        body: JSON.stringify({ xin }),
        signal: cfg.run?.controller?.signal,
      });
    } catch (err) {
      throwIfCancelled(cfg.run);
      if (attempt < KGD_ATTEMPTS) {
        await sleep(1000 * attempt);
        continue;
      }
      return { error: `Ошибка: КГД недоступен (${String(err?.message || err)}) ${sent}` };
    }
    if (res.status === 500 && attempt < KGD_ATTEMPTS) {
      await sleep(1000 * attempt);
      continue;
    }
    break;
  }

  if (res.status === 400) return { error: `Ошибка КГД 400: запрос содержит синтаксическую ошибку ${sent}` };
  if (res.status === 401) return { error: "Ошибка КГД 401: пользователь не авторизован (проверьте X-Portal-Token)" };
  if (res.status === 404) return { error: "Ошибка КГД 404: доступ к сервису запрещён" };
  if (res.status === 500)
    return {
      // 500 приходит и на несуществующий БИН — сигнал перечитать документ.
      suspectWrongXin: true,
      error: `Ошибка КГД 500: сбой на сервере ${sent}. Если номер не совпадает с документом — модель неверно распознала скан; если совпадает — сервис КГД не ответил, попробуйте позже`,
    };
  if (!res.ok) return { error: `Ошибка КГД ${res.status} ${sent}` };

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: `Ошибка КГД: некорректный ответ (не JSON) ${sent}` };
  }

  if (data?.status && data.status !== "SUCCESS") {
    const apiError = formatKgdApiError(data.error);
    return { error: `Ошибка КГД: ${apiError || data.status} ${sent}` };
  }
  if (data?.error) {
    return { error: `Ошибка КГД: ${formatKgdApiError(data.error) || "неизвестная ошибка"} ${sent}` };
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
