// options.js
// CSV 保存先サブフォルダ(Downloads 配下)を chrome.storage.local に保存する。
// background.js は DOWNLOAD_CSV 受信時にこの値を読み、
//   - 値あり → ~/Downloads/<saveSubfolder>/<filename> にダイアログ無しで保存
//   - 空欄  → saveAs:true で毎回保存ダイアログ

const FORBIDDEN_CHARS_RE = /[\\:*?"<>|]/;
const SHEETS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(\?.*)?$/;

document.addEventListener("DOMContentLoaded", async () => {
  const input = document.getElementById("saveSubfolder");
  const saveBtn = document.getElementById("saveSubfolderBtn");
  const clearBtn = document.getElementById("clearSubfolderBtn");
  const preview = document.getElementById("subfolderPreview");
  const status = document.getElementById("subfolderStatus");

  // schedule section
  const scheduleEnabled = document.getElementById("scheduleEnabled");
  const scheduleTime = document.getElementById("scheduleTime");
  const scheduleSaveBtn = document.getElementById("scheduleSave");
  const schedulePreview = document.getElementById("schedulePreview");
  const scheduleStatus = document.getElementById("scheduleStatus");

  const { saveSubfolder } = await chrome.storage.local.get(["saveSubfolder"]);
  input.value = saveSubfolder || "";
  updatePreview();

  input.addEventListener("input", () => {
    setStatus("", "");
    updatePreview();
  });

  saveBtn.addEventListener("click", async () => {
    const result = normalizeSubfolder(input.value);
    if (result.error) {
      setStatus(result.error, "err");
      return;
    }
    input.value = result.value;
    await chrome.storage.local.set({ saveSubfolder: result.value });
    updatePreview();
    setStatus("保存しました", "ok");
  });

  clearBtn.addEventListener("click", async () => {
    input.value = "";
    await chrome.storage.local.set({ saveSubfolder: "" });
    updatePreview();
    setStatus("クリアしました(~/Downloads/ 直下に保存)", "ok");
  });

  // === schedule ===
  const { schedule } = await chrome.storage.local.get(["schedule"]);
  if (schedule) {
    scheduleEnabled.checked = !!schedule.enabled;
    if (schedule.time) scheduleTime.value = schedule.time;
  }
  updateSchedulePreview();

  scheduleEnabled.addEventListener("change", updateSchedulePreview);
  scheduleTime.addEventListener("input", updateSchedulePreview);

  scheduleSaveBtn.addEventListener("click", async () => {
    const value = scheduleTime.value;
    if (!/^\d{2}:\d{2}$/.test(value)) {
      setScheduleStatus("時刻の形式が不正です", "err");
      return;
    }
    await chrome.storage.local.set({
      schedule: { enabled: scheduleEnabled.checked, time: value },
    });
    updateSchedulePreview();
    setScheduleStatus("保存しました", "ok");
  });

  // === Google スプシ連携 ===
  const sheetsUrlInput = document.getElementById("sheetsWebAppUrl");
  const sheetsUrlSaveBtn = document.getElementById("sheetsUrlSaveBtn");
  const sheetsTestBtn = document.getElementById("sheetsTestBtn");
  const sheetsStatus = document.getElementById("sheetsStatus");
  const outputModeRadios = document.querySelectorAll('input[name="outputMode"]');

  const { outputMode, sheetsWebAppUrl } = await chrome.storage.local.get([
    "outputMode",
    "sheetsWebAppUrl",
  ]);
  const currentMode = outputMode || "csv";
  for (const r of outputModeRadios) {
    if (r.value === currentMode) r.checked = true;
  }
  sheetsUrlInput.value = sheetsWebAppUrl || "";

  for (const r of outputModeRadios) {
    r.addEventListener("change", async () => {
      if (r.checked) {
        await chrome.storage.local.set({ outputMode: r.value });
      }
    });
  }

  sheetsUrlInput.addEventListener("input", () => setSheetsStatus("", ""));

  sheetsUrlSaveBtn.addEventListener("click", async () => {
    const v = sheetsUrlInput.value.trim();
    if (v && !SHEETS_URL_RE.test(v)) {
      setSheetsStatus("URL 形式が不正です(https://script.google.com/macros/s/.../exec)", "err");
      return;
    }
    await chrome.storage.local.set({ sheetsWebAppUrl: v });
    setSheetsStatus(v ? "保存しました" : "クリアしました", "ok");
  });

  sheetsTestBtn.addEventListener("click", async () => {
    const v = sheetsUrlInput.value.trim();
    if (!v || !SHEETS_URL_RE.test(v)) {
      setSheetsStatus("URL が未保存または不正です", "err");
      return;
    }
    setSheetsStatus("送信中…", "");
    try {
      const res = await fetch(v, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          columns: ["test"],
          rows: [["ok"]],
          timestamp: Date.now(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error("レスポンスが JSON ではありません: " + text.slice(0, 80));
      }
      if (result.ok === false) throw new Error(result.error || "GAS error");
      setSheetsStatus(`送信成功(written=${result.written ?? "?"})`, "ok");
    } catch (e) {
      setSheetsStatus(`送信失敗: ${e.message}`, "err");
    }
  });

  function setSheetsStatus(text, kind) {
    sheetsStatus.textContent = text;
    sheetsStatus.className = "status" + (kind ? ` ${kind}` : "");
  }

  function updateSchedulePreview() {
    if (!scheduleEnabled.checked) {
      schedulePreview.innerHTML = "自動実行: <strong>無効</strong>";
      return;
    }
    const value = scheduleTime.value;
    if (!/^\d{2}:\d{2}$/.test(value)) {
      schedulePreview.innerHTML = "";
      return;
    }
    const next = new Date(computeNextFire(value));
    const wd = "日月火水木金土"[next.getDay()];
    const yyyy = next.getFullYear();
    const mm = String(next.getMonth() + 1).padStart(2, "0");
    const dd = String(next.getDate()).padStart(2, "0");
    const hh = String(next.getHours()).padStart(2, "0");
    const mi = String(next.getMinutes()).padStart(2, "0");
    schedulePreview.innerHTML = `次回実行: <strong>${yyyy}-${mm}-${dd} (${wd}) ${hh}:${mi}</strong>`;
  }

  function setScheduleStatus(text, kind) {
    scheduleStatus.textContent = text;
    scheduleStatus.className = "status" + (kind ? ` ${kind}` : "");
  }

  function updatePreview() {
    const result = normalizeSubfolder(input.value);
    if (result.error) {
      preview.innerHTML = `<span style="color:#c0392b">${escapeHtml(result.error)}</span>`;
      return;
    }
    if (!result.value) {
      preview.innerHTML = "保存先: <strong>~/Downloads/</strong>(サブフォルダ無し)";
      return;
    }
    preview.innerHTML = `保存先: <strong>~/Downloads/${escapeHtml(result.value)}/</strong>`;
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = "status" + (kind ? ` ${kind}` : "");
  }
});

function normalizeSubfolder(raw) {
  let s = (raw || "").trim();
  if (!s) return { value: "", error: "" };

  s = s.replace(/\\/g, "/");
  s = s.replace(/^\/+|\/+$/g, "");
  s = s.replace(/\/{2,}/g, "/");

  if (!s) return { value: "", error: "" };

  const segments = s.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      return { value: raw, error: `不正なパスセグメント: "${seg || "(空)"}"` };
    }
    if (FORBIDDEN_CHARS_RE.test(seg)) {
      return { value: raw, error: `使用できない文字が含まれています: ${seg}` };
    }
  }

  return { value: s, error: "" };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function computeNextFire(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}
