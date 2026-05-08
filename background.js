// background.js
// 役割:
//   1. ツールバーアイコンのクリックで content.js を対象タブに注入する
//   2. content.js から送られてきた CSV 文字列をダウンロードする
//   3. 進捗・エラーをバッジで表示する
//
// fetch / HTML パース / CSV 生成は全て content.js（ページ context）側で行う。
// MV3 Service Worker では DOMParser が使えないため。

const TARGET_URL_RE = /^https:\/\/manage\.rentracks\.jp\/manage\/bill_index/;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url || !TARGET_URL_RE.test(tab.url)) {
    await flashBadge(tab?.id, "NG", "#c0392b");
    return;
  }

  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#2980b9", tabId: tab.id });
    await chrome.action.setBadgeText({ text: "...", tabId: tab.id });

    // content.js を注入。content.js 側で全ページ巡回 → CSV 生成し、
    // chrome.runtime.sendMessage で {type:"DOWNLOAD_CSV", csv, filename} を送ってくる
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (e) {
    console.error("[rentracks-scraper] inject failed:", e);
    await flashBadge(tab.id, "ERR", "#c0392b");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  const tabId = sender?.tab?.id;

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
