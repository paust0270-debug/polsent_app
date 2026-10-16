const catsEl = document.getElementById("cats");
const gridEl = document.getElementById("grid");
const emptyEl = document.getElementById("empty");
const bannerEl = document.getElementById("banner");
const titleEl = document.getElementById("sectionTitle");
const metaEl = document.getElementById("sectionMeta");
const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const sheetEl = document.getElementById("sheet");
const sheetImg = document.getElementById("sheetImg");
const sheetName = document.getElementById("sheetName");
const sheetKicker = document.getElementById("sheetKicker");
const sheetStats = document.getElementById("sheetStats");
const sheetChart = document.getElementById("sheetChart");
const chartEmpty = document.getElementById("chartEmpty");
const sheetBuy = document.getElementById("sheetBuy");
const sheetWatch = document.getElementById("sheetWatch");
const dockEl = document.querySelector(".dock");

const WATCH_KEY = "sellerdeal-watch";
let active = "goldbox";
let sheetId = "";

function readWatch() {
  try {
    return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]").filter(Boolean);
  } catch {
    return [];
  }
}

function writeWatch(ids) {
  localStorage.setItem(WATCH_KEY, JSON.stringify([...new Set(ids)]));
}

function isWatched(id) {
  return readWatch().includes(id);
}

function toggleWatch(id) {
  if (!id) return;
  const ids = readWatch();
  const next = ids.includes(id) ? ids.filter((x) => x !== id) : [id, ...ids];
  writeWatch(next);
  syncWatchButton();
}

function syncWatchButton() {
  const on = isWatched(sheetId);
  sheetWatch.classList.toggle("on", on);
  sheetWatch.textContent = on ? "관심 해제" : "관심 추가";
}

function setDock(id) {
  for (const btn of dockEl.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.nav === id);
  }
}

function won(n) {
  if (n == null || Number.isNaN(Number(n))) return "-";
  return Number(n).toLocaleString("ko-KR") + "원";
}

