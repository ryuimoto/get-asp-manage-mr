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

  const scheduleCountdown = document.getElementById("scheduleCountdown");
  const scheduleCountdownTime = document.getElementById("scheduleCountdownTime");
  const scheduleCountdownRemaining = document.getElementById("scheduleCountdownRemaining");
  let nextFireMs = null;
  let countdownInterval = null;

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

  // 自動実行スケジュールのカウントダウン
  await refreshCountdown();

  // storage 監視: スクレイピング進捗 + スケジュール変更
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.scrapeStatus) {
      const status = changes.scrapeStatus.newValue;
      if (status) {
        if (status.inProgress && progressSection.hidden) {
          showProgressSection();
        }
        applyStatus(status);
      }
    }
    if (area === "local" && changes.schedule) {
      refreshCountdown();
    }
  });

  async function refreshCountdown() {
    const { schedule } = await chrome.storage.local.get(["schedule"]);
    if (!schedule?.enabled || !schedule?.time) {
      scheduleCountdown.hidden = true;
      stopCountdownTicker();
      return;
    }
    scheduleCountdown.hidden = false;
    scheduleCountdownTime.textContent = schedule.time;
    nextFireMs = computeNextFire(schedule.time);
    startCountdownTicker();
  }

  function startCountdownTicker() {
    stopCountdownTicker();
    const tick = () => {
      let remaining = nextFireMs - Date.now();
      if (remaining <= 0) {
        // 発火時刻を過ぎたら次回(翌日同時刻)へリセット
        nextFireMs = computeNextFire(scheduleCountdownTime.textContent);
        remaining = nextFireMs - Date.now();
      }
      scheduleCountdownRemaining.textContent = `(あと ${formatRemaining(remaining)})`;
    };
    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  function stopCountdownTicker() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = null;
  }

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
      case "writing":
        progressStatus.textContent = "出力中…";
        progressBar.removeAttribute("value");
        progressDetail.textContent = "";
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

function computeNextFire(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function formatRemaining(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
