const catsEl = document.getElementById("cats");
const gridEl = document.getElementById("grid");
const sectionsEl = document.getElementById("sections");
const panelEl = document.getElementById("panel");
const emptyEl = document.getElementById("empty");
const bannerEl = document.getElementById("banner");
const titleEl = document.getElementById("sectionTitle");
const metaEl = document.getElementById("sectionMeta");
const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const suggestEl = document.getElementById("suggest");
const sheetEl = document.getElementById("sheet");
const sheetImg = document.getElementById("sheetImg");
const sheetName = document.getElementById("sheetName");
const sheetKicker = document.getElementById("sheetKicker");
const sheetStats = document.getElementById("sheetStats");
const sheetChart = document.getElementById("sheetChart");
const chartEmpty = document.getElementById("chartEmpty");
const sheetBuy = document.getElementById("sheetBuy");
const sheetWatch = document.getElementById("sheetWatch");
const sheetTarget = document.getElementById("sheetTarget");
const sheetMemo = document.getElementById("sheetMemo");
const sheetFolder = document.getElementById("sheetFolder");
const sheetBelow = document.getElementById("sheetBelow");
const sheetDrop = document.getElementById("sheetDrop");
const sheetPaid = document.getElementById("sheetPaid");
const sheetNote = document.getElementById("sheetNote");
const sheetAlts = document.getElementById("sheetAlts");
const sheetSnooze = document.getElementById("sheetSnooze");
const sheetShare = document.getElementById("sheetShare");
const periodsEl = document.getElementById("periods");
const filtersEl = document.getElementById("filters");
const profileBtn = document.getElementById("profileBtn");
const alertDot = document.getElementById("alertDot");
const dockEl = document.querySelector(".dock");
const priceMinEl = document.getElementById("priceMin");
const priceMaxEl = document.getElementById("priceMax");
const priceMaxRange = document.getElementById("priceMaxRange");
const sortEl = document.getElementById("sort");

const WATCH_KEY = "sellerdeal-watch";
const NOTIFIED_KEY = "sellerdeal-notified";
let library = null;
let alerts = [];
let view = "home";
let categoryId = "goldbox";
let sheetProduct = null;
let sheetId = "";
let chartDays = 30;
let folderId = "all";
let listPayload = null;
let homePayload = null;
let suggestTimer = 0;
const filters = { rocket: false, lowest: false, timing: false, fresh: false };

function won(n) {
  if (n == null || Number.isNaN(Number(n))) return "-";
  return Number(n).toLocaleString("ko-KR") + "원";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(url, options) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
  return data;
}

function quietNow() {
  const settings = library?.settings;
  if (!settings) return false;
  const hour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
  const start = Number(settings.nightStart);
  const end = Number(settings.nightEnd);
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function setDock(id) {
  for (const btn of dockEl.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.nav === id);
  }
}

function showBanner(message) {
  bannerEl.hidden = !message;
  bannerEl.textContent = message || "";
}

function applyFilters(products) {
  const min = Number(priceMinEl.value);
  const max = Number(priceMaxEl.value);
  let rows = [...(products || [])];
  if (filters.rocket) rows = rows.filter((product) => product.isRocket);
  if (filters.lowest) rows = rows.filter((product) => product.isAllTimeLow || product.is14DayLow);
  if (filters.timing) rows = rows.filter((product) => product.isTiming);
  if (filters.fresh) {
    const cutoff = Date.now() - 7 * 86400000;
    rows = rows.filter((product) => !product.lastSeenAt || product.lastSeenAt >= cutoff);
  }
  if (priceMinEl.value !== "" && Number.isFinite(min)) {
    rows = rows.filter((product) => product.productPrice != null && product.productPrice >= min);
  }
  if (priceMaxEl.value !== "" && Number.isFinite(max)) {
    rows = rows.filter((product) => product.productPrice != null && product.productPrice <= max);
  }
  const sort = sortEl.value;
  rows.sort((a, b) => {
    if (sort === "priceAsc") return (a.productPrice ?? 0) - (b.productPrice ?? 0);
    if (sort === "priceDesc") return (b.productPrice ?? 0) - (a.productPrice ?? 0);
    if (sort === "name") return String(a.productName || "").localeCompare(String(b.productName || ""), "ko");
    return (b.dropPercent ?? -999) - (a.dropPercent ?? -999);
  });
  return rows;
}

