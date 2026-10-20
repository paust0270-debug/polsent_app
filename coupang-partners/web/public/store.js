const listView = document.getElementById("listView");
const shelvesEl = document.getElementById("shelves");
const nameEl = document.getElementById("name");
const taglineEl = document.getElementById("tagline");
const avatarEl = document.getElementById("avatar");
const queryEl = document.getElementById("query");
const countEl = document.getElementById("count");
const proposalEl = document.getElementById("proposal");
const proposalForm = document.getElementById("proposalForm");
const proposalDone = document.getElementById("proposalDone");
const formError = document.getElementById("formError");
let payload = { shelves: [] };
let campaignType = "";
const categories = new Set();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function productNumber(name) {
  const match = String(name || "").match(/^(\d+)/);
  return match ? match[1] : "";
}

function productTitle(name) {
  return String(name || "").replace(/^\d+\.?\s*/, "").trim();
}

function matches(product, query) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const number = productNumber(product.productName);
  const title = productTitle(product.productName).toLowerCase();
  const full = String(product.productName || "").toLowerCase();
  return tokens.every((token) => {
    if (/^\d+$/.test(token)) return number.startsWith(token);
    return title.includes(token) || full.includes(token);
  });
}

function allProducts() {
  const rows = [];
  for (const shelf of payload.shelves || []) {
    for (const product of shelf.products || []) rows.push(product);
  }
  return rows;
}

function rowHtml(product) {
  const href = /^https?:\/\//i.test(product.productUrl || "") ? product.productUrl : "";
  const open = href ? `href="${escapeHtml(href)}" target="_blank" rel="noopener sponsored nofollow"` : `href="#" data-dead="1"`;
  const number = productNumber(product.productName);
  const title = productTitle(product.productName) || product.productName || "";
  return `<a class="row" ${open}>
    <img src="${escapeHtml(product.productImage || "")}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity='0'"/>
    <span class="row-title">${number ? `<span class="row-no">${escapeHtml(number)}</span>` : ""}${escapeHtml(title)}</span>
  </a>`;
}

function paint() {
  const query = queryEl.value.trim();
  const rows = allProducts().filter((product) => matches(product, query));
  countEl.hidden = !query;
  countEl.textContent = query ? `${rows.length}개` : "";
  if (!rows.length) {
    shelvesEl.innerHTML = `<div class="sf-empty"><strong>${query ? "찾는 상품이 없습니다" : "아직 상품이 없습니다"}</strong><span>${query ? "번호나 다른 이름을 입력해 보세요." : "상품 목록이 비어 있습니다."}</span></div>`;
    return;
  }
  shelvesEl.innerHTML = `<div class="sf-list">${rows.map(rowHtml).join("")}</div>`;
}

function showError(message) {
  formError.hidden = !message;
  formError.textContent = message || "";
}

function openProposal() {
  listView.hidden = true;
  proposalEl.hidden = false;
  proposalForm.hidden = false;
  proposalDone.hidden = true;
  document.getElementById("top").hidden = true;
  window.scrollTo(0, 0);
}

function closeProposal() {
  proposalEl.hidden = true;
  listView.hidden = false;
  document.getElementById("top").hidden = false;
}

function draftLetter() {
  const brand = document.getElementById("brand").value.trim() || "브랜드";
  const product = document.getElementById("productName").value.trim() || "상품";
  const type = campaignType || "협업";
  const cats = [...categories].join(", ");
  const start = document.getElementById("start").value;
  const end = document.getElementById("end").value;
  const detail = document.getElementById("detail").value.trim();
  const payType = document.getElementById("payType").value;
  const payAmount = document.getElementById("payAmount").value.trim();
  const payLabel = { cash: "정액", profit_share: "수익배분", negotiation: "협의" }[payType] || "";
  const when = start || end ? `${start || "미정"} ~ ${end || "미정"}` : "";
  document.getElementById("letter").value = [
    `안녕하세요. ${brand}입니다.`,
    `${product} ${type}을 제안드립니다.`,
    cats ? `카테고리: ${cats}` : "",
    when ? `일정: ${when}` : "",
    payLabel ? `보상: ${payLabel}${payAmount ? ` ${payAmount}` : ""}` : "",
    detail,
    "검토 부탁드립니다.",
  ].filter(Boolean).join("\n");
}

