// popup.js
// デバッグモードのチェック状態を chrome.storage.local に保存し、
// 「CSV取得」ボタンで background に START_SCRAPE を送る。
// bill_index ページ以外にいる場合は管理画面トップに自動遷移する。
// スクレイピング中は progress section に切り替えて進捗バーを表示。
// content.js が chrome.storage.session.scrapeStatus に書く状態を購読し、
// popup を閉じて再度開いても進行中なら復元する。

const BILL_INDEX_RE = /^https:\/\/manage\.rentracks\.jp\/manage\/bill_index/;
const FALLBACK_URL = "https://manage.rentracks.jp/manage/bill_index/index";

document.addEventListener("DOMContentLoaded", async () => {
  const formSection = document.getElementById("formSection");
  const progressSection = document.getElementById("progressSection");
  const progressStatus = document.getElementById("progressStatus");
  const progressBar = document.getElementById("progressBar");
  const progressDetail = document.getElementById("progressDetail");
  const progressClose = document.getElementById("progressClose");

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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (!tab.url || !BILL_INDEX_RE.test(tab.url)) {
      chrome.tabs.update(tab.id, { url: FALLBACK_URL });
      window.close();
      return;
    }

    showProgressSection();
    applyStatus({ inProgress: true, phase: "starting" });
    chrome.runtime.sendMessage({ type: "START_SCRAPE", tabId: tab.id });
  });

  progressClose.addEventListener("click", () => window.close());

  // 起動時の状態復元
  const { scrapeStatus } = await chrome.storage.session.get(["scrapeStatus"]);
  if (scrapeStatus?.inProgress) {
    showProgressSection();
    applyStatus(scrapeStatus);
  }

  // スクレイピング進捗をライブ更新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    if (!changes.scrapeStatus) return;
    const status = changes.scrapeStatus.newValue;
    if (!status) return;
    // progress section が表示されていなくても、進行中になったら切り替える
    if (status.inProgress && progressSection.hidden) {
      showProgressSection();
    }
    applyStatus(status);
  });

  function showProgressSection() {
    formSection.hidden = true;
    progressSection.hidden = false;
  }

  function applyStatus(status) {
    if (!status) return;
    progressStatus.classList.remove("error", "done");
    switch (status.phase) {
      case "starting":
        progressStatus.textContent = "開始中…";
        progressBar.removeAttribute("value");
        progressDetail.textContent = "";
        break;
      case "switching":
        progressStatus.textContent = "ページサイズ切替中…";
        progressBar.removeAttribute("value");
        progressDetail.textContent = "";
        break;
      case "fetching":
        progressStatus.textContent = "取得中…";
        if (status.total) {
          progressBar.value = (status.current / status.total) * 100;
          progressDetail.textContent = `${status.current} / ${status.total} ページ`;
        } else {
          progressBar.removeAttribute("value");
          progressDetail.textContent = "";
        }
        break;
      case "done":
        progressStatus.textContent = "完了!";
        progressStatus.classList.add("done");
        progressBar.value = 100;
        progressDetail.textContent = "";
        break;
      case "error":
        progressStatus.textContent = `エラー: ${status.errorMessage || "(不明)"}`;
        progressStatus.classList.add("error");
        progressBar.value = 0;
        progressDetail.textContent = "";
        break;
    }
  }
});
