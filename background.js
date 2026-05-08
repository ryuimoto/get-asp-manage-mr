// background.js
// 役割:
//   1. popup の「CSV取得」ボタンから START_SCRAPE を受けて content.js を注入する
//   2. content.js から送られてきた CSV 文字列をダウンロードする
//   3. 進捗・エラーをバッジで表示する
//
// fetch / HTML パース / CSV 生成は全て content.js（ページ context）側で行う。
// MV3 Service Worker では DOMParser が使えないため。

importScripts("idb.js");

const TARGET_URL_RE = /^https:\/\/manage\.rentracks\.jp\/manage\/bill_index/;

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

async function saveCsv(csv, baseName, tabId) {
  // BOM 付き UTF-8 で保存する
  const csvWithBom = "﻿" + csv;

  // FSA ハンドルが永続化されていればそこに直接書き込む
  try {
    const handle = await idbGetSaveFolder();
    if (handle) {
      const perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") {
        try {
          const fileHandle = await handle.getFileHandle(baseName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(new Blob([csvWithBom], { type: "text/csv;charset=utf-8" }));
          await writable.close();
          chrome.action.setBadgeText({ text: "OK", tabId });
          setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2000);
          return;
        } catch (e) {
          console.error("[rentracks-scraper] FSA write failed:", e);
          // 書き込みに失敗したら下のフォールバックへ
        }
      } else {
        console.warn("[rentracks-scraper] FSA permission not granted:", perm);
      }
    }
  } catch (e) {
    console.warn("[rentracks-scraper] FSA path skipped:", e);
  }

  // フォールバック: chrome.downloads で保存ダイアログを表示
  const dataUrl =
    "data:text/csv;charset=utf-8," + encodeURIComponent(csvWithBom);
  chrome.downloads.download(
    { url: dataUrl, filename: baseName, saveAs: true },
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
}