async function load() {
  try {
    const res = await fetch("/api/storefront");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "스토어를 열지 못했습니다.");
    payload = data;
    const name = data.name || "스토어";
    nameEl.textContent = name;
    const fallback = "번호 또는 상품 이름으로 검색하세요";
    taglineEl.textContent = !data.tagline || data.tagline === "찾고 싶은 상품 이름을 검색하세요" ? fallback : data.tagline;
    avatarEl.textContent = [...name][0] || "딜";
    document.title = name;
    paint();
  } catch (error) {
    shelvesEl.innerHTML = `<div class="sf-empty"><strong>스토어를 열지 못했습니다</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

queryEl.addEventListener("input", paint);
document.getElementById("search").addEventListener("submit", (event) => {
  event.preventDefault();
  paint();
});
shelvesEl.addEventListener("click", (event) => {
  if (event.target.closest("[data-dead]")) event.preventDefault();
});
document.getElementById("top").addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});
document.getElementById("shareBtn").addEventListener("click", async () => {
  const link = location.href;
  try {
    await navigator.clipboard.writeText(link);
    document.getElementById("shareBtn").textContent = "복사됨";
  } catch {
    document.getElementById("shareBtn").textContent = "복사 실패";
  }
  setTimeout(() => {
    document.getElementById("shareBtn").textContent = "공유";
  }, 1400);
});
document.getElementById("bizBtn").addEventListener("click", openProposal);
document.getElementById("proposalBack").addEventListener("click", closeProposal);
document.getElementById("doneClose").addEventListener("click", closeProposal);
document.getElementById("typeChips").addEventListener("click", (event) => {
  const button = event.target.closest("[data-type]");
  if (!button) return;
  campaignType = button.dataset.type;
  for (const chip of document.querySelectorAll("#typeChips button")) chip.classList.toggle("on", chip === button);
});
document.getElementById("catChips").addEventListener("click", (event) => {
  const button = event.target.closest("[data-cat]");
  if (!button) return;
  if (categories.has(button.dataset.cat)) categories.delete(button.dataset.cat);
  else if (categories.size < 5) categories.add(button.dataset.cat);
  button.classList.toggle("on", categories.has(button.dataset.cat));
});
document.getElementById("payType").addEventListener("change", (event) => {
  const amount = document.getElementById("payAmount");
  const open = event.target.value === "cash" || event.target.value === "profit_share";
  amount.disabled = !open;
  amount.placeholder = event.target.value === "profit_share" ? "비율 (%)" : event.target.value === "cash" ? "금액 (원)" : "보상 형태를 먼저 선택";
  if (!open) amount.value = "";
});
document.getElementById("draftBtn").addEventListener("click", draftLetter);
proposalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const body = {
    type: campaignType,
    brand: document.getElementById("brand").value,
    product: document.getElementById("productName").value,
    categories: [...categories],
    detail: document.getElementById("detail").value,
    start: document.getElementById("start").value,
    end: document.getElementById("end").value,
    payType: document.getElementById("payType").value,
    payAmount: document.getElementById("payAmount").value,
    letter: document.getElementById("letter").value,
    contactName: document.getElementById("contactName").value,
    email: document.getElementById("email").value,
    phone: document.getElementById("phone").value,
    website: document.getElementById("website").value,
  };
  try {
    const res = await fetch("/api/storefront/proposal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "제안을 보내지 못했습니다.");
    proposalForm.hidden = true;
    proposalDone.hidden = false;
  } catch (error) {
    showError(error.message);
  }
});

load();
