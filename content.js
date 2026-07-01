// Только UI на странице Notion: плавающая кнопка + тост прогресса.
// Вся тяжёлая логика — в service worker (background.js).

(function () {
  if (window.__kgdCheckerInjected) return;
  window.__kgdCheckerInjected = true;

  const BTN_ID = "kgd-check-btn";
  const TOAST_ID = "kgd-check-toast";

  function ensureButton() {
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

  async function onClick() {
    setBusy(true);
    showToast("Запускаю проверку...", "info");
    try {
      const resp = await chrome.runtime.sendMessage({ type: "START_CHECK" });
      if (resp?.ok) {
        const s = resp.summary || {};
        if (s.total === 0) {
          showToast("Новых строк нет — всё уже обработано.", "info");
        } else {
          showToast(`Готово: ${s.done}/${s.total}${s.errors ? `, ошибок: ${s.errors}` : ""}.`, "ok");
        }
      } else {
        showToast(resp?.error || "Не удалось выполнить проверку.", "err");
      }
    } catch (err) {
      showToast(`Ошибка: ${String(err?.message || err)}`, "err");
    } finally {
      setBusy(false);
      hideToastLater(8000);
    }
  }

  // Прогресс-сообщения от service worker.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "PROGRESS") return;
    const tone = msg.stage === "done" ? "ok" : "info";
    showToast(msg.text || "...", tone);
    if (msg.stage === "done") hideToastLater(8000);
  });

  // Notion — SPA: следим за перерисовками, чтобы кнопка не пропадала.
  ensureButton();
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.body, { childList: true, subtree: false });
})();
