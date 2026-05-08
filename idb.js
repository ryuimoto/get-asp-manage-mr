// idb.js
// 拡張内で共有する IndexedDB ヘルパ。
// FileSystemDirectoryHandle は JSON 化できないため chrome.storage.local には入れられず、
// IndexedDB に置く必要がある。popup/options/service worker のどこからでも同じキーを読み書きできる。

(function () {
  const DB_NAME = "rentracks-scraper-fsa";
  const STORE = "handles";
  const HANDLE_KEY = "saveFolder";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  globalThis.idbGetSaveFolder = async function () {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  };

  globalThis.idbSetSaveFolder = async function (handle) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };

  globalThis.idbClearSaveFolder = async function () {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  };
})();
