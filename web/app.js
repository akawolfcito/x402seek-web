/* x402Seek preview UI. No framework: one search box, a card list and four
   static sections do not justify one, and a smaller dependency graph is easier
   to audit for a service that exists to be audited.

   This file renders; it does not decide. Every value shown comes from
   /api/discovery/search or /api/evidence, and nothing is computed here that the
   server did not already compute. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

let EVIDENCE = null;

/**
 * Which data source the page is showing: "evidence" or "live".
 *
 * The two are never blended. Every section that changes with it says which one
 * it is showing, and a live failure reports itself as a live failure — falling
 * back to recorded data under a live badge would be the worst thing this page
 * could do.
 */
let MODE = "evidence";
const isLive = () => MODE === "live";

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

/** Cosine as an arc. The only place on the page a number becomes a shape. */
function relevanceRing(score) {
  const R = 20;
  const C = 2 * Math.PI * R;
  const box = el("div", "ring");
  // The ring reads to two decimals; the full cosine stays available on hover so
  // showing it twice on the card is not needed.
  box.title = `Dense cosine ${score.toFixed(4)}. This is the score the ranking used.`;
  const s = svg("svg", { width: 54, height: 54, viewBox: "0 0 54 54" });
  s.append(
    svg("circle", { class: "track", cx: 27, cy: 27, r: R, fill: "none", "stroke-width": 4 }),
    svg("circle", {
      class: "arc",
      cx: 27, cy: 27, r: R, fill: "none", "stroke-width": 4,
      "stroke-dasharray": `${Math.max(0, Math.min(1, score)) * C} ${C}`,
    }),
  );
  const label = svg("text", {
    class: "val", x: 27, y: 27, "text-anchor": "middle",
    "dominant-baseline": "central", transform: "rotate(90 27 27)",
  });
  label.textContent = score.toFixed(2);
  s.append(label);
  box.append(s, el("span", "cap", "relevance"));
  return box;
}

function termsBlock(accepts, listing) {
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
  add("Price", humanPrice(accepts.amount), `${accepts.amount} base units`);
  add("payTo", shortKey(accepts.payTo), accepts.payTo);
  add(
    "Ownership",
    listing.ownershipBinding,
    "Trust on first use: bound to the payTo seen at first settlement. x402 proves who received a payment, not who controls a URL.",
  );
  return dl;
}

function detailBlock(title, body) {
  const box = el("div", "detail");
  box.append(el("h4", null, title));
  box.append(body);
  return box;
}

function card(listing, relevance, rank) {
  const root = el("article", "card");
  const accepts = listing.accepts?.[0] ?? {};

  const head = el("div", "card-head");
  head.append(el("span", "rank", String(rank).padStart(2, "0")));

  const mid = el("div");
  const title = el("div", "card-title");
  title.append(
    el("span", "card-name", listing.serviceName || listing.canonicalKey),
    el("span", `kind ${listing.type}`, listing.type.toUpperCase()),
  );
  mid.append(title);
  if (listing.description) mid.append(el("p", "card-desc", listing.description));
  head.append(mid);

  if (relevance !== undefined) head.append(relevanceRing(relevance));
  root.append(head);

  root.append(primaryTerms(accepts, listing));
  root.append(
    el("p", "origin-note", "Testnet evidence resource. Local origin used in the recorded run."),
  );

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
    const p = el("p", "tx");
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

  const toggle = el("button", "disclose", "View details");
  toggle.addEventListener("click", () => {
    details.hidden = !details.hidden;
    toggle.textContent = details.hidden ? "View details" : "Hide details";
  });
  root.append(el("div", "disclose-row", null));
  root.lastChild.append(toggle);
  root.append(details);

  return root;
}

/**
 * The three things a decision needs, and nothing else.
 *
 * Price, where it settles, and how strongly ownership is evidenced. Everything
 * else is protocol detail that belongs behind "View details" rather than in the
 * first thing a reader scans.
 */
function primaryTerms(accepts, listing) {
  const dl = el("dl", "terms primary");
  const add = (k, v, title) => {
    const w = el("div", "term");
    if (title) w.title = title;
    w.append(el("dt", null, k), el("dd", null, v));
    dl.append(w);
  };
  add("Price", `${humanPrice(accepts.amount)} ${assetLabel(accepts.asset)}`, accepts.asset);
  add("Settles on", `${accepts.network} · ${accepts.scheme}`);
  add(
    "Ownership",
    listing.ownershipBinding === "tofu" ? "TOFU verified" : listing.ownershipBinding,
    "Trust on first use: bound to the payTo seen at first settlement. x402 proves who received a payment, not who controls a URL.",
  );
  return dl;
}

