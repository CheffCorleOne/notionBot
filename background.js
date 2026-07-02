// Service worker (module). Вся логика и сетевые запросы живут здесь —
// host_permissions на notion / openrouter / kgd избавляют от CORS в этом контексте.

import * as pdfjsLib from "./lib/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");

const NOTION_VERSION = "2022-06-28";
const NOTION_API = "https://api.notion.com/v1";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

// Пауза между запросами к Notion (лимит ~3 req/sec).
const RATE_LIMIT_MS = 400;

// Значения по умолчанию для настроек.
const DEFAULTS = {
  fileColumn: "Счет",
  resultColumn: "Налоговый режим",
  openrouterModel: "anthropic/claude-haiku-4.5",
  portalHost: "https://portal.kgd.gov.kz",
};

// Цепочка запасных моделей OpenRouter. Если основная модель не отвечает
// (сеть / не-200 / пустой или невалидный ответ) — пробуем следующую рабочую.
const FALLBACK_MODELS = [
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.0-flash-001",
  "openai/gpt-4o-mini",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Точка входа: сообщение от content.js по клику на плавающую кнопку.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "START_CHECK") {
    const tabId = sender.tab?.id;
    runBatch(tabId)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // асинхронный ответ
  }
});

function progress(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "PROGRESS", ...payload }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Основной сценарий: пройти по всем необработанным строкам базы.
// ---------------------------------------------------------------------------
async function runBatch(tabId) {
  const cfg = await loadConfig();

  progress(tabId, { stage: "start", text: "Подготовка..." });

  // Убедиться, что колонка результата существует (создать при необходимости).
  await ensureResultColumn(cfg);

  // Собрать все подходящие строки (файл есть, результат пуст).
  const pages = await queryPendingPages(cfg);
  const total = pages.length;

  if (total === 0) {
    progress(tabId, { stage: "done", text: "Новых строк нет — всё уже обработано." });
    return { total: 0, done: 0, errors: 0 };
  }

  let done = 0;
  let errors = 0;

  for (let i = 0; i < total; i++) {
    const page = pages[i];
    progress(tabId, { stage: "processing", current: i + 1, total, text: `Обрабатываю ${i + 1}/${total}...` });

    let resultText;
    try {
      resultText = await processPage(page, cfg);
    } catch (err) {
      resultText = `Ошибка: ${String(err?.message || err)}`;
      errors++;
    }

    // Записать результат (или текст ошибки) в Notion. Не роняем весь процесс.
    try {
      await writeResult(page.id, cfg, resultText);
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
// Обработка одной строки: PDF → текст → БИН поставщика → КГД → строка результата.
// ---------------------------------------------------------------------------
async function processPage(page, cfg) {
  const fileUrl = extractFileUrl(page, cfg.fileColumn);
  if (!fileUrl) return "Ошибка: файл счёта не найден в колонке";

  const pdfBytes = await downloadPdf(fileUrl);
  const text = await extractPdfText(pdfBytes);
  if (!text || text.trim().length < 10) return "Ошибка: не удалось распознать текст PDF";

  const { xin, confidence } = await extractSupplierXin(text, cfg);
  if (!xin) return "Ошибка: БИН поставщика не найден";

  const kgd = await fetchTaxMode(xin, cfg);
  if (kgd.error) return kgd.error;

  const note = confidence && confidence !== "high" ? ` (уверенность: ${confidence})` : "";
  return `${kgd.taxMode}${note}`;
}

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------
async function loadConfig() {
  const stored = await chrome.storage.local.get(null);
  const cfg = { ...DEFAULTS, ...stored };

  const missing = [];
  if (!cfg.notionToken) missing.push("Notion Integration Token");
  if (!cfg.databaseId) missing.push("ID базы данных Notion");
  if (!cfg.openrouterKey) missing.push("OpenRouter API Key");
  if (!cfg.portalToken) missing.push("X-Portal-Token (КГД)");
  if (missing.length) {
    throw new Error(`Заполните настройки: ${missing.join(", ")}`);
  }
  cfg.databaseId = normalizeId(cfg.databaseId);
  cfg.ownXin = onlyDigits(cfg.ownXin || "");
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

async function ensureResultColumn(cfg) {
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
  if (db.properties?.[cfg.resultColumn]) return; // уже есть

  const patch = await fetch(`${NOTION_API}/databases/${cfg.databaseId}`, {
    method: "PATCH",
    headers: notionHeaders(cfg),
    body: JSON.stringify({ properties: { [cfg.resultColumn]: { rich_text: {} } } }),
  });
  if (!patch.ok) {
    const body = await safeText(patch);
    throw new Error(`Notion: не удалось создать колонку «${cfg.resultColumn}» (${patch.status}). ${body}`);
  }
}

async function queryPendingPages(cfg) {
  const pages = [];
  let cursor;
  do {
    const body = {
      page_size: 100,
      filter: {
        and: [
          { property: cfg.fileColumn, files: { is_not_empty: true } },
          { property: cfg.resultColumn, rich_text: { is_empty: true } },
        ],
      },
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`${NOTION_API}/databases/${cfg.databaseId}/query`, {
      method: "POST",
      headers: notionHeaders(cfg),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await safeText(res);
      throw new Error(`Notion: ошибка запроса строк (${res.status}). ${errText}`);
    }
    const data = await res.json();
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
    if (cursor) await sleep(RATE_LIMIT_MS);
  } while (cursor);
  return pages;
}

function extractFileUrl(page, fileColumn) {
  const prop = page.properties?.[fileColumn];
  const file = prop?.files?.[0];
  if (!file) return null;
  // Notion-hosted (временная ссылка) либо внешняя ссылка.
  return file.file?.url || file.external?.url || null;
}

async function writeResult(pageId, cfg, text) {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(cfg),
    body: JSON.stringify({
      properties: {
        [cfg.resultColumn]: {
          rich_text: [{ type: "text", text: { content: String(text).slice(0, 1900) } }],
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Notion: не удалось записать результат (${res.status}). ${body}`);
  }
}

// ---------------------------------------------------------------------------
// PDF → текст (pdf.js). Без eval/remote-кода (isEvalSupported: false для MV3 CSP).
// ---------------------------------------------------------------------------
async function downloadPdf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`не удалось скачать PDF (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function extractPdfText(bytes) {
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  let out = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((it) => it.str).join(" ") + "\n";
  }
  await doc.destroy();
  return out;
}

// ---------------------------------------------------------------------------
// Извлечение БИН/ИИН ПОСТАВЩИКА через OpenRouter (с фолбэком по моделям).
// ---------------------------------------------------------------------------
async function extractSupplierXin(invoiceText, cfg) {
  const models = dedupe([cfg.openrouterModel, ...FALLBACK_MODELS].filter(Boolean));

  const excludeLine = cfg.ownXin
    ? `БИН/ИИН НАШЕЙ компании (покупателя) — ${cfg.ownXin}. Никогда не возвращай именно этот номер.`
    : `Если в счёте есть блок «Покупатель», его БИН/ИИН возвращать нельзя.`;

  const prompt =
    `Ниже текст счёта на оплату (Казахстан). Найди БИН или ИИН именно ПОСТАВЩИКА ` +
    `(того, кто выставил счёт; обычно блок «Поставщик» / «Бенефициар»), а НЕ покупателя.\n` +
    `${excludeLine}\n` +
    `БИН/ИИН — это ровно 12 цифр.\n` +
    `Ответь СТРОГО одним JSON-объектом без markdown и пояснений: ` +
    `{"xin":"12 цифр или null","confidence":"high|medium|low"}.\n\n` +
    `=== ТЕКСТ СЧЁТА ===\n${invoiceText.slice(0, 12000)}`;

  let lastErr = "";
  for (const model of models) {
    try {
      const raw = await callOpenRouter(model, prompt, cfg);
      const parsed = parseXinJson(raw);
      if (parsed) {
        // Валидируем и защищаемся от возврата нашего же БИН.
        let xin = onlyDigits(parsed.xin);
        if (xin.length !== 12) xin = "";
        if (xin && cfg.ownXin && xin === cfg.ownXin) xin = "";
        if (xin) return { xin, confidence: parsed.confidence || "medium" };
      }
      lastErr = "модель вернула пустой/невалидный БИН";
    } catch (err) {
      lastErr = String(err?.message || err);
      // пробуем следующую модель
    }
  }
  // Все модели исчерпаны.
  return { xin: "", confidence: "low", note: lastErr };
}

async function callOpenRouter(model, prompt, cfg) {
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
      messages: [
        { role: "system", content: "Ты извлекаешь данные из счетов и отвечаешь только валидным JSON." },
        { role: "user", content: prompt },
      ],
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
// API КГД МФ РК — получить налоговый режим (taxMode.ru).
// ---------------------------------------------------------------------------
async function fetchTaxMode(xin, cfg) {
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

  if (res.status === 400) return { error: "Ошибка КГД 400: неверный запрос/БИН" };
  if (res.status === 401) return { error: "Ошибка КГД 401: X-Portal-Token не авторизован" };
  if (res.status === 404) return { error: "Ошибка КГД 404: доступ к сервису запрещён" };
  if (res.status === 500) return { error: "Ошибка КГД 500: сбой на сервере" };
  if (!res.ok) return { error: `Ошибка КГД ${res.status}` };

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: "Ошибка КГД: некорректный ответ (не JSON)" };
  }
  const taxMode = data?.taxMode?.ru;
  if (!taxMode || !String(taxMode).trim()) {
    return { error: `Нет данных о налоговом режиме (БИН ${xin})` };
  }
  return { taxMode: String(taxMode).trim() };
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
