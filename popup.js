// popup.js
// デバッグモードのチェック状態を chrome.storage.local に保存し、
// 「CSV取得」ボタンで background に START_SCRAPE を送る。

document.addEventListener("DOMContentLoaded", async () => {
  const checkbox = document.getElementById("debugMode");
  const runBtn = document.getElementById("run");

  const { debugMode } = await chrome.storage.local.get(["debugMode"]);
  checkbox.checked = !!debugMode;

  checkbox.addEventListener("change", (e) => {
    chrome.storage.local.set({ debugMode: e.target.checked });
  });

  runBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.runtime.sendMessage({ type: "START_SCRAPE", tabId: tab.id });
    window.close();
  });
});