function spark(points) {
  if (!points || points.length < 2) return "";
  const vals = points.map((point) => point.price ?? point.p);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const d = vals
    .map((value, index) => {
      const x = (index / (vals.length - 1)) * 120;
      const y = 25 - ((value - min) / span) * 22;
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 120 28" aria-hidden="true"><path d="${d}" fill="none" stroke="#0f9f6e" stroke-width="2"/></svg>`;
}

function cardHtml(product) {
  const oldPrice = product.previousPrice && product.productPrice && product.previousPrice > product.productPrice
    ? product.previousPrice
    : product.originalPrice && product.productPrice && product.originalPrice > product.productPrice
      ? product.originalPrice
      : product.highestPrice && product.productPrice && product.highestPrice > product.productPrice
        ? product.highestPrice
        : null;
  const delta = product.dropPercent > 0 ? product.dropPercent : oldPrice && product.productPrice
    ? Math.round((1 - product.productPrice / oldPrice) * 100)
    : 0;
  return `
    <article class="card" data-id="${escapeHtml(String(product.productId || ""))}">
      <div class="thumb">
        <img src="${product.productImage || ""}" alt="${escapeHtml(product.productName || "")}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity='0'"/>
      </div>
      <div class="body">
        <div class="badges">
          ${product.isTiming ? '<span class="badge low">타이밍</span>' : ""}
          ${product.isAllTimeLow ? '<span class="badge low">역대최저</span>' : ""}
          ${product.is14DayLow && !product.isAllTimeLow ? '<span class="badge low">14일 최저</span>' : ""}
          ${product.isRocket ? '<span class="badge rocket">로켓배송</span>' : ""}
          ${product.isFreeShipping ? '<span class="badge ship">무료배송</span>' : ""}
          ${product.watched ? '<span class="badge">관심</span>' : ""}
          ${product.staleHours ? `<span class="badge stale">${product.staleHours}시간 미수집</span>` : ""}
        </div>
        <div class="name">${escapeHtml(product.productName || "")}</div>
        ${spark(product.pricePoints)}
        <div class="price-row">
          ${oldPrice ? `<span class="old">${won(oldPrice)}</span>` : ""}
          <span class="price">${product.productPrice != null ? won(product.productPrice) : "-"}</span>
          ${delta > 0 ? `<span class="delta">↓${delta}%</span>` : ""}
          ${product.unitLabel ? `<div class="unit">${escapeHtml(product.unitLabel)}</div>` : ""}
        </div>
        <a class="cta" href="${product.productUrl || "#"}" target="_blank" rel="noopener sponsored nofollow">쿠팡에서 보기</a>
      </div>
    </article>
  `;
}

function skeleton(n = 8) {
  gridEl.hidden = false;
  sectionsEl.innerHTML = "";
  panelEl.hidden = true;
  gridEl.innerHTML = Array.from({ length: n }, () => `
    <div class="skel"><div class="box"></div><div class="pad"><div class="line"></div><div class="line" style="width:60%"></div></div></div>
  `).join("");
  emptyEl.hidden = true;
}

function renderGrid(products, title, meta) {
  sectionsEl.innerHTML = "";
  panelEl.hidden = true;
  filtersEl.hidden = false;
  titleEl.textContent = title;
  metaEl.textContent = meta;
  const rows = applyFilters(products);
  gridEl.hidden = false;
  emptyEl.hidden = rows.length > 0;
  gridEl.innerHTML = rows.map(cardHtml).join("");
}

function renderHome(payload) {
  homePayload = payload;
  listPayload = null;
  panelEl.hidden = true;
  filtersEl.hidden = false;
  gridEl.hidden = true;
  gridEl.innerHTML = "";
  emptyEl.hidden = true;
  titleEl.textContent = "지금 사기 좋은 딜";
  const when = payload.at ? new Date(payload.at).toLocaleString("ko-KR") : "";
  metaEl.textContent = `${payload.cached ? "캐시" : "방금 수집"} · ${when}`;
  const blocks = [
    ["사기 좋은 타이밍", applyFilters(payload.timing || []), "timing"],
    ["오늘의 골드박스", applyFilters(payload.goldbox || []), "goldbox"],
    ["최저가", applyFilters(payload.lowest || []), "lowest"],
  ];
  sectionsEl.innerHTML = blocks.map(([title, products, nav]) => `
    <section class="home-block">
      <div class="section-head">
        <h3>${title}</h3>
        <button class="more" type="button" data-goto="${nav}">더보기</button>
      </div>
      ${products.length ? `<div class="grid">${products.slice(0, 8).map(cardHtml).join("")}</div>` : `<p class="meta">이 조건에 맞는 상품이 없습니다.</p>`}
    </section>
  `).join("");
}

function collectHint(payload) {
  if (!payload) return "";
  const at = payload.lastCollectAt ? new Date(payload.lastCollectAt).toLocaleString("ko-KR") : "아직 없음";
  return payload.trackedCount != null ? ` · 추적 ${payload.trackedCount}상품 · 마지막 수집 ${at}` : "";
}

async function loadList(url, fallbackTitle) {
  skeleton();
  showBanner("");
  try {
    const data = await api(url);
    listPayload = data;
    view = data.source || view;
    renderGrid(data.products || [], data.title || fallbackTitle, `${(data.products || []).length}개 · ${data.cached ? "캐시" : "방금 수집"}${collectHint(data)}`);
  } catch (err) {
    gridEl.innerHTML = "";
    showBanner(err.message);
  }
}

async function loadHome() {
  view = "home";
  categoryId = "goldbox";
  setDock("home");
  setActive("goldbox");
  skeleton();
  showBanner("");
  try {
    renderHome(await api("/api/home"));
  } catch (err) {
    showBanner(err.message);
  }
}

async function loadWatch() {
  view = "watch";
  setDock("watch");
  setActive("");
  const ids = folderId === "all"
    ? library.watches
    : (library.folders.find((folder) => folder.id === folderId)?.productIds || []);
  panelEl.hidden = false;
  panelEl.innerHTML = `
    <form class="row-form" id="addForm">
      <input id="addInput" placeholder="상품명 또는 쿠팡 링크" />
      <button type="submit">등록</button>
    </form>
    <div class="row-form" style="margin-top:10px">
      <button class="folder-chip ${folderId === "all" ? "on" : ""}" type="button" data-folder="all">전체</button>
      ${library.folders.map((folder) => `<button class="folder-chip ${folderId === folder.id ? "on" : ""}" type="button" data-folder="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</button>`).join("")}
      <input id="folderName" placeholder="새 폴더" />
      <button class="text-btn" type="button" id="addFolder">추가</button>
    </div>
  `;
  filtersEl.hidden = false;
  if (!ids.length) {
    sectionsEl.innerHTML = "";
    gridEl.innerHTML = "";
    gridEl.hidden = false;
    titleEl.textContent = "관심상품";
    metaEl.textContent = "상품을 열거나 위에서 등록하면 이후 수집 때 가격을 이어 갑니다.";
    emptyEl.hidden = false;
    return;
  }
  await loadList(`/api/products?ids=${ids.map(encodeURIComponent).join(",")}`, "관심상품");
  panelEl.hidden = false;
}

async function renderAlerts() {
  view = "alerts";
  setDock("alerts");
  setActive("");
  sectionsEl.innerHTML = "";
  gridEl.hidden = true;
  gridEl.innerHTML = "";
  emptyEl.hidden = true;
  filtersEl.hidden = true;
  panelEl.hidden = false;
  titleEl.textContent = "알림";
  const digest = await api("/api/digest").catch(() => ({ text: "" }));
  const pushOn = localStorage.getItem("sellerdeal-push") === "1";
  metaEl.textContent = quietNow()
    ? "야간에는 상품 알림 푸시를 보류하고, 아침 요약은 설정한 시각에 보냅니다."
    : "최저가, 목표가, 가격 복귀, 재등장, 키워드, 조건, 구매 후 하락";
  const settings = library.settings;
  panelEl.innerHTML = `
    <form class="row-form" id="profileForm">
      <input id="displayName" value="${escapeHtml(library.displayName || "")}" maxlength="20" />
      <button type="submit">이름 저장</button>
    </form>
    <p class="meta">${escapeHtml(digest.text || "")}${digest.sentToday ? " · 오늘 요약을 보냈습니다." : ""}</p>
    <div class="check-grid" style="margin-top:12px">
      ${["lowest", "target", "restore", "restock", "keyword", "rocketOnly", "digest"].map((key) => {
        const labels = { lowest: "최저가", target: "목표가", restore: "가격 복귀", restock: "다시 등장", keyword: "키워드", rocketOnly: "로켓만", digest: "하루 요약" };
        return `<label><input type="checkbox" data-setting="${key}" ${settings[key] ? "checked" : ""}/>${labels[key]}</label>`;
      }).join("")}
      <label>야간 시작 <input id="nightStart" type="number" min="0" max="23" value="${settings.nightStart}" style="width:64px"/></label>
      <label>끝 <input id="nightEnd" type="number" min="0" max="23" value="${settings.nightEnd}" style="width:64px"/></label>
      <label>요약 시각 <input id="digestHour" type="number" min="0" max="23" value="${settings.digestHour ?? 8}" style="width:64px"/></label>
      <button class="text-btn ghost" type="button" id="pushBtn">${pushOn ? "푸시 다시 연결" : "창을 닫아도 받기"}</button>
      <button class="text-btn ghost" type="button" id="readBtn">모두 읽음</button>
    </div>
    <form class="row-form" id="keywordForm" style="margin-top:12px">
      <input id="keywordInput" placeholder="알림 키워드, 쉼표로 구분" value="${escapeHtml(library.keywords.join(", "))}" />
      <button type="submit">키워드 저장</button>
    </form>
    <div style="margin-top:8px">
      ${alerts.length ? alerts.map((alert) => `
        <button class="alert-item" type="button" data-product="${escapeHtml(alert.productId)}" style="width:100%;background:transparent;border-left:0;border-right:0;border-top:0;text-align:left;cursor:pointer">
          <span><strong>${escapeHtml(alert.title)}${alert.read ? "" : " · 새 알림"}</strong>${escapeHtml(alert.body)}</span>
          <span>${new Date(alert.at).toLocaleString("ko-KR")}</span>
        </button>
      `).join("") : `<p class="meta">아직 알림이 없습니다. 관심 상품이나 키워드를 저장해 두면 다음 수집 때 쌓입니다.</p>`}
    </div>
  `;
}

function drawChart(points) {
  const sliced = chartDays > 0 ? points.slice(-chartDays) : points;
  const w = 640;
  const h = 220;
  const pad = { t: 18, r: 16, b: 28, l: 16 };
  if (!sliced || sliced.length < 2) {
    sheetChart.innerHTML = "";
    chartEmpty.hidden = false;
    return;
  }
  chartEmpty.hidden = true;
  const vals = sliced.map((point) => point.price);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const xy = (index, value) => {
    const x = pad.l + (index / (vals.length - 1)) * innerW;
    const y = pad.t + innerH - ((value - min) / span) * innerH;
    return [x, y];
  };
  const line = vals.map((value, index) => {
    const [x, y] = xy(index, value);
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `${line} L${xy(vals.length - 1, min)[0].toFixed(1)},${(pad.t + innerH).toFixed(1)} L${pad.l},${(pad.t + innerH).toFixed(1)} Z`;
  sheetChart.innerHTML = `
    <path d="${area}" fill="rgba(15,159,110,.12)"></path>
    <path d="${line}" fill="none" stroke="#0f9f6e" stroke-width="3" stroke-linecap="round"></path>
    <text x="${pad.l}" y="${h - 8}" fill="#66746d" font-size="12">${sliced[0].date.slice(5).replace("-", ".")}</text>
    <text x="${w - pad.r}" y="${h - 8}" fill="#66746d" font-size="12" text-anchor="end">${sliced[sliced.length - 1].date.slice(5).replace("-", ".")}</text>
    <text x="${pad.l}" y="14" fill="#66746d" font-size="12">최고 ${won(max)}</text>
    <text x="${w - pad.r}" y="14" fill="#e11d48" font-size="12" text-anchor="end">최저 ${won(min)}</text>
  `;
}

function fillFolders(selected) {
  sheetFolder.innerHTML = `<option value="">폴더 없음</option>${library.folders.map((folder) => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</option>`).join("")}`;
  sheetFolder.value = selected || "";
}

function syncWatchButton() {
  const on = Boolean(sheetProduct?.watched);
  sheetWatch.classList.toggle("on", on);
  sheetWatch.textContent = on ? "관심 해제" : "관심 추가";
}

async function openSheet(id) {
  if (!id) return;
  let product;
  try {
    product = await api(`/api/product/${encodeURIComponent(id)}`);
  } catch (err) {
    showBanner(err.message);
    return;
  }
  sheetProduct = product;
  sheetId = String(product.productId || id);
  sheetImg.src = product.productImage || "";
  sheetImg.alt = product.productName || "";
  sheetName.textContent = product.productName || "(이름 없음)";
  sheetKicker.textContent = product.isTiming ? "지금이 사기 좋은 구간" : `${product.dayCount || 0}일 가격 추적`;
  sheetStats.innerHTML = `
    <div><span>현재가</span><strong>${won(product.productPrice)}</strong></div>
    <div><span>평균</span><strong>${won(product.averagePrice)}</strong></div>
    <div class="low"><span>14일 최저</span><strong>${won(product.low14Price)}</strong></div>
    <div class="low"><span>역대 최저</span><strong>${won(product.lowestPrice)}</strong></div>
  `;
  const paidGap = product.purchasePrice != null && product.productPrice != null
    ? product.productPrice - product.purchasePrice
    : null;
  sheetStats.innerHTML += `
    ${product.unitLabel ? `<div><span>단위</span><strong>${escapeHtml(product.unitLabel)}</strong></div>` : ""}
    ${product.purchasePrice != null ? `<div class="${paidGap < 0 ? "low" : ""}"><span>산 가격</span><strong>${won(product.purchasePrice)}</strong></div>` : ""}
  `;
  const notes = [];
  if (product.staleHours) notes.push(`${product.staleHours}시간 동안 수집 목록에 없습니다. 가격이 유지된 것이 아닙니다.`);
  if (product.weekdayHint) notes.push(product.weekdayHint);
  if (paidGap != null && paidGap < 0) notes.push(`산 가격보다 ${won(Math.abs(paidGap))} 낮습니다. 구매 후 7일 안에는 알림으로도 옵니다.`);
  if (product.snoozeUntil) notes.push(`${new Date(product.snoozeUntil).toLocaleString("ko-KR")}까지 상품 알림을 중지합니다. 산 가격보다 내려가면 그때는 알립니다.`);
  sheetNote.textContent = notes.join(" ");
  sheetBelow.value = product.belowAvgPercent ?? "";
  sheetDrop.value = product.dropAmount ?? "";
  sheetPaid.value = product.purchasePrice ?? "";
  sheetSnooze.textContent = product.snoozeUntil ? "알림 다시 켜기" : "7일 중지";
  const alts = product.alternatives || [];
  sheetAlts.innerHTML = alts.length ? `<div class="alts">${alts.map((item) => `
    <button type="button" data-alt="${escapeHtml(String(item.productId || ""))}">
      <strong>${escapeHtml(item.productName || "")}</strong>
      <span>${won(item.productPrice)}</span>
    </button>
  `).join("")}</div>` : "";
  sheetTarget.value = product.targetPrice ?? "";
  sheetMemo.value = product.memo || "";
  fillFolders(product.folderId);
  drawChart(product.pricePoints || []);
  sheetBuy.href = product.productUrl || "#";
  syncWatchButton();
  sheetEl.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSheet() {
  sheetEl.hidden = true;
  document.body.style.overflow = "";
}

function refreshOpenView() {
  if (view === "home") {
    if (homePayload) renderHome(homePayload);
    return;
  }
  if (view === "alerts") {
    renderAlerts();
    return;
  }
  if (!listPayload) return;
  const title = titleEl.textContent;
  const meta = metaEl.textContent;
  renderGrid(listPayload.products || [], title, meta);
  if (view === "watch") panelEl.hidden = false;
}

async function refreshLibrary() {
  library = await api("/api/library");
  profileBtn.textContent = library.displayName || "나";
  alertDot.hidden = !library.unread;
  alerts = (await api("/api/alerts")).alerts || [];
}

async function postLibrary(url, body) {
  library = await api(url, { method: "POST", body: JSON.stringify(body) });
  profileBtn.textContent = library.displayName || "나";
  alertDot.hidden = !library.unread;
}

function coupangId(text) {
  const match = String(text).match(/products\/(\d+)|productId=(\d+)|itemId=(\d+)/i);
  return match ? (match[1] || match[2] || match[3]) : "";
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    showBanner("이 브라우저는 창을 닫은 뒤 알림을 받을 수 없습니다.");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showBanner("알림 권한이 있어야 창을 닫아도 받을 수 있습니다.");
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api("/api/push/key");
  const existing = await reg.pushManager.getSubscription();
  const subscription = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
  localStorage.setItem("sellerdeal-push", "1");
  showBanner("창을 닫아도 이 브라우저로 알림을 보냅니다.");
  if (view === "alerts") renderAlerts();
}

async function shareProduct() {
  if (!sheetProduct || !sheetId) return;
  const page = `${location.origin}/share/${encodeURIComponent(sheetId)}`;
  const text = [
    sheetProduct.productName,
    `현재 ${won(sheetProduct.productPrice)}`,
    sheetProduct.low14Price != null ? `14일 최저 ${won(sheetProduct.low14Price)}` : "",
    sheetProduct.unitLabel || "",
    page,
    sheetProduct.productUrl || "",
  ].filter(Boolean).join("\n");
  if (navigator.share) {
    try {
      await navigator.share({ title: sheetProduct.productName || "셀러딜", text, url: page });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  await navigator.clipboard.writeText(text);
  showBanner("공유 문구를 복사했습니다.");
}

async function saveRule() {
  if (!sheetId) return;
  await postLibrary("/api/library/rule", {
    productId: sheetId,
    belowAvgPercent: sheetBelow.value,
    dropAmount: sheetDrop.value,
  });
}

async function notifyFresh() {
  if (localStorage.getItem("sellerdeal-push") === "1") return;
  if (!("Notification" in window) || Notification.permission !== "granted" || quietNow()) return;
  const last = Number(localStorage.getItem(NOTIFIED_KEY) || 0);
  const fresh = alerts.filter((alert) => !alert.read && alert.at > last);
  if (!fresh.length) return;
  for (const alert of fresh.slice(0, 3)) new Notification(alert.title, { body: alert.body });
  localStorage.setItem(NOTIFIED_KEY, String(Date.now()));
}

function setActive(id) {
  for (const btn of catsEl.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.id === id);
  }
}

async function setupCats() {
  const data = await api("/api/categories");
  const items = [{ id: "goldbox", name: "골드박스" }, ...(data.categories || [])];
  catsEl.innerHTML = items.map((item) => `<button type="button" data-id="${item.id}" class="${item.id === "goldbox" ? "active" : ""}">${item.name}</button>`).join("");
}

filtersEl.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-filter]");
  if (!btn) return;
  filters[btn.dataset.filter] = !filters[btn.dataset.filter];
  btn.classList.toggle("on", filters[btn.dataset.filter]);
  refreshOpenView();
});
priceMinEl.addEventListener("input", () => refreshOpenView());
priceMaxEl.addEventListener("input", () => {
  if (priceMaxEl.value !== "") priceMaxRange.value = String(Math.min(300000, Number(priceMaxEl.value) || 0));
  refreshOpenView();
});
priceMaxRange.addEventListener("input", () => {
  priceMaxEl.value = priceMaxRange.value === "300000" ? "" : priceMaxRange.value;
  refreshOpenView();
});
sortEl.addEventListener("change", () => refreshOpenView());

catsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  searchInput.value = "";
  suggestEl.hidden = true;
  const id = btn.dataset.id;
  setActive(id);
  if (id === "goldbox") loadHome();
  else {
    view = "best";
    categoryId = id;
    setDock("");
    loadList(`/api/best/${id}`);
  }
});

dockEl.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  searchInput.value = "";
  if (btn.dataset.nav === "home") loadHome();
  else if (btn.dataset.nav === "timing") {
    view = "timing";
    setDock("timing");
    setActive("");
    loadList("/api/timing");
  } else if (btn.dataset.nav === "tracked") {
    view = "tracked";
    setDock("tracked");
    setActive("");
    loadList("/api/tracked");
  } else if (btn.dataset.nav === "watch") loadWatch();
  else renderAlerts();
});

