// background.js
// 役割:
//   1. popup の「CSV取得」ボタンから START_SCRAPE を受けて content.js を注入する
//   2. content.js から送られてきた CSV 文字列をダウンロードする
//   3. 進捗・エラーをバッジで表示する
//
// fetch / HTML パース / CSV 生成は全て content.js（ページ context）側で行う。
// MV3 Service Worker では DOMParser が使えないため。

const TARGET_URL_RE = /^https:\/\/manage\.rentracks\.jp\/manage\/bill_index/;

// content script(chrome.scripting.executeScript で注入される untrusted context)
// から chrome.storage.session を読み書きできるよう、アクセスレベルを明示する。
// これを設定しないと content.js の setScrapeStatus が silent に拒否され、popup の進捗バーが「開始中…」のまま固まる。
chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch((e) => console.warn("[rentracks-scraper] setAccessLevel failed:", e));

async function startScrape(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return;
  }
  if (!tab || !tab.url || !TARGET_URL_RE.test(tab.url)) {
    await flashBadge(tabId, "NG", "#c0392b");
    return;
  }

  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#2980b9", tabId });
    await chrome.action.setBadgeText({ text: "...", tabId });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    console.error("[rentracks-scraper] inject failed:", e);
    await flashBadge(tabId, "ERR", "#c0392b");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  const tabId = sender?.tab?.id;

  if (msg.type === "START_SCRAPE") {
    startScrape(msg.tabId);
    return;
  }

  if (msg.type === "PROGRESS") {
    chrome.action.setBadgeBackgroundColor({ color: "#2980b9", tabId });
    chrome.action.setBadgeText({ text: msg.text || "", tabId });
    return;
  }

  if (msg.type === "DOWNLOAD_CSV") {
    const baseName = msg.filename || "rentracks.csv";
    saveCsv(msg.csv, baseName, tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "ERROR") {
    console.warn("[rentracks-scraper] content error:", msg.error);
    flashBadge(tabId, "ERR", "#c0392b");
    return;
  }
});

async function flashBadge(tabId, text, color) {
  if (tabId == null) return;
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
  await chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2500);
}

function saveCsv(csv, baseName, tabId) {
  // BOM 付き UTF-8 で保存する
  const csvWithBom = "﻿" + csv;

  // saveSubfolder 設定があれば ~/Downloads/<saveSubfolder>/<baseName> にダイアログ無しで保存。
  // 未設定なら saveAs:true で保存ダイアログ。
  chrome.storage.local.get(["saveSubfolder"], ({ saveSubfolder }) => {
    const subfolder = (saveSubfolder || "").trim();
    const filename = subfolder ? `${subfolder}/${baseName}` : baseName;
    const saveAs = !subfolder;
    const dataUrl =
      "data:text/csv;charset=utf-8," + encodeURIComponent(csvWithBom);

    chrome.downloads.download(
      { url: dataUrl, filename, saveAs },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId == null) {
          console.error("[rentracks-scraper] download failed:", chrome.runtime.lastError);
          flashBadge(tabId, "ERR", "#c0392b");
          return;
        }
        chrome.action.setBadgeText({ text: "OK", tabId });
        setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2000);
      }
    );
  });
}
