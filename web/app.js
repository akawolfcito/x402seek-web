/* Wayfinder preview UI. No framework: one search box, a card list and four
   static sections do not justify one, and a smaller dependency graph is easier
   to audit for a service that exists to be audited. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

let EVIDENCE = null;

/** 7-decimal SEP-41 base units → a human figure. Never rounded away to zero. */
function humanPrice(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return (n / 1e7).toFixed(7);
}

const shortKey = (k) => (k && k.length > 14 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k || "—");
const assetLabel = (contract) => {
  if (contract === EVIDENCE?.settlement?.assetContract) return "USDC (testnet)";
  if (contract === "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC") return "XLM (native SAC)";
  return shortKey(contract);
};

/* ---------- results ---------- */

function termsBlock(accepts, relevance, listing) {
  const dl = el("dl", "terms");
  const add = (k, v, title) => {
    const wrap = el("div", "term");
    if (title) wrap.title = title;
    wrap.append(el("dt", null, k), el("dd", null, v));
    dl.append(wrap);
  };
  add("Network", accepts.network);
  add("Scheme", accepts.scheme);
  add("Asset", assetLabel(accepts.asset), accepts.asset);
  add("Price", `${humanPrice(accepts.amount)} (${accepts.amount} base units)`);
  add("payTo", shortKey(accepts.payTo), accepts.payTo);
  add("Ownership", listing.ownershipBinding, "Trust on first use: bound to the payTo seen at first settlement. x402 proves who received a payment, not who controls a URL.");
  if (relevance !== undefined) add("Relevance", relevance.toFixed(4), "Dense cosine against the query, the same score the ranking used.");
  return dl;
}

function detailBlock(title, body) {
  const box = el("div", "detail");
  box.append(el("h4", null, title));
  box.append(body);
  return box;
}

function card(listing, relevance) {
  const root = el("article", "card");
  const accepts = listing.accepts?.[0] ?? {};

  const head = el("div", "card-head");
  head.append(el("span", "card-name", listing.serviceName || listing.canonicalKey));
  head.append(el("span", `kind ${listing.type}`, listing.type.toUpperCase()));
  if (relevance !== undefined) {
    const s = el("span", "score");
    s.append(el("span", null, "relevance "), document.createTextNode(relevance.toFixed(4)));
    head.append(s);
  }
  root.append(head);

  if (listing.description) root.append(el("p", "card-desc", listing.description));

  const origin = el("p", "origin-note");
  origin.textContent = listing.type === "mcp"
    ? "Testnet evidence resource — local origin used in the recorded testnet run."
    : "Testnet evidence resource — local origin used in the recorded testnet run.";
  root.append(origin);

  root.append(termsBlock(accepts, relevance, listing));

  /* Expandable detail: resource, schema, provenance. */
  const details = el("div");
  details.hidden = true;

  const res = el("dl", "terms");
  const addRes = (k, v) => {
    const w = el("div", "term");
    w.append(el("dt", null, k), el("dd", null, v));
    res.append(w);
  };
  addRes("Resource URL", listing.resource);
  addRes("Type", listing.type);
  if (listing.toolName) addRes("Tool name", listing.toolName);
  if (listing.method) addRes("Method", listing.method);
  addRes("Cataloged by tx", shortKey(listing.lastSettlementTx));
  details.append(detailBlock("Resource", res));

  const info = listing.extensions?.bazaar?.info ?? listing.discoveryInfo;
  if (info) {
    const pre = el("pre");
    pre.textContent = JSON.stringify(info, null, 2);
    details.append(detailBlock("Declared input / output", pre));
  }

  if (listing.lastSettlementTx) {
    const link = el("a", null, listing.lastSettlementTx);
    link.href = (EVIDENCE?.explorerBase ?? "") + listing.lastSettlementTx;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const p = el("p", "tx-links");
    p.append(link);
    details.append(detailBlock("Settlement that cataloged this listing", p));
  }

  const advisory = el("div", "advisory");
  advisory.append(el("strong", null, "Discovery terms are advisory. "));
  advisory.append(document.createTextNode(
    "Live payment requirements are re-checked against the resource before an agent signs or pays; " +
    "a material difference aborts before anything is signed.",
  ));
  details.append(advisory);

  root.append(details);
  head.addEventListener("click", () => { details.hidden = !details.hidden; });

  return root;
}

function renderAbstention(abstained) {
  const box = el("div", "abstain");
  box.append(el("h3", null, "NO RECOMMENDATION"));
  const code = el("code", null, abstained.reason);
  box.append(code);
  box.append(el("p", null, "Wayfinder did not find a service relevant enough to recommend spending on."));
  const nums = el("p", "nums");
  nums.textContent = `top score ${abstained.topScore.toFixed(4)} · threshold ${abstained.threshold}`;
  box.append(nums);
  return box;
}

/* ---------- search ---------- */