sectionsEl.addEventListener("click", (event) => {
  const more = event.target.closest("[data-goto]");
  if (more) {
    const nav = more.dataset.goto;
    if (nav === "timing") loadList("/api/timing");
    else if (nav === "goldbox") loadList("/api/goldbox");
    else if (nav === "lowest") loadList("/api/lowest");
    else loadList("/api/tracked");
    setDock(nav === "goldbox" ? "home" : nav);
    return;
  }
  if (event.target.closest(".cta")) return;
  const card = event.target.closest(".card");
  if (card) openSheet(card.dataset.id);
});

gridEl.addEventListener("click", (event) => {
  if (event.target.closest(".cta")) return;
  const card = event.target.closest(".card");
  if (card) openSheet(card.dataset.id);
});

panelEl.addEventListener("click", async (event) => {
  const folderBtn = event.target.closest("[data-folder]");
  if (folderBtn) {
    folderId = folderBtn.dataset.folder;
    loadWatch();
    return;
  }
  if (event.target.id === "addFolder") {
    const name = document.getElementById("folderName").value.trim();
    if (!name) return;
    await postLibrary("/api/library/folder", { name });
    loadWatch();
    return;
  }
  if (event.target.id === "readBtn") {
    alerts = (await api("/api/alerts/read", { method: "POST", body: "{}" })).alerts || [];
    library.unread = 0;
    alertDot.hidden = true;
    renderAlerts();
    return;
  }
  if (event.target.id === "pushBtn") {
    await enablePush();
    return;
  }
  const setting = event.target.closest("[data-setting]");
  if (setting) {
    await postLibrary("/api/library/settings", { [setting.dataset.setting]: setting.checked });
    return;
  }
  const alertBtn = event.target.closest("[data-product]");
  if (alertBtn?.dataset.product && alertBtn.dataset.product !== "digest") openSheet(alertBtn.dataset.product);
});

