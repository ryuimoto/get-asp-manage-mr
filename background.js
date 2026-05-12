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

// SW 起動時にスケジュールから chrome.alarms を再構築する。
applySchedule();

// options 画面でスケジュールが変更されたら alarm を再設定する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.schedule) applySchedule();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "dailyScrape") return;
  runScheduledScrape();
});

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

  if (msg.type === "OUTPUT_RESULT") {
    handleOutputResult(msg, tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "ERROR") {
    console.warn("[rentracks-scraper] content error:", msg.error);
    flashBadge(tabId, "ERR", "#c0392b");
    notifyIfScheduled("error", msg.error || "(エラー詳細不明)");
    return;
  }
});

async function flashBadge(tabId, text, color) {
  if (tabId == null) return;
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
  await chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2500);
}

// 出力先(CSV / スプシ / 両方)に応じて分岐実行する。
// content.js は writing phase を立てて待つので、ここで最終的に done/error をセットする。
async function handleOutputResult(msg, tabId) {
  const { outputMode = "csv" } = await chrome.storage.local.get(["outputMode"]);
  const wantCsv = outputMode === "csv" || outputMode === "both";
  const wantSheets = outputMode === "sheets" || outputMode === "both";

  const results = [];
  if (wantCsv) {
    results.push(await saveCsv(msg.csv, msg.filename || "rentracks.csv", tabId));
  }
  if (wantSheets) {
    results.push(
      await postToSheets(msg.columns || [], msg.rows || [], msg.timestamp, tabId)
    );
  }

  const allOk = results.length > 0 && results.every((r) => r.ok);
  const firstError = results.find((r) => !r.ok);
  try {
    await chrome.storage.session.set({
      scrapeStatus: allOk
        ? { inProgress: false, phase: "done" }
        : { inProgress: false, phase: "error", errorMessage: firstError?.error || "(不明)" },
    });
  } catch (e) {
    console.warn("[rentracks-scraper] setScrapeStatus from bg failed:", e);
  }
}

function saveCsv(csv, baseName, tabId) {
  // BOM 付き UTF-8 で保存する
  const csvWithBom = "﻿" + csv;

  // 常にダイアログ無しで ~/Downloads/ 配下に直接保存(同名は Chrome が連番付与)。
  // saveSubfolder 設定があれば ~/Downloads/<saveSubfolder>/<baseName>、未設定なら ~/Downloads/<baseName>。
  return new Promise((resolve) => {
    chrome.storage.local.get(["saveSubfolder"], ({ saveSubfolder }) => {
      const subfolder = (saveSubfolder || "").trim();
      const filename = subfolder ? `${subfolder}/${baseName}` : baseName;
      const dataUrl =
        "data:text/csv;charset=utf-8," + encodeURIComponent(csvWithBom);

      chrome.downloads.download(
        { url: dataUrl, filename, saveAs: false },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId == null) {
            console.error("[rentracks-scraper] download failed:", chrome.runtime.lastError);
            flashBadge(tabId, "ERR", "#c0392b");
            notifyIfScheduled("error", "CSV のダウンロードに失敗しました");
            resolve({ ok: false, error: "CSV ダウンロード失敗" });
            return;
          }
          chrome.action.setBadgeText({ text: "OK", tabId });
          setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2000);
          notifyIfScheduled("ok", `CSV を保存しました: ${filename}`);
          resolve({ ok: true });
        }
      );
    });
  });
}

// Apps Script Web App に JSON を POST してスプシ追記する。
// 失敗時はエラー通知 + ERR バッジを出して { ok: false, error } を返す。
async function postToSheets(columns, rows, timestamp, tabId) {
  const { sheetsWebAppUrl } = await chrome.storage.local.get(["sheetsWebAppUrl"]);
  if (!sheetsWebAppUrl) {
    flashBadge(tabId, "ERR", "#c0392b");
    notifyIfScheduled("error", "スプシ URL が未設定です(設定画面で入力してください)");
    return { ok: false, error: "スプシ URL 未設定" };
  }
  try {
    const res = await fetch(sheetsWebAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns, rows, timestamp: timestamp || Date.now() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("レスポンスが JSON ではありません");
    }
    if (result.ok === false) throw new Error(result.error || "GAS error");
    chrome.action.setBadgeText({ text: "OK", tabId });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }), 2000);
    notifyIfScheduled("ok", `スプシに ${rows.length} 行追記しました`);
    return { ok: true };
  } catch (e) {
    console.error("[rentracks-scraper] sheets failed:", e);
    flashBadge(tabId, "ERR", "#c0392b");
    notifyIfScheduled("error", `スプシ送信失敗: ${e.message}`);
    return { ok: false, error: `スプシ送信失敗: ${e.message}` };
  }
}

// ============ スケジュール実行 ============

function computeNextFire(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function applySchedule() {
  try {
    await chrome.alarms.clear("dailyScrape");
    const { schedule } = await chrome.storage.local.get(["schedule"]);
    if (!schedule?.enabled || !schedule?.time) return;
    const fireAt = computeNextFire(schedule.time);
    await chrome.alarms.create("dailyScrape", { when: fireAt });
    console.log("[rentracks-scraper] alarm scheduled at", new Date(fireAt).toString());
  } catch (e) {
    console.warn("[rentracks-scraper] applySchedule failed:", e);
  }
}

async function runScheduledScrape() {
  try {
    console.log("[rentracks-scraper] scheduled scrape firing");
    let tabs = await chrome.tabs.query({
      url: "https://manage.rentracks.jp/manage/bill_index*",
    });
    let tabId;
    if (tabs.length > 0) {
      tabId = tabs[0].id;
    } else {
      const tab = await chrome.tabs.create({
        url: "https://manage.rentracks.jp/manage/bill_index/index",
        active: false,
      });
      tabId = tab.id;
      await waitForTabComplete(tabId);
    }
    await chrome.storage.session.set({ scheduledRunPending: true });
    startScrape(tabId);
  } catch (e) {
    console.error("[rentracks-scraper] scheduled scrape failed:", e);
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Rentracks 自動取得 失敗",
      message: String(e?.message || e),
    });
  } finally {
    // 発火後に次回時刻を再スケジュール(drift 防止)
    applySchedule();
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function notifyIfScheduled(kind, message) {
  try {
    const { scheduledRunPending } = await chrome.storage.session.get([
      "scheduledRunPending",
    ]);
    if (!scheduledRunPending) return;
    await chrome.storage.session.set({ scheduledRunPending: false });
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: kind === "ok" ? "Rentracks 自動取得 完了" : "Rentracks 自動取得 失敗",
      message: String(message || ""),
    });
  } catch (e) {
    console.warn("[rentracks-scraper] notifyIfScheduled failed:", e);
  }
}
