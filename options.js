// options.js
// CSV 保存先サブフォルダ(Downloads 配下)を chrome.storage.local に保存する。
// background.js は DOWNLOAD_CSV 受信時にこの値を読み、
//   - 値あり → ~/Downloads/<saveSubfolder>/<filename> にダイアログ無しで保存
//   - 空欄  → saveAs:true で毎回保存ダイアログ

const FORBIDDEN_CHARS_RE = /[\\:*?"<>|]/;

document.addEventListener("DOMContentLoaded", async () => {
  const input = document.getElementById("saveSubfolder");
  const saveBtn = document.getElementById("saveSubfolderBtn");
  const clearBtn = document.getElementById("clearSubfolderBtn");
  const preview = document.getElementById("subfolderPreview");
  const status = document.getElementById("subfolderStatus");

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
    setStatus("クリアしました(以降は保存ダイアログを表示)", "ok");
  });

  function updatePreview() {
    const result = normalizeSubfolder(input.value);
    if (result.error) {
      preview.innerHTML = `<span style="color:#c0392b">${escapeHtml(result.error)}</span>`;
      return;
    }
    if (!result.value) {
      preview.innerHTML = "保存先: <strong>毎回ダイアログを表示</strong>";
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