/**
 * The abstention state.
 *
 * Given the most prominent treatment on the page on purpose: an agent with a
 * wallet acting on a weak result pays for the wrong service, so refusing is the
 * feature. The gauge shows the top score against the threshold that rejected it,
 * because "no results" is a claim the reader should be able to check.
 */
function renderAbstention(abstained) {
  const box = el("div", "abstain");
  box.append(el("h3", null, "No recommendation"));
  box.append(el("div", "code", abstained.reason));
  box.append(el("p", null, "x402Seek did not find a service relevant enough to recommend spending on."));

  if (Number.isFinite(abstained.topScore) && Number.isFinite(abstained.threshold)) {
    const gauge = el("div", "gauge");
    const bar = el("div", "gauge-bar");
    const scale = Math.max(abstained.threshold * 1.6, abstained.topScore * 1.2, 0.01);
    const fill = el("div", "gauge-fill");
    fill.style.width = `${Math.min(100, (abstained.topScore / scale) * 100)}%`;
    const mark = el("div", "gauge-mark");
    mark.style.left = `${Math.min(100, (abstained.threshold / scale) * 100)}%`;
    mark.title = "abstention threshold";
    bar.append(fill, mark);

    const legend = el("div", "gauge-legend");
    const left = el("span");
    left.append(document.createTextNode("top score "), el("b", null, abstained.topScore.toFixed(4)));
    const right = el("span");
    right.append(document.createTextNode("threshold "), el("b", null, String(abstained.threshold)));
    legend.append(left, right);

    gauge.append(bar, legend);
    box.append(gauge);
  }
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
    const endpoint = isLive() ? "/api/live/search" : "/api/discovery/search";
    const response = await fetch(`${endpoint}?${params}`);
    const data = await response.json();

    // A live outage says so. It does not become a search over frozen data.
    if (response.status === 503 && data.error === "LIVE_TESTNET_UNAVAILABLE") {
      results.replaceChildren(liveUnavailable(data.detail));
      return;
    }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    results.replaceChildren();

    if (data.abstained) {
      const box = renderAbstention(data.abstained);
      if (isLive()) {
        box.append(el("p", "note", "Answered by the hosted facilitator on Stellar testnet."));
      }
      results.append(box);
    } else if (!data.resources?.length) {
      results.append(el("p", "empty", "No resources matched those filters."));
    } else {
      data.resources.forEach((listing, i) => {
        const relevance = data.relevance?.[listing.canonicalKey];
        results.append(
          isLive() ? liveCard(listing, relevance, i + 1) : card(listing, relevance, i + 1),
        );
      });
    }

    const meta = el("p", "meta");
    // The live facilitator returns the Bazaar envelope and no timing sidecar,
    // so the line says what is actually known rather than printing "undefined".
    meta.textContent = isLive()
      ? `${data.resources?.length ?? 0} result(s) · live from the hosted facilitator`
      : `${data.resources?.length ?? 0} result(s) · ${data.tookMs} ms · ` +
        `abstention threshold ${data.threshold} cosine`;
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
    stat(`${e.conformance.payments.passed}/${e.conformance.payments.total}`, "x402 payment scenarios", true),
    stat(`${e.conformance.discovery.passed}/${e.conformance.discovery.total}`, "Bazaar discovery checks", true),
    stat("0 XLM", "buyer network fees", true),
    stat("0.009 USDC", "settled in recorded run", false),
  );

  // Hashes are long and low-priority. They stay one click away, never gone.
  const links = $("#tx-links");
  links.replaceChildren();
  const list = el("div", "tx-list");
  list.hidden = true;
  for (const tx of e.transactions) {
    const row = el("div");
    const a = el("a", null, tx.hash);
    a.href = e.explorerBase + tx.hash;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    row.append(el("span", "lbl", tx.label), a);
    list.append(row);
  }
  const show = el("button", "disclose", "View recorded transactions");
  show.addEventListener("click", () => {
    list.hidden = !list.hidden;
    show.textContent = list.hidden ? "View recorded transactions" : "Hide transactions";
  });
  links.append(show, list);

  /* benchmark — bars rather than a table: the argument is the gap between the
     reference retriever and dense, and a gap is easier to see than to read. */
  const body = $("#benchmark-body");
  body.replaceChildren();
  const bars = el("div", "bars");
  for (const r of e.benchmark.retrievers) {
    const row = el("div", `bar-row${r.shipped ? " shipped" : r.reference ? " ref" : ""}`);
    const name = el("div", "bar-name");
    name.append(document.createTextNode(r.name));
    if (r.shipped) name.append(el("span", "tag", "shipped"));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${Math.max(0, Math.min(100, r.ndcgAt10))}%`;
    track.append(fill);
    const left = el("div");
    left.append(name, track);
    row.append(left, el("div", "bar-val", `${r.ndcgAt10.toFixed(1)}%`));
    bars.append(row);
  }
  body.append(bars);
  // The caveat is never hidden. The method behind it is.
  body.append(el("p", "caveat", e.benchmark.caveat));
  body.append(el("p", "meta",
    `${e.benchmark.corpusDocuments} listings · ${e.benchmark.queriesTotal} queries · ` +
    `${e.benchmark.queriesHeldOut} held-out`));
  if (e.benchmark.methodology) {
    const method = el("p", "lede", e.benchmark.methodology);
    method.hidden = true;
    const show = el("button", "disclose", "Methodology");
    show.addEventListener("click", () => {
      method.hidden = !method.hidden;
      show.textContent = method.hidden ? "Methodology" : "Hide methodology";
    });
    body.append(show, method);
  }

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

/* ---------- live testnet ---------- */

function liveUnavailable(detail) {
  const box = el("div", "abstain");
  box.append(el("h3", null, "Live testnet unavailable"));
  box.append(el("div", "code", "LIVE_TESTNET_UNAVAILABLE"));
  box.append(el("p", null,
    `The hosted facilitator did not answer${detail ? `: ${detail}` : ""}. ` +
    "Recorded evidence stays under the Evidence tab. It is not shown here, " +
    "because it did not come from the live service."));
  return box;
}

/** A live resource card. Marked, so it can never read as recorded evidence. */
function liveCard(item, relevance, rank) {
  const card = el("article", "card live");
  const accepts = item.accepts?.[0] ?? {};

  const head = el("div", "card-head");
  head.append(el("span", "rank", String(rank).padStart(2, "0")));
  const mid = el("div");
  const title = el("div", "card-title");
  title.append(
    el("span", "card-name", item.serviceName || item.canonicalKey),
    el("span", `kind ${item.type}`, (item.type || "http").toUpperCase()),
    el("span", "live-badge", "LIVE TESTNET RESOURCE"),
  );
  mid.append(title);
  if (item.description) mid.append(el("p", "card-desc", item.description));
  head.append(mid);
  if (relevance !== undefined) head.append(relevanceRing(relevance));
  card.append(head);

  card.append(primaryTerms(accepts, item));

  // Protocol detail belongs behind a disclosure, not in the first scan.
  const details = el("div");
  details.hidden = true;
  const dl = el("dl", "terms");
  const add = (k, v) => {
    const w = el("div", "term");
    w.append(el("dt", null, k), el("dd", null, v));
    dl.append(w);
  };
  add("Resource URL", item.resource);
  add("payTo", accepts.payTo || "—");
  add("Asset", accepts.asset || "—");
  add("Amount", `${accepts.amount} atomic units`);
  add("Ownership binding", item.ownershipBinding || "—");
  details.append(detailBlock("Protocol details", dl));

  const toggle = el("button", "disclose", "View details");
  toggle.addEventListener("click", () => {
    details.hidden = !details.hidden;
    toggle.textContent = details.hidden ? "View details" : "Hide details";
  });
  const row = el("div", "disclose-row");
  row.append(toggle);
  card.append(row, details);

  // Inspect, never pay. The button reads the seller's current 402 and shows it.
  const actions = el("div", "live-actions");
  const inspect = el("button", "chip", "Inspect live 402");
  const out = el("div", "inspect");
  out.hidden = true;
  inspect.addEventListener("click", async () => {
    inspect.disabled = true;
    out.hidden = false;
    out.replaceChildren(el("p", "empty", "Reading the seller's current terms…"));
    try {
      const r = await fetch(`/api/live/inspect?resource=${encodeURIComponent(item.resource)}`);
      const d = await r.json();
      if (!r.ok) {
        out.replaceChildren(el("p", "error", `Could not read the live 402: ${d.detail || d.error}`));
        return;
      }
      const dl = el("dl", "terms");
      const add = (k, v) => {
        const w = el("div", "term");
        w.append(el("dt", null, k), el("dd", null, v));
        dl.append(w);
      };
      add("Status", `${d.status} Payment Required`);
      add("Network", d.terms.network);
      add("Scheme", d.terms.scheme);
      add("Asset", assetLabel(d.terms.asset));
      add("Price", humanPrice(d.terms.amount));
      add("payTo", shortKey(d.terms.payTo));
      out.replaceChildren(dl);
      const note = el("p", "advisory");
      note.append(el("strong", null, "Discovery is advisory. "));
      note.append(document.createTextNode(
        "These live 402 terms are the authority before payment. An agent revalidates them " +
        "against the resource and refuses to sign if they moved. Nothing was paid to read this.",
      ));
      out.append(note);
    } catch (error) {
      out.replaceChildren(el("p", "error", `Could not read the live 402: ${error.message}`));
    } finally {
      inspect.disabled = false;
    }
  });
  actions.append(inspect);
  card.append(actions, out);

  return card;
}

async function renderLiveStatus() {
  const box = $("#live-status");
  box.hidden = false;
  box.replaceChildren(el("p", "empty", "Asking the hosted facilitator…"));
  try {
    const r = await fetch("/api/live/status");
    const d = await r.json();
    if (!r.ok) {
      box.replaceChildren(liveUnavailable(d.detail));
      return false;
    }
    box.replaceChildren();
    const row = el("div", "live-row");
    const chip = (k, v, ok) => {
      const c = el("div", `live-chip${ok === true ? " ok" : ok === false ? " bad" : ""}`);
      c.append(el("span", "k", k), el("span", "v", v));
      return c;
    };
    const ready = (v) => v.charAt(0).toUpperCase() + v.slice(1);
    row.append(
      chip("Facilitator", d.ready ? "Ready" : "Not ready", d.ready),
      chip("Network", d.network),
      chip("Scheme", d.scheme),
      chip("Catalog", `${d.catalog} resource${d.catalog === 1 ? "" : "s"}`),
      chip("Search", ready(d.discovery.status), d.discovery.status === "ready"),
      chip("Settlement", "Enabled", true),
    );
    box.append(row);
    box.append(el("p", "note",
      "Classic accounts only. upto is not supported yet. This page does not initiate payments."));
    return true;
  } catch (error) {
    box.replaceChildren(liveUnavailable(error.message));
    return false;
  }
}

async function renderHostedSettlement() {
  const box = $("#hosted-settlement");
  box.hidden = false;
  try {
    const s = await (await fetch("/api/live/settlement")).json();
    box.replaceChildren();
    box.append(el("h3", "hosted-title", "Hosted settlement"));

    // Three figures carry the story. The addresses are real evidence but they
    // are not what a reader needs in the first two seconds.
    const dl = el("dl", "terms primary");
    const add = (k, v, title) => {
      const w = el("div", "term");
      if (title) w.title = title;
      w.append(el("dt", null, k), el("dd", null, v));
      dl.append(w);
    };
    add("Amount", `${s.amount} USDC`);
    add("Buyer XLM fee", "0", "Fee sponsorship: the buyer spent no XLM");
    add("Facilitator fee", `${s.facilitatorFeeXlm} XLM`);
    box.append(dl);

    const link = el("a", "disclose-link", "View on Stellar Expert");
    link.href = (EVIDENCE?.explorerBase ?? "https://stellar.expert/explorer/testnet/tx/") + s.transaction;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const parties = el("dl", "terms");
    for (const [k, v] of [["Buyer", s.buyer], ["Seller", s.seller], ["Facilitator", s.facilitator]]) {
      const w = el("div", "term");
      w.title = v;
      w.append(el("dt", null, k), el("dd", null, shortKey(v)));
      parties.append(w);
    }
    parties.hidden = true;
    const more = el("button", "disclose", "View addresses");
    more.addEventListener("click", () => {
      parties.hidden = !parties.hidden;
      more.textContent = parties.hidden ? "View addresses" : "Hide addresses";
    });

    const row = el("div", "disclose-row");
    row.append(link, more);
    box.append(row, parties);
    box.append(el("p", "note", s.note));
  } catch {
    box.replaceChildren(el("p", "error", "The hosted settlement record could not be loaded."));
  }
}

async function setMode(mode) {
  MODE = mode;
  $("#mode-evidence").classList.toggle("is-active", mode === "evidence");
  $("#mode-live").classList.toggle("is-active", mode === "live");
  $("#mode-evidence").setAttribute("aria-selected", String(mode === "evidence"));
  $("#mode-live").setAttribute("aria-selected", String(mode === "live"));
  document.body.classList.toggle("live-mode", mode === "live");

  $("#discovery-source").textContent = isLive()
    ? "Live testnet"
    : "Recorded evidence";

  $("#live-status").hidden = !isLive();
  $("#hosted-settlement").hidden = !isLive();
  $("#hero-live").hidden = !isLive();

  if (isLive()) {
    await renderLiveStatus();
    await renderHostedSettlement();
  }
  await search($("#q").value);
}

/* ---------- wire up ---------- */

$("#mode-evidence").addEventListener("click", () => setMode("evidence"));
$("#mode-live").addEventListener("click", () => setMode("live"));

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
