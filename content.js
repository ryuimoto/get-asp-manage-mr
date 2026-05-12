// content.js
// Rentracks 広告案件一覧（manage.rentracks.jp/manage/bill_index）を全ページ巡回し、
// 各 .advtable2 カードをパースして CSV を生成 → background.js へ送信してダウンロード。
//
// アーキテクチャ:
//   - 1ページ目: 現在の DOM をそのまま使う
//   - 2ページ目以降: fetch(`/manage/bill_index/index/${N}`, { credentials: "include" })
//   - 各 HTML を DOMParser でパースし、table.advtable2 をすべて抽出
//   - 列ヘッダはカードに登場した全キーのユニオン（基本列を先頭固定、新出キーは末尾追加）

(async () => {
  const ORIGIN = "https://manage.rentracks.jp";
  const PAGE1_URL = `${ORIGIN}/manage/bill_index/index`;
  const FETCH_INTERVAL_MS = 300;

  // 列ヘッダの優先順序（この順で先に固定。実カードに無い列は空欄）
  const PRIMARY_COLUMNS = [
    "プロダクトID",
    "案件名",
    "LP_URL",
    "提携状態",
    "広告主ID",
    "広告主名",
    "報酬形態",
    "報酬額",
    "承認有効期限",
    "再訪問有効期限",
    "承認率",
    "CVR",
    "CTR",
    "EPC",
    "掲載_リスティング",
    "掲載_ディスプレイ広告",
    "掲載_FB集客",
    "掲載_twitter集客",
    "掲載_メルマガ集客",
    "掲載_ポイントサイト",
    "掲載_本人申込",
    "掲載_その他ソーシャル",
    "掲載_ITP対応",
    "掲載_拒否理由表示",
  ];
  const TRAILING_COLUMNS = ["サイトの紹介"];

  try {
    const { debugMode: debugModeRaw } = await chrome.storage.local.get(["debugMode"]);
    const debugMode = !!debugModeRaw;
    log("start", debugMode ? "(debug mode)" : "");
    await setScrapeStatus({ inProgress: true, phase: "starting" });

    // === 0. 対象ページかチェック ===
    if (!/\/manage\/bill_index/.test(location.pathname)) {
      throw new Error("対象ページではありません。bill_index で検索を実行してから起動してください。");
    }

    // === 1. ページサイズ自動切替 ===
    // pageSize が 50 でなければ、フォームを fetch で POST して
    // server-side session を 50 に更新し、応答 HTML を1ページ目として使う。
    // (debugMode のときは1件しか取らないので切替不要)
    // 100 にしない理由: server が 100 件レンダリングで 504 を返しやすいため、
    // 総時間と安定性のバランスで 50 を採用。
    let firstDoc = document;
    const pageSizeSelect = document.querySelector('select[name="idPageSize"]');
    if (!debugMode && pageSizeSelect && pageSizeSelect.value !== "50") {
      log(`page size = ${pageSizeSelect.value}, switching to 50 via fetch`);
      sendProgress("切替");
      await setScrapeStatus({ inProgress: true, phase: "switching" });
      firstDoc = await switchToPageSize50(pageSizeSelect);
      log("page size switched to 50");
    }

    // === 2. 1ページ目をパース ===
    const firstCards = firstDoc.querySelectorAll("table.advtable2");
    if (firstCards.length === 0) {
      throw new Error("結果カード(.advtable2)が見つかりません。検索を実行してから拡張機能を起動してください。");
    }

    const allRows = []; // { 列名: 値 } の配列
    const seenKeys = new Set();

    if (debugMode) {
      // デバッグモード: 先頭1件のみ残してページャ巡回はスキップ
      const first = parseAdvCard(firstCards[0]);
      allRows.push(first);
      Object.keys(first).forEach((k) => seenKeys.add(k));
      log("debug mode: 1件のみで終了");
    } else {
      for (const t of firstCards) {
        const row = parseAdvCard(t);
        allRows.push(row);
        Object.keys(row).forEach((k) => seenKeys.add(k));
      }

      // === 3. ページャ解析 ===
      const pager = analyzePager(firstDoc);
      log(`first page parsed. cards=${firstCards.length}, totalPages=${pager.totalPages}`);

      // === 4. 2ページ目以降を fetch ===
      for (let p = 2; p <= pager.totalPages; p++) {
        sendProgress(`${p}/${pager.totalPages}`);
        await setScrapeStatus({
          inProgress: true,
          phase: "fetching",
          current: p,
          total: pager.totalPages,
        });
        const url = pager.urlFor(p);
        const html = await fetchHtml(url);
        const doc = new DOMParser().parseFromString(html, "text/html");

        if (isLoginPage(doc)) {
          throw new Error("セッションが切れた可能性があります。再ログインしてやり直してください。");
        }

        const cards = doc.querySelectorAll("table.advtable2");
        log(`page ${p}: cards=${cards.length}`);
        for (const t of cards) {
          const row = parseAdvCard(t);
          allRows.push(row);
          Object.keys(row).forEach((k) => seenKeys.add(k));
        }

        await sleep(FETCH_INTERVAL_MS);
      }
    }

    // === 5. 列順を決定 ===
    const extras = Array.from(seenKeys).filter(
      (k) => !PRIMARY_COLUMNS.includes(k) && !TRAILING_COLUMNS.includes(k)
    );
    extras.sort();
    const columns = [...PRIMARY_COLUMNS, ...extras, ...TRAILING_COLUMNS];

    // === 6. CSV 生成 ===
    const matrix = [columns];
    for (const row of allRows) {
      matrix.push(columns.map((c) => row[c] ?? ""));
    }
    const csv = toCSV(matrix);

    // === 7. background へ送信 ===
    log(`done. rows=${allRows.length}, cols=${columns.length}`);
    await setScrapeStatus({ inProgress: true, phase: "writing" });
    const rowsArr = allRows.map((r) => columns.map((c) => r[c] ?? ""));
    chrome.runtime.sendMessage({
      type: "OUTPUT_RESULT",
      csv,
      filename: makeFilename(debugMode),
      columns,
      rows: rowsArr,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.error("[rentracks-scraper]", e);
    await setScrapeStatus({
      inProgress: false,
      phase: "error",
      errorMessage: String(e?.message || e),
    });
    chrome.runtime.sendMessage({ type: "ERROR", error: String(e?.message || e) });
    alert(`[Rentracks 一覧取得] エラー: ${e?.message || e}`);
  }

  // ============ パース系ヘルパ ============

  function parseAdvCard(table) {
    const out = {};
    const rows = Array.from(table.querySelectorAll(":scope > tbody > tr"));

    for (const tr of rows) {
      const th = tr.querySelector(":scope > th");
      if (!th) continue;
      const label = collapseSpaces(th.textContent);

      if (label === "プロダクト") {
        const numDl = tr.querySelector("dl.numbers");
        if (numDl) {
          out["プロダクトID"] = txt(numDl.querySelector("dt"));
          out["提携状態"] = txt(numDl.querySelector("dd.numbers-state span")) ||
                          txt(numDl.querySelector("dd.numbers-state"));
          const a = numDl.querySelector("dd:not(.numbers-state) a");
          out["案件名"] = a ? collapseSpaces(a.textContent) : "";
          out["LP_URL"] = a ? a.getAttribute("href") || "" : "";
        }
        const types = tr.querySelector("dl.types");
        out["報酬形態"]       = pickDl(types, "報酬形態");
        out["報酬額"]         = pickDl(types, "報酬額");
        out["承認有効期限"]   = pickDl(types, "承認有効期限");
        out["再訪問有効期限"] = pickDl(types, "再訪問有効期限");
      }
      else if (label === "広告主") {
        const dl = tr.querySelector("dl.numbers");
        if (dl) {
          out["広告主ID"] = txt(dl.querySelector("dt"));
          out["広告主名"] = txt(dl.querySelector("dd"));
        }
      }
      else if (label === "サイトの紹介") {
        const td = tr.querySelector(":scope > td");
        out["サイトの紹介"] = td ? extractDescriptionText(td) : "";
      }
      else if (label === "データ") {
        const types = tr.querySelector("dl.types");
        out["承認率"] = pickDl(types, "承認率");
        out["CVR"]   = pickDl(types, "CVR");
        out["CTR"]   = pickDl(types, "CTR");
        out["EPC"]   = pickDl(types, "EPC");
      }
      else if (label === "検索条件") {
        const dls = tr.querySelectorAll("div.meta_group dl");
        for (const dl of dls) {
          const k = txt(dl.querySelector("dt"));
          const v = txt(dl.querySelector("dd"));
          if (k) out[`掲載_${k}`] = v;
        }
      }
    }
    return out;
  }

  function pickDl(dl, key) {
    if (!dl) return "";
    const dts = dl.querySelectorAll("dt");
    for (const dt of dts) {
      // dt が <a>ラベル</a><a>[？]</a> 構造のケース(承認率/CVR/CTR/EPC など)に対応するため、
      // 最初の <a> のテキストを優先してラベル比較する。a が無ければ dt 全体を見る。
      const firstA = dt.querySelector("a");
      const label = collapseSpaces(firstA ? firstA.textContent : dt.textContent);
      if (label === key) {
        const dd = dt.nextElementSibling;
        if (dd) {
          const a = dd.querySelector("a");
          return collapseSpaces((a || dd).textContent);
        }
      }
    }
    return "";
  }

  function extractDescriptionText(td) {
    const clone = td.cloneNode(true);
    clone.querySelectorAll(
      "table.metatable, h3.metatitle, div.closetrigger, div.modal-box, script, style"
    ).forEach((n) => n.remove());
    let s = clone.innerHTML
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    s = decodeEntities(s)
      .replace(/ /g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return s;
  }

  function decodeEntities(s) {
    const ta = document.createElement("textarea");
    ta.innerHTML = s;
    return ta.value;
  }

  function analyzePager(doc) {
    const links = doc.querySelectorAll(
      'ul.pager a[data-ci-pagination-page], ul.pager a[href]'
    );
    let max = 1;
    for (const a of links) {
      const attr = a.getAttribute("data-ci-pagination-page");
      if (attr) {
        const n = parseInt(attr, 10);
        if (Number.isFinite(n) && n > max) max = n;
        continue;
      }
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/bill_index\/index\/(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return {
      totalPages: max,
      urlFor: (n) => (n <= 1 ? PAGE1_URL : `${PAGE1_URL}/${n}`),
    };
  }

  function isLoginPage(doc) {
    return !!(
      doc.querySelector('form[action*="login"]') ||
      doc.querySelector('input[name="password"]')
    );
  }

  // フォームを fetch で POST して idPageSize を 50 に切り替え、
  // 応答 HTML を Document として返す。サーバ session も同時に更新される。
  async function switchToPageSize50(pageSizeSelect) {
    const form = pageSizeSelect.closest("form");
    if (!form) throw new Error("idPageSize の親フォームが見つかりません");

    const fd = new FormData(form);
    fd.set("idPageSize", "50");
    fd.set("idButton1", "検索"); // 検索ボタン送信を再現
    const body = new URLSearchParams(fd);

    const res = await fetch(form.action || location.href, {
      method: (form.method || "POST").toUpperCase(),
      credentials: "include",
      headers: { Accept: "text/html" },
      body,
    });
    if (!res.ok) {
      throw new Error(`ページサイズ切替リクエストが失敗: HTTP ${res.status}`);
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    if (isLoginPage(doc)) {
      throw new Error("セッションが切れた可能性があります。再ログインしてやり直してください。");
    }
    const newSelect = doc.querySelector('select[name="idPageSize"]');
    if (newSelect && newSelect.value !== "50") {
      throw new Error("ページサイズの切替がサーバ側で反映されませんでした");
    }
    return doc;
  }

  // ============ ネットワーク・ユーティリティ ============

  async function fetchHtml(url) {
    // 5xx エラーやネットワーク失敗は一時的なケースが多いので、最大3回まで指数バックオフでリトライ。
    // 4xx (404/401/403 等) は永続的失敗なので即 throw。
    const maxAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          credentials: "include",
          headers: { Accept: "text/html" },
        });
        if (res.ok) return await res.text();
        const err = new Error(`fetch failed: ${res.status} ${url}`);
        err.status = res.status;
        throw err;
      } catch (e) {
        lastError = e;
        const isTransient =
          (typeof e.status === "number" && e.status >= 500) ||
          typeof e.status !== "number";
        if (!isTransient || attempt >= maxAttempts) throw e;
        log(`fetch retry ${attempt + 1}/${maxAttempts} for ${url}: ${e.message}`);
        await sleep(1000 * attempt); // 1s, 2s
      }
    }
    throw lastError;
  }

  function toCSV(rows) {
    return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  }

  function csvEscape(v) {
    const s = v == null ? "" : String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function makeFilename(debugMode) {
    const kw = document.querySelector('input[name="idKeyword"]')?.value?.trim() || "";
    const safeKw = kw.replace(/[\\/:*?"<>|]/g, "_").slice(0, 30);
    const d = new Date();
    const ts =
      d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0") +
      "_" +
      String(d.getHours()).padStart(2, "0") +
      String(d.getMinutes()).padStart(2, "0");
    const suffix = debugMode ? "_debug" : "";
    const base = safeKw ? `rentracks_${safeKw}_${ts}${suffix}` : `rentracks_bill_index_${ts}${suffix}`;
    return `${base}.csv`;
  }

  function sendProgress(text) {
    chrome.runtime.sendMessage({ type: "PROGRESS", text });
  }

  async function setScrapeStatus(status) {
    try {
      await chrome.storage.session.set({ scrapeStatus: status });
    } catch (e) {
      // 進捗表示は副次機能、本体処理は継続させる
      console.warn("[rentracks-scraper] setScrapeStatus failed:", e);
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function txt(el) {
    return el ? collapseSpaces(el.textContent) : "";
  }

  function collapseSpaces(s) {
    return (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  }

  function log(...args) {
    console.log("[rentracks-scraper]", ...args);
  }
})();
