// popup.js
// デバッグモードのチェック状態を chrome.storage.local に保存し、
// 「CSV取得」ボタンで background に START_SCRAPE を送る。
// bill_index ページ以外にいる場合は管理画面トップに自動遷移する。

const BILL_INDEX_RE = /^https:\/\/manage\.rentracks\.jp\/manage\/bill_index/;
const FALLBACK_URL = "https://manage.rentracks.jp/manage/bill_index/index";

document.addEventListener("DOMContentLoaded", async () => {
  const checkbox = document.getElementById("debugMode");
  const runBtn = document.getElementById("run");
  const optionsLink = document.getElementById("openOptions");

  optionsLink.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  const { debugMode } = await chrome.storage.local.get(["debugMode"]);
  checkbox.checked = !!debugMode;

  checkbox.addEventListener("change", (e) => {
    chrome.storage.local.set({ debugMode: e.target.checked });
  });

  runBtn.addEventListener("click", async () => {
    // FSA 保存先フォルダがあれば、ユーザー操作内で書き込み権限をリクエストしておく
    // (background SW はユーザー操作を持たないので、ここで許可状態にしておかないと
    //  実際の書き込み時に permission が "prompt" のままで失敗する)
    try {
      const handle = await idbGetSaveFolder();
      if (handle) {
        let perm = await handle.queryPermission({ mode: "readwrite" });
        if (perm === "prompt") {
          perm = await handle.requestPermission({ mode: "readwrite" });
        }
        // perm が "granted" でなくても、background 側で query して fallback するので続行
      }
    } catch (e) {
      console.warn("[rentracks-scraper] FSA permission check failed:", e);
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (!tab.url || !BILL_INDEX_RE.test(tab.url)) {
      chrome.tabs.update(tab.id, { url: FALLBACK_URL });
      window.close();
      return;
    }

    chrome.runtime.sendMessage({ type: "START_SCRAPE", tabId: tab.id });
    window.close();
  });
});
