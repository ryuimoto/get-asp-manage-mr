// background.js
// 役割:
//   1. popup の「CSV取得」ボタンから START_SCRAPE を受けて content.js を注入する
//   2. content.js から送られてきた CSV 文字列をダウンロードする
//   3. 進捗・エラーをバッジで表示する
//
// fetch / HTML パース / CSV 生成は全て content.js（ページ context）側で行う。
// MV3 Service Worker では DOMParser が使えないため。

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
    const dataUrl =
      "data:text/csv;charset=utf-8," +
      encodeURIComponent("﻿" + msg.csv);
    chrome.downloads.download(
      { url: dataUrl, filename: msg.filename || "rentracks.csv", saveAs: true },
      () => {
        chrome.action.setBadgeText({ text: "OK", tabId });
        setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2000);
      }
    );
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