panelEl.addEventListener("change", async (event) => {
  if (event.target.id === "nightStart" || event.target.id === "nightEnd" || event.target.id === "digestHour") {
    await postLibrary("/api/library/settings", {
      nightStart: Number(document.getElementById("nightStart").value),
      nightEnd: Number(document.getElementById("nightEnd").value),
      digestHour: Number(document.getElementById("digestHour").value),
    });
  }
});

panelEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "addForm") {
    const text = document.getElementById("addInput").value.trim();
    if (!text) return;
    const id = coupangId(text);
    if (id) {
      try {
        await api(`/api/product/${encodeURIComponent(id)}`);
        await postLibrary("/api/library/watch", { productId: id, on: true });
        openSheet(id);
        return;
      } catch {
        showBanner("아직 수집된 상품이 아닙니다. 상품명으로 검색한 뒤 관심 추가해 주세요.");
        return;
      }
    }
    view = "search";
    setDock("");
    loadList(`/api/search?q=${encodeURIComponent(text)}`);
    return;
  }
  if (event.target.id === "profileForm") {
    await postLibrary("/api/library/profile", { displayName: document.getElementById("displayName").value });
    renderAlerts();
    return;
  }
  if (event.target.id === "keywordForm") {
    const keywords = document.getElementById("keywordInput").value.split(",").map((item) => item.trim()).filter(Boolean);
    await postLibrary("/api/library/keywords", { keywords });
    renderAlerts();
  }
});

