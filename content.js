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
    log("start");

    // === 0. 対象ページかチェック ===
    if (!/\/manage\/bill_index/.test(location.pathname)) {
      throw new Error("対象ページではありません。bill_index で検索を実行してから起動してください。");
    }

    // === 1. ページサイズ確認 ===
    const pageSizeSelect = document.querySelector('select[name="idPageSize"]');
    if (pageSizeSelect && pageSizeSelect.value !== "100") {
      const ok = confirm(
        `現在のページサイズは ${pageSizeSelect.value} 件です。\n` +
        `効率のため「100件表示」に切り替えてから再度実行することを推奨します。\n\n` +
        `このまま続行しますか？`
      );
      if (!ok) {
        sendProgress("");
        return;
      }
    }

    // === 2. 1ページ目をパース ===
    const firstCards = document.querySelectorAll("table.advtable2");
    if (firstCards.length === 0) {
      throw new Error("結果カード(.advtable2)が見つかりません。検索を実行してから拡張機能を起動してください。");
    }

    const allRows = []; // { 列名: 値 } の配列
    const seenKeys = new Set();

    for (const t of firstCards) {
      const row = parseAdvCard(t);
      allRows.push(row);
      Object.keys(row).forEach((k) => seenKeys.add(k));
    }

    // === 3. ページャ解析 ===
    const pager = analyzePager(document);
    log(`first page parsed. cards=${firstCards.length}, totalPages=${pager.totalPages}`);

    // === 4. 2ページ目以降を fetch ===
    for (let p = 2; p <= pager.totalPages; p++) {
      sendProgress(`${p}/${pager.totalPages}`);
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
    chrome.runtime.sendMessage({
      type: "DOWNLOAD_CSV",
      csv,
      filename: makeFilename(),
    });
  } catch (e) {
    console.error("[rentracks-scraper]", e);
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
      if (collapseSpaces(dt.textContent) === key) {
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

  // ============ ネットワーク・ユーティリティ ============

  async function fetchHtml(url) {
    const res = await fetch(url, {
      credentials: "include",
      headers: { Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
    return await res.text();
  }

  function toCSV(rows) {
    return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  }

  function csvEscape(v) {
    const s = v == null ? "" : String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function makeFilename() {
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
    const base = safeKw ? `rentracks_${safeKw}_${ts}` : `rentracks_bill_index_${ts}`;
    return `${base}.csv`;
  }

  function sendProgress(text) {
    chrome.runtime.sendMessage({ type: "PROGRESS", text });
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