function spark(points) {
  if (!points || points.length < 2) return "";
  const vals = points.map((p) => p.price ?? p.p);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const w = 120;
  const h = 28;
  const d = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - 3 - ((v - min) / span) * (h - 6);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="#0f9f6e" stroke-width="2"/></svg>`;
}

function drawChart(points) {
  const w = 640;
  const h = 220;
  const pad = { t: 18, r: 16, b: 28, l: 16 };
  if (!points || points.length < 2) {
    sheetChart.innerHTML = "";
    chartEmpty.hidden = false;
    return;
  }
  chartEmpty.hidden = true;
  const vals = points.map((p) => p.price);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const xy = (i, v) => {
    const x = pad.l + (i / (vals.length - 1)) * innerW;
    const y = pad.t + innerH - ((v - min) / span) * innerH;
    return [x, y];
  };
  const line = vals
    .map((v, i) => {
      const [x, y] = xy(i, v);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `${line} L${xy(vals.length - 1, min)[0].toFixed(1)},${(pad.t + innerH).toFixed(1)} L${pad.l},${(pad.t + innerH).toFixed(1)} Z`;
  const first = points[0].date.slice(5).replace("-", ".");
  const last = points[points.length - 1].date.slice(5).replace("-", ".");
  sheetChart.innerHTML = `
    <path d="${area}" fill="rgba(15,159,110,.12)"></path>
    <path d="${line}" fill="none" stroke="#0f9f6e" stroke-width="3" stroke-linecap="round"></path>
    <text x="${pad.l}" y="${h - 8}" fill="#66746d" font-size="12">${first}</text>
    <text x="${w - pad.r}" y="${h - 8}" fill="#66746d" font-size="12" text-anchor="end">${last}</text>
    <text x="${pad.l}" y="14" fill="#66746d" font-size="12">최고 ${won(max)}</text>
    <text x="${w - pad.r}" y="14" fill="#e11d48" font-size="12" text-anchor="end">최저 ${won(min)}</text>
  `;
}

function skeleton(n = 8) {
  gridEl.innerHTML = Array.from({ length: n }, () => `
    <div class="skel">
      <div class="box"></div>
      <div class="pad">
        <div class="line"></div>
        <div class="line" style="width:60%"></div>
      </div>
    </div>
  `).join("");
  emptyEl.hidden = true;
}

function collectHint(payload) {
  const n = payload.trackedCount;
  const at = payload.lastCollectAt ? new Date(payload.lastCollectAt).toLocaleString("ko-KR") : "아직 없음";
  return n != null ? ` · 추적 ${n}상품 · 마지막 수집 ${at}` : "";
}

function render(payload) {
  const products = payload.products || [];
  titleEl.textContent = payload.title || "상품";
  const when = payload.at ? new Date(payload.at).toLocaleString("ko-KR") : "";
  metaEl.textContent = `${products.length}개 · ${payload.cached ? "캐시" : "방금 수집"} · ${when}${collectHint(payload)}`;
  bannerEl.hidden = true;
  emptyEl.hidden = products.length > 0;
  gridEl.innerHTML = products.map((p) => {
    const oldPrice = p.previousPrice && p.productPrice && p.previousPrice > p.productPrice
      ? p.previousPrice
      : p.originalPrice && p.productPrice && p.originalPrice > p.productPrice
        ? p.originalPrice
        : p.highestPrice && p.productPrice && p.highestPrice > p.productPrice
          ? p.highestPrice
          : null;
    const delta = oldPrice && p.productPrice
      ? Math.round((1 - p.productPrice / oldPrice) * 100)
      : 0;
    const href = p.productUrl || "#";
    return `
      <article class="card" data-id="${escapeHtml(String(p.productId || ""))}">
        <div class="thumb">
          <img src="${p.productImage || ""}" alt="${escapeHtml(p.productName || "")}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity='0'"/>
        </div>
        <div class="body">
          <div class="badges">
            ${p.isAllTimeLow ? '<span class="badge low">역대최저가</span>' : ""}
            ${p.isRocket ? '<span class="badge rocket">로켓배송</span>' : ""}
            ${p.isFreeShipping ? '<span class="badge ship">무료배송</span>' : ""}
            ${p.dayCount ? `<span class="badge">${p.dayCount}일 추적</span>` : ""}
            ${p.categoryName ? `<span class="badge">${escapeHtml(p.categoryName)}</span>` : ""}
          </div>
          <div class="name">${escapeHtml(p.productName || "")}</div>
          ${spark(p.pricePoints)}
          <div class="price-row">
            ${oldPrice ? `<span class="old">${won(oldPrice)}</span>` : ""}
            <span class="price">${p.productPrice != null ? won(p.productPrice) : "-"}</span>
            ${delta > 0 ? `<span class="delta">↓${delta}%</span>` : ""}
          </div>
          <a class="cta" href="${href}" target="_blank" rel="noopener sponsored nofollow">쿠팡에서 보기</a>
        </div>
      </article>
    `;
  }).join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setActive(id) {
  active = id;
  for (const btn of catsEl.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.id === id);
  }
}

async function load(url) {
  skeleton();
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "불러오지 못했습니다.");
    render(data);
  } catch (err) {
    gridEl.innerHTML = "";
    emptyEl.hidden = true;
    bannerEl.hidden = false;
    bannerEl.textContent = err.message || String(err);
    metaEl.textContent = "오류";
  }
}

async function loadWatch() {
  const ids = readWatch();
  if (!ids.length) {
    titleEl.textContent = "관심상품";
    metaEl.textContent = "아직 관심 상품이 없습니다. 상품을 열어 추가해 보세요.";
    gridEl.innerHTML = "";
    emptyEl.hidden = false;
    bannerEl.hidden = true;
    return;
  }
  await load(`/api/products?ids=${ids.map(encodeURIComponent).join(",")}`);
}

async function openSheet(id) {
  if (!id) return;
  const res = await fetch(`/api/product/${encodeURIComponent(id)}`);
  const p = await res.json();
  if (!res.ok) {
    bannerEl.hidden = false;
    bannerEl.textContent = p.error || "상품 이력을 찾지 못했습니다.";
    return;
  }
  sheetImg.src = p.productImage || "";
  sheetImg.alt = p.productName || "";
  sheetName.textContent = p.productName || "(이름 없음)";
  sheetKicker.textContent = p.isAllTimeLow ? "지금이 역대급 최저가" : `${p.dayCount || 0}일 가격 추적`;
  sheetStats.innerHTML = `
    <div><span>현재가</span><strong>${won(p.lastPrice)}</strong></div>
    <div class="low"><span>역대 최저</span><strong>${won(p.lowestPrice)}</strong></div>
    <div><span>역대 최고</span><strong>${won(p.highestPrice)}</strong></div>
  `;
  drawChart(p.pricePoints || []);
  sheetBuy.href = p.productUrl || "#";
  sheetId = String(p.productId || id);
  syncWatchButton();
  sheetEl.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSheet() {
  sheetEl.hidden = true;
  document.body.style.overflow = "";
}

async function setupCats() {
  const res = await fetch("/api/categories");
  const data = await res.json();
  const items = [
    { id: "goldbox", name: "골드박스" },
    { id: "tracked", name: "가격추적" },
    { id: "watch", name: "관심" },
    ...(data.categories || []),
  ];
  catsEl.innerHTML = items.map((c) =>
    `<button type="button" data-id="${c.id}" class="${c.id === "goldbox" ? "active" : ""}">${c.name}</button>`
  ).join("");
  catsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    setActive(id);
    searchInput.value = "";
    setDock(["goldbox", "tracked", "watch"].includes(id) ? id : "");
    if (id === "goldbox") load("/api/goldbox");
    else if (id === "tracked") load("/api/tracked");
    else if (id === "watch") loadWatch();
    else load(`/api/best/${id}`);
  });
}

gridEl.addEventListener("click", (e) => {
  if (e.target.closest(".cta")) return;
  const card = e.target.closest(".card");
  if (!card) return;
  openSheet(card.dataset.id);
});

sheetWatch.addEventListener("click", () => toggleWatch(sheetId));
dockEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.nav;
  setActive(id);
  setDock(id);
  searchInput.value = "";
  if (id === "goldbox") load("/api/goldbox");
  else if (id === "tracked") load("/api/tracked");
  else loadWatch();
});
sheetEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeSheet();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
});

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  setActive("");
  load(`/api/search?q=${encodeURIComponent(q)}`);
});

document.getElementById("homeLink").addEventListener("click", (e) => {
  e.preventDefault();
  searchInput.value = "";
  setActive("goldbox");
  load("/api/goldbox");
});

setupCats().then(() => load("/api/goldbox"));
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