sheetWatch.addEventListener("click", async () => {
  if (!sheetId) return;
  await postLibrary("/api/library/watch", { productId: sheetId, on: !sheetProduct.watched });
  sheetProduct = await api(`/api/product/${encodeURIComponent(sheetId)}`);
  syncWatchButton();
  refreshOpenView();
});
sheetTarget.addEventListener("change", async () => {
  if (!sheetId) return;
  await postLibrary("/api/library/target", { productId: sheetId, price: sheetTarget.value });
});
sheetMemo.addEventListener("change", async () => {
  if (!sheetId) return;
  await postLibrary("/api/library/memo", { productId: sheetId, memo: sheetMemo.value });
});
sheetFolder.addEventListener("change", async () => {
  if (!sheetId) return;
  await postLibrary("/api/library/assign", { productId: sheetId, folderId: sheetFolder.value || null });
  sheetProduct = await api(`/api/product/${encodeURIComponent(sheetId)}`);
  syncWatchButton();
});
sheetBelow.addEventListener("change", saveRule);
sheetDrop.addEventListener("change", saveRule);
sheetPaid.addEventListener("change", async () => {
  if (!sheetId) return;
  await postLibrary("/api/library/purchase", { productId: sheetId, price: sheetPaid.value });
  await openSheet(sheetId);
  refreshOpenView();
});
sheetSnooze.addEventListener("click", async () => {
  if (!sheetId) return;
  const on = !sheetProduct?.snoozeUntil;
  await postLibrary("/api/library/snooze", { productId: sheetId, days: on ? 7 : 0, on });
  await openSheet(sheetId);
});
sheetShare.addEventListener("click", () => shareProduct());
sheetAlts.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-alt]");
  if (btn?.dataset.alt) openSheet(btn.dataset.alt);
});
periodsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  chartDays = Number(btn.dataset.days);
  for (const item of periodsEl.querySelectorAll("button")) item.classList.toggle("active", item === btn);
  if (sheetProduct) drawChart(sheetProduct.pricePoints || []);
});
sheetEl.addEventListener("click", (event) => {
  if (event.target.closest("[data-close]")) closeSheet();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSheet();
    suggestEl.hidden = true;
  }
});

