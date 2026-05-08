// options.js
// CSV 保存先フォルダを File System Access API で選び、ハンドルを IndexedDB に永続化する。
// background.js は DOWNLOAD_CSV 受信時にこのハンドルを読み出し、ハンドル経由で直接書き込む。
// 未設定 / 権限が失われた場合は chrome.downloads の保存ダイアログにフォールバックする。

document.addEventListener("DOMContentLoaded", async () => {
  const current = document.getElementById("current");
  const pickBtn = document.getElementById("pickFolder");
  const clearBtn = document.getElementById("clearFolder");
  const status = document.getElementById("status");

  await refreshCurrent();

  pickBtn.addEventListener("click", async () => {
    if (typeof window.showDirectoryPicker !== "function") {
      setStatus("このブラウザはフォルダ選択 API に対応していません", "err");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      const perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        setStatus("書き込み権限が許可されませんでした", "err");
        return;
      }
      await idbSetSaveFolder(handle);
      await refreshCurrent();
      setStatus(`フォルダ「${handle.name}」を保存先に設定しました`, "ok");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setStatus("フォルダ選択に失敗: " + (e?.message || e), "err");
    }
  });

  clearBtn.addEventListener("click", async () => {
    await idbClearSaveFolder();
    await refreshCurrent();
    setStatus("クリアしました(以降は保存ダイアログを表示)", "ok");
  });

  async function refreshCurrent() {
    const handle = await idbGetSaveFolder();
    if (!handle) {
      current.className = "current empty";
      current.textContent = "未設定 — 毎回保存ダイアログが開きます";
      clearBtn.disabled = true;
      return;
    }
    let permLabel = "";
    try {
      const perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") permLabel = " (権限: 付与済み)";
      else if (perm === "prompt") permLabel = " (権限: 次回 CSV取得 時に再確認)";
      else permLabel = " (権限: 拒否されています)";
    } catch (_) {
      permLabel = "";
    }
    current.className = "current";
    current.innerHTML = `保存先: <strong>${escapeHtml(handle.name)}</strong>${escapeHtml(permLabel)}`;
    clearBtn.disabled = false;
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = "status" + (kind ? ` ${kind}` : "");
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
