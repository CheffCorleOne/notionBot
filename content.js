// Только UI на странице Notion: плавающая кнопка + тост прогресса.
// Вся тяжёлая логика — в service worker (background.js).

(function () {
  if (window.__kgdCheckerInjected) return;
  window.__kgdCheckerInjected = true;

  const BTN_ID = "kgd-check-btn";
  const TOAST_ID = "kgd-check-toast";
  let buttonHidden = false;
  let running = false;
  let lastProgressAt = 0;

  async function loadButtonHidden() {
    const stored = await chrome.storage.local.get("hideFloatingButton");
    buttonHidden = stored.hideFloatingButton === true;
  }

  function ensureButton() {
    if (buttonHidden) {
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.style.display = "none";
      return;
    }

    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "Проверить контрагентов";
    btn.addEventListener("click", onClick);
    document.body.appendChild(btn);
  }

  function showToast(text, tone) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.className = tone ? `kgd-toast-${tone}` : "";
    toast.style.display = "block";
  }

  function hideToastLater(ms) {
    setTimeout(() => {
      const toast = document.getElementById(TOAST_ID);
      if (toast) toast.style.display = "none";
    }, ms);
  }

  function setBusy(busy) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle("kgd-busy", busy);
  }

  function finishRun(tone) {
    running = false;
    setBusy(false);
    hideToastLater(8000);
    if (tone) {
      const toast = document.getElementById(TOAST_ID);
      if (toast) toast.className = `kgd-toast-${tone}`;
    }
  }

  async function onClick() {
    if (running) return;
    running = true;
    lastProgressAt = Date.now();
    setBusy(true);
    showToast("Запускаю проверку...", "info");

    const heartbeat = setInterval(() => {
      if (!running) return;
      const silentMs = Date.now() - lastProgressAt;
      if (silentMs > 12000) {
        showToast("Нет ответа от расширения. Перезагрузите его в chrome://extensions", "err");
        finishRun("err");
        clearInterval(heartbeat);
      } else if (silentMs > 4000) {
        showToast("Расширение работает, подождите...", "info");
      }
    }, 2000);

    try {
      const resp = await chrome.runtime.sendMessage({ type: "START_CHECK" });
      if (!resp?.started) {
        showToast(resp?.error || "Не удалось запустить проверку", "err");
        finishRun("err");
      }
    } catch (err) {
      showToast(`Ошибка: ${String(err?.message || err)}`, "err");
      finishRun("err");
    } finally {
      clearInterval(heartbeat);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "PROGRESS") return;
    lastProgressAt = Date.now();
    const tone = msg.stage === "done" ? "ok" : msg.stage === "error" ? "err" : "info";
    showToast(msg.text || "...", tone);
    if (msg.stage === "done" || msg.stage === "error") {
      finishRun(tone);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.hideFloatingButton) return;
    buttonHidden = changes.hideFloatingButton.newValue === true;
    if (buttonHidden) {
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.style.display = "none";
      return;
    }
    ensureButton();
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.style.display = "";
  });

  loadButtonHidden().then(() => {
    ensureButton();
    const observer = new MutationObserver(() => ensureButton());
    observer.observe(document.body, { childList: true, subtree: false });
  });
})();