searchInput.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (q.length < 1) {
    suggestEl.hidden = true;
    return;
  }
  suggestTimer = setTimeout(async () => {
    const data = await api(`/api/suggest?q=${encodeURIComponent(q)}`);
    if (!data.names?.length) {
      suggestEl.hidden = true;
      return;
    }
    suggestEl.hidden = false;
    suggestEl.innerHTML = data.names.map((name) => `<button type="button" data-q="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("");
  }, 180);
});
suggestEl.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  searchInput.value = btn.dataset.q || "";
  suggestEl.hidden = true;
  searchForm.requestSubmit();
});
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  suggestEl.hidden = true;
  const q = searchInput.value.trim();
  if (!q) return;
  view = "search";
  setDock("");
  setActive("");
  loadList(`/api/search?q=${encodeURIComponent(q)}`);
});
document.getElementById("homeLink").addEventListener("click", (event) => {
  event.preventDefault();
  searchInput.value = "";
  loadHome();
});
profileBtn.addEventListener("click", () => renderAlerts());

async function boot() {
  await setupCats();
  await refreshLibrary();
  try {
    const old = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]").filter(Boolean);
    if (old.length && !library.watches.length) {
      await postLibrary("/api/library/import", { ids: old });
      localStorage.removeItem(WATCH_KEY);
    }
  } catch {
    /* ignore broken local watch list */
  }
  await notifyFresh();
  const opened = new URLSearchParams(location.search).get("product");
  if (opened) openSheet(opened);
  loadHome();
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "open" && event.data.url) location.href = event.data.url;
  });
}

boot();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
