// Форма настроек. Значения хранятся в chrome.storage.local.

const FIELDS = [
  "notionToken",
  "databaseId",
  "fileColumn",
  "resultColumn",
  "vatColumn",
  "recentRowsLimit",
  "ownXin",
  "provider",
  "openrouterKey",
  "openrouterModel",
  "openaiKey",
  "openaiModel",
  "portalToken",
  "portalHost",
];

const DEFAULTS = {
  fileColumn: "Счет",
  resultColumn: "Налоговый режим",
  vatColumn: "Плательщик НДС",
  recentRowsLimit: "50",
  provider: "openrouter",
  openrouterModel: "anthropic/claude-haiku-4.5",
  openaiModel: "gpt-4o-mini",
  portalHost: "https://portal.kgd.gov.kz",
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, tone) {
  const el = $("status");
  el.textContent = text;
  el.className = tone || "";
}

async function load() {
  const stored = await chrome.storage.local.get([...FIELDS, "hideFloatingButton"]);
  for (const key of FIELDS) {
    const val = stored[key] ?? DEFAULTS[key] ?? "";
    if ($(key)) $(key).value = val;
  }
  if ($("hideFloatingButton")) {
    $("hideFloatingButton").checked = stored.hideFloatingButton === true;
  }
  syncProviderVisibility();
}

// Показываем поля только выбранного провайдера (OpenRouter или OpenAI).
function syncProviderVisibility() {
  const provider = $("provider")?.value === "openai" ? "openai" : "openrouter";
  document.body.classList.toggle("provider-is-openai", provider === "openai");
  document.body.classList.toggle("provider-is-openrouter", provider === "openrouter");
}

async function save() {
  const data = {};
  for (const key of FIELDS) {
    data[key] = ($(key)?.value ?? "").trim();
  }
  data.hideFloatingButton = $("hideFloatingButton")?.checked === true;
  await chrome.storage.local.set(data);
  setStatus("Сохранено ✓", "ok");
  setTimeout(() => setStatus("", ""), 2000);
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
  $("provider")?.addEventListener("change", syncProviderVisibility);
});
