import * as pdfjsLib from "./lib/pdf.min.mjs";

const PDF_CHANNEL = "notionbot-pdf-text";
const PDF_RENDER_MAX_PAGES = 3;
const PDF_RENDER_MAX_DIMENSION = 1600;

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");

const channel = new BroadcastChannel(PDF_CHANNEL);

channel.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg?.id) return;

  if (msg.type === "EXTRACT_PDF_TEXT") {
    try {
      const text = await extractPdfText(new Uint8Array(msg.buffer));
      channel.postMessage({ type: "PDF_TEXT_RESULT", id: msg.id, ok: true, text });
    } catch (err) {
      channel.postMessage({
        type: "PDF_TEXT_RESULT",
        id: msg.id,
        ok: false,
        error: String(err?.message || err),
      });
    }
    return;
  }

  if (msg.type === "RENDER_PDF_TO_IMAGES") {
    try {
      const images = await renderPdfToImages(new Uint8Array(msg.buffer));
      channel.postMessage({ type: "PDF_IMAGES_RESULT", id: msg.id, ok: true, images });
    } catch (err) {
      channel.postMessage({
        type: "PDF_IMAGES_RESULT",
        id: msg.id,
        ok: false,
        error: String(err?.message || err),
      });
    }
  }
});

async function extractPdfText(bytes) {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });

  const doc = await loadingTask.promise;
  try {
    let out = "";
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      out += content.items.map((it) => it.str).join(" ") + "\n";
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

async function renderPdfToImages(bytes) {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });

  const doc = await loadingTask.promise;
  try {
    const images = [];
    const total = Math.min(doc.numPages, PDF_RENDER_MAX_PAGES);

    for (let p = 1; p <= total; p++) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(PDF_RENDER_MAX_DIMENSION / base.width, PDF_RENDER_MAX_DIMENSION / base.height, 2);
      const viewport = page.getViewport({ scale: Math.max(scale, 1) });

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push(canvas.toDataURL("image/jpeg", 0.82));
    }

    return images;
  } finally {
    await doc.destroy();
  }
}
