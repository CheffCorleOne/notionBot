// Форма настроек. Значения хранятся в chrome.storage.local.

const FIELDS = [
  "notionToken",
  "databaseId",
  "fileColumn",
  "resultColumn",
  "ownXin",
  "openrouterKey",
  "openrouterModel",
  "portalToken",
  "portalHost",
];

const DEFAULTS = {
  fileColumn: "счета",
  resultColumn: "Налоговый режим",
  openrouterModel: "anthropic/claude-haiku-4.5",
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
  const stored = await chrome.storage.local.get(FIELDS);
  for (const key of FIELDS) {
    const val = stored[key] ?? DEFAULTS[key] ?? "";
    if ($(key)) $(key).value = val;
  }
}

async function save() {
  const data = {};
  for (const key of FIELDS) {
    data[key] = ($(key)?.value ?? "").trim();
  }
  await chrome.storage.local.set(data);
  setStatus("Сохранено ✓", "ok");
  setTimeout(() => setStatus("", ""), 2000);
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
});