async function search(query) {
  const results = $("#results");
  const button = $("#go");
  button.disabled = true;
  results.replaceChildren(el("p", "empty", "Searching…"));

  const params = new URLSearchParams({ query });
  for (const [id, key] of [["#f-type", "type"], ["#f-network", "network"], ["#f-scheme", "scheme"]]) {
    const value = $(id).value;
    if (value) params.set(key, value);
  }

  try {
    const response = await fetch(`/api/discovery/search?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    results.replaceChildren();

    if (data.abstained) {
      results.append(renderAbstention(data.abstained));
    } else if (!data.resources?.length) {
      results.append(el("p", "empty", "No resources matched those filters."));
    } else {
      for (const listing of data.resources) {
        results.append(card(listing, data.relevance?.[listing.canonicalKey]));
      }
    }

    const meta = el("p", "empty");
    meta.textContent = `${data.resources?.length ?? 0} result(s) · ${data.tookMs} ms · abstention threshold ${data.threshold} cosine`;
    results.append(meta);
  } catch (error) {
    results.replaceChildren(el("p", "error", `Search failed: ${error.message}`));
  } finally {
    button.disabled = false;
  }
}

/* ---------- static sections ---------- */

function renderEvidence(e) {
  $("#disclosure").textContent = e.status.disclosure;
  $("#status-disclosure").textContent = e.status.disclosure;

  const stat = (n, k, ok) => {
    const box = el("div", "stat");
    box.append(el("div", `n${ok ? " ok" : ""}`, n), el("div", "k", k));
    return box;
  };

  $("#evidence-grid").replaceChildren(
    stat(`${e.conformance.payments.passed}/${e.conformance.payments.total}`, "upstream x402 payment scenarios", true),
    stat(`${e.conformance.discovery.passed}/${e.conformance.discovery.total}`, "Bazaar discovery checks", true),
    stat(e.settlement.buyerXlmDelta, "buyer XLM delta across 9 payments", true),
    stat(e.settlement.buyerUsdcDelta, `buyer ${e.settlement.asset} delta`, false),
  );

  const links = $("#tx-links");
  links.replaceChildren();
  for (const tx of e.transactions) {
    const lbl = el("span", "lbl", tx.label);
    const a = el("a", null, tx.hash);
    a.href = e.explorerBase + tx.hash;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const row = el("div");
    row.append(lbl, a);
    links.append(row);
  }

  /* benchmark */
  const body = $("#benchmark-body");
  body.replaceChildren();
  const table = el("table", "bench");
  const thead = el("thead");
  const hr = el("tr");
  hr.append(el("th", null, "Retriever"), el("th", null, "Held-out nDCG@10"));
  hr.lastChild.className = "num";
  thead.append(hr);
  table.append(thead);
  const tbody = el("tbody");
  for (const r of e.benchmark.retrievers) {
    const tr = el("tr", r.shipped ? "shipped" : r.reference ? "ref" : "");
    tr.append(el("td", null, r.name + (r.shipped ? " — shipped" : "")));
    const td = el("td", "num", `${r.ndcgAt10.toFixed(1)}%`);
    tr.append(td);
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);
  body.append(el("p", "caveat", e.benchmark.caveat));
  body.append(el("p", "lede",
    `${e.benchmark.corpusDocuments} listings · ${e.benchmark.queriesTotal} queries · ` +
    `${e.benchmark.queriesTuning} tuning / ${e.benchmark.queriesHeldOut} held-out · ` +
    "graded relevance labels written against the corpus before any retriever existed. " +
    "Hybrid RRF was expected to win and did not; dense shipped instead."));

  /* status */
  const col = (title, items, cls) => {
    const box = el("div", "stat");
    box.append(el("div", "k", title));
    const ul = el("ul", `list ${cls}`);
    for (const item of items) ul.append(el("li", null, item));
    box.append(ul);
    return box;
  };
  $("#status-grid").replaceChildren(
    col("BUILT / EVIDENCED", e.status.built, "built"),
    col("PLANNED", e.status.planned, "planned"),
  );

  $("#provenance").textContent =
    `Preview catalog: ${e.snapshot.listings} listings from recorded testnet runs · ` +
    `core commit ${e.snapshot.coreCommit.slice(0, 12)}`;
}

/* ---------- wire up ---------- */

$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const q = $("#q").value.trim();
  if (q) search(q);
});

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    $("#q").value = chip.dataset.q;
    search(chip.dataset.q);
  });
}

for (const id of ["#f-type", "#f-network", "#f-scheme"]) {
  $(id).addEventListener("change", () => {
    const q = $("#q").value.trim();
    if (q) search(q);
  });
}

(async () => {
  try {
    EVIDENCE = await (await fetch("/api/evidence")).json();
    renderEvidence(EVIDENCE);
  } catch {
    // Never overwrite the disclaimer with an error: the statement that this is
    // discovery only has to survive a failed fetch. Report the failure where
    // the evidence would have gone instead.
    $("#evidence-grid").replaceChildren(
      el("p", "error", "Recorded evidence could not be loaded. Reload, or read it in the repository."),
    );
  }
  search($("#q").value);
})();
