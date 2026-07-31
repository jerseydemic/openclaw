/* FairPlay SPA — hash-routed, no dependencies. All user content is rendered
   via textContent (never innerHTML) so submissions cannot inject markup. */
const app = document.getElementById("app");

const CATEGORY_LABELS = {
  "contract-terms": "Contract terms",
  "royalty-payments": "Royalty payments",
  "advance-recoupment": "Advances & recoupment",
  "ownership-rights": "Ownership & rights",
  communication: "Communication & professionalism",
  misrepresentation: "Misrepresentation",
  other: "Other",
};

// --- tiny DOM helpers -------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function stars(rating) {
  const span = el("span", { class: "stars", "aria-label": `${rating} out of 5` });
  for (let i = 1; i <= 5; i++) {
    span.append(el("span", { class: i <= Math.round(rating) ? "" : "empty" }, "★"));
  }
  return span;
}

function notice(message, isError = false) {
  return el("div", { class: `notice${isError ? " error" : ""}`, role: "status" }, message);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function render(...children) {
  app.replaceChildren(...children);
  window.scrollTo(0, 0);
}

// --- pages ------------------------------------------------------------------
async function pageBrowse() {
  const list = el("div");
  const input = el("input", {
    type: "search",
    placeholder: "Search by name, company, or role…",
    "aria-label": "Search executives",
  });

  async function refresh() {
    const { executives } = await api(`/api/executives?q=${encodeURIComponent(input.value)}`);
    list.replaceChildren(
      executives.length
        ? el("div", {}, executives.map(execCard))
        : el("p", { class: "muted" }, "No published profiles match. Profiles appear after moderation — be the first to submit a review."),
    );
  }
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => refresh().catch(console.error), 200);
  });

  render(
    el("section", { class: "hero" },
      el("h1", {}, "Know who you're signing with."),
      el("p", {}, "Moderated, first-hand reviews of music industry executives, managers, and labels — contract terms, royalty practices, and professional conduct, reported by the artists who lived them."),
      el("a", { class: "btn primary", href: "#/submit" }, "Share your experience"),
    ),
    el("div", { class: "search-row" }, input),
    list,
  );
  await refresh();
}

function execCard(executive) {
  const subtitle = [executive.role, executive.company, executive.region].filter(Boolean).join(" · ");
  return el("div", {
      class: "card clickable",
      onclick: () => { location.hash = `#/exec/${executive.id}`; },
    },
    el("h3", {}, executive.name),
    subtitle ? el("div", { class: "meta" }, subtitle) : null,
    el("div", { class: "rating-line" },
      executive.averageRating !== null
        ? [stars(executive.averageRating), el("span", { class: "muted" }, `${executive.averageRating} · ${executive.reviewCount} review${executive.reviewCount === 1 ? "" : "s"}`)]
        : el("span", { class: "muted" }, "No published reviews yet"),
    ),
  );
}

async function pageExecutive(id) {
  let executive;
  try {
    ({ executive } = await api(`/api/executives/${id}`));
  } catch (err) {
    return render(notice(err.message, true));
  }
  const subtitle = [executive.role, executive.company, executive.region].filter(Boolean).join(" · ");
  const categoryBadges = Object.entries(executive.categories).map(([key, count]) =>
    el("span", { class: "badge" }, `${CATEGORY_LABELS[key] ?? key} × ${count}`),
  );
  render(
    el("section", {},
      el("h1", {}, executive.name),
      subtitle ? el("p", { class: "muted" }, subtitle) : null,
      el("div", { class: "rating-line" },
        executive.averageRating !== null
          ? [el("span", { class: "rating-num" }, executive.averageRating), stars(executive.averageRating), el("span", { class: "muted" }, `${executive.reviewCount} published review${executive.reviewCount === 1 ? "" : "s"}`)]
          : el("span", { class: "muted" }, "No published reviews yet"),
      ),
      el("div", {}, categoryBadges),
      el("p", {},
        el("a", { class: "btn primary", href: `#/submit?exec=${executive.id}` }, "Write a review"),
        " ",
        el("a", { class: "btn", href: `#/dispute/executive/${executive.id}` }, "Is this you? Respond or dispute"),
      ),
      el("div", {}, executive.reviews.map(reviewBlock)),
    ),
  );
}

function reviewBlock(review) {
  const meta = [
    review.reviewerName,
    review.dealYear ? `deal year ${review.dealYear}` : null,
    CATEGORY_LABELS[review.category] ?? review.category,
    new Date(review.createdAt).toLocaleDateString(),
  ].filter(Boolean).join(" · ");
  return el("article", { class: "review" },
    el("h4", {}, review.title),
    el("div", {}, stars(review.rating)),
    el("div", { class: "meta muted" }, meta),
    el("p", { class: "body" }, review.body),
    review.responses.map((resp) =>
      el("div", { class: "response" },
        el("div", { class: "who" }, `Response from ${resp.responderName}${resp.responderRole ? ` (${resp.responderRole})` : ""}`),
        el("p", { class: "body" }, resp.body),
      ),
    ),
    el("a", { class: "muted", href: `#/respond/${review.id}` }, "Respond to this review"),
  );
}

async function pageSubmit(params) {
  const { executives } = await api("/api/executives");
  const preselected = params.get("exec") ?? "";

  const select = el("select", { name: "executiveId" },
    el("option", { value: "" }, "— Add someone not listed —"),
    executives.map((e) => {
      const opt = el("option", { value: e.id }, `${e.name}${e.company ? ` (${e.company})` : ""}`);
      if (e.id === preselected) opt.selected = true;
      return opt;
    }),
  );

  const newExecFields = el("fieldset", {},
    el("legend", {}, "New profile (moderated before publication)"),
    el("label", {}, "Full name", el("input", { name: "newName", placeholder: "e.g. Jordan Placeholder" })),
    el("label", {}, "Role", el("input", { name: "newRole", placeholder: "e.g. A&R Executive, Manager" })),
    el("label", {}, "Company / label", el("input", { name: "newCompany" })),
    el("label", {}, "Region", el("input", { name: "newRegion", placeholder: "e.g. Atlanta, GA" })),
  );
  const syncNewFields = () => { newExecFields.style.display = select.value ? "none" : ""; };
  select.addEventListener("change", syncNewFields);

  const status = el("div");
  const form = el("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      status.replaceChildren();
      try {
        let executiveId = fd.get("executiveId");
        if (!executiveId) {
          const { executive } = await api("/api/executives", { method: "POST", body: {
            name: fd.get("newName"), role: fd.get("newRole"),
            company: fd.get("newCompany"), region: fd.get("newRegion"),
          }});
          executiveId = executive.id;
        }
        await api("/api/reviews", { method: "POST", body: {
          executiveId,
          rating: Number(fd.get("rating")),
          category: fd.get("category"),
          title: fd.get("title"),
          body: fd.get("body"),
          dealYear: fd.get("dealYear") || null,
          reviewerName: fd.get("reviewerName"),
          firsthand: fd.get("firsthand") === "on",
        }});
        render(
          notice("Thank you — your review was submitted and will appear once a moderator approves it."),
          el("a", { class: "btn", href: "#/" }, "Back to browse"),
        );
      } catch (err) {
        status.replaceChildren(notice(err.message, true));
      }
    }},
    el("label", {}, "Who is this review about?", select),
    newExecFields,
    el("label", {}, "Overall rating",
      el("select", { name: "rating", required: "" },
        [5, 4, 3, 2, 1].map((n) => el("option", { value: n }, `${n} — ${["", "Avoid", "Poor", "Mixed", "Good", "Excellent"][n]}`)),
      ),
    ),
    el("label", {}, "Main issue category",
      el("select", { name: "category", required: "" },
        Object.entries(CATEGORY_LABELS).map(([value, label]) => el("option", { value }, label)),
      ),
    ),
    el("label", {}, "Title", el("input", { name: "title", required: "", maxlength: "160", placeholder: "Summarize your experience" })),
    el("label", {}, "Your experience",
      el("span", { class: "hint" }, "Describe what happened, factually. Stick to events you were part of; avoid labels like “scammer” — describe the conduct instead. No personal contact details."),
      el("textarea", { name: "body", required: "", minlength: "30", maxlength: "5000" }),
    ),
    el("label", {}, "Year of the deal (optional)", el("input", { name: "dealYear", type: "number", min: "1950", max: String(new Date().getFullYear()) })),
    el("label", {}, "Display name (optional — leave blank to post as Anonymous)", el("input", { name: "reviewerName", maxlength: "80" })),
    el("label", { class: "check" },
      el("input", { type: "checkbox", name: "firsthand", required: "" }),
      el("span", {}, "I confirm this review describes my own first-hand experience, is truthful to the best of my knowledge, and follows the ", el("a", { href: "#/guidelines" }, "community guidelines"), "."),
    ),
    el("button", { class: "primary", type: "submit" }, "Submit for moderation"),
    status,
  );

  render(el("h1", {}, "Share your experience"), form);
  syncNewFields();
}

function pageRespond(reviewId) {
  const status = el("div");
  const form = el("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      try {
        await api("/api/responses", { method: "POST", body: {
          reviewId,
          responderName: fd.get("responderName"),
          responderRole: fd.get("responderRole"),
          body: fd.get("body"),
        }});
        render(notice("Response submitted. It will appear under the review once approved."), el("a", { class: "btn", href: "#/" }, "Back"));
      } catch (err) {
        status.replaceChildren(notice(err.message, true));
      }
    }},
    el("label", {}, "Your name", el("input", { name: "responderName", required: "" })),
    el("label", {}, "Your role (optional)", el("input", { name: "responderRole", placeholder: "e.g. the executive named, their representative" })),
    el("label", {}, "Response", el("textarea", { name: "body", required: "", minlength: "10", maxlength: "5000" })),
    el("button", { class: "primary", type: "submit" }, "Submit response"),
    status,
  );
  render(
    el("h1", {}, "Respond to a review"),
    el("p", { class: "muted" }, "Right of reply: anyone reviewed on this site may publish a response. Responses are moderated for guidelines compliance only — disagreement with the review is fine."),
    form,
  );
}

function pageDispute(subjectType, subjectId) {
  const status = el("div");
  const form = el("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      try {
        await api("/api/disputes", { method: "POST", body: {
          subjectType, subjectId,
          contactEmail: fd.get("contactEmail"),
          reason: fd.get("reason"),
        }});
        render(notice("Dispute received. A moderator will re-review the content and contact you."), el("a", { class: "btn", href: "#/" }, "Back"));
      } catch (err) {
        status.replaceChildren(notice(err.message, true));
      }
    }},
    el("label", {}, "Contact email", el("input", { name: "contactEmail", type: "email", required: "" })),
    el("label", {}, "What is inaccurate or unfair, and why?",
      el("span", { class: "hint" }, "Content that cannot be substantiated against our guidelines is removed."),
      el("textarea", { name: "reason", required: "", minlength: "20", maxlength: "5000" }),
    ),
    el("button", { class: "primary", type: "submit" }, "File dispute"),
    status,
  );
  render(el("h1", {}, "Dispute content"), form);
}

// --- moderation -------------------------------------------------------------
async function pageAdmin() {
  const token = sessionStorage.getItem("adminToken") ?? "";
  const tokenInput = el("input", { type: "password", value: token, placeholder: "Admin token", "aria-label": "Admin token" });
  const queueBox = el("div");

  async function loadQueue() {
    sessionStorage.setItem("adminToken", tokenInput.value);
    const headers = { "x-admin-token": tokenInput.value };
    try {
      const queue = await api("/api/admin/queue", { headers });
      queueBox.replaceChildren(
        adminSection("Pending profiles", queue.executives, (e) => `${e.name} — ${[e.role, e.company].filter(Boolean).join(", ") || "no details"}`, "executive", headers),
        adminSection("Pending reviews", queue.reviews, (r) => `${r.title} (${r.rating}★, ${r.category}) about ${r.executive?.name ?? "?"} — ${r.body}`, "review", headers),
        adminSection("Pending responses", queue.responses, (r) => `${r.responderName}: ${r.body}`, "response", headers),
        adminSection("Open disputes", queue.disputes, (d) => `${d.subjectType} ${d.subjectId} — ${d.reason} (contact: ${d.contactEmail})`, "dispute", headers),
      );
    } catch (err) {
      queueBox.replaceChildren(notice(err.message, true));
    }
  }

  render(
    el("h1", {}, "Moderation queue"),
    el("div", { class: "search-row" }, tokenInput, el("button", { class: "primary", onclick: loadQueue }, "Load queue")),
    queueBox,
  );
  if (token) await loadQueue();
}

function adminSection(title, items, describe, type, headers) {
  const actions = type === "dispute" ? [["resolve", "Resolve"], ["dismiss", "Dismiss"]] : [["approve", "Approve"], ["reject", "Reject"]];
  return el("section", {},
    el("h2", {}, `${title} (${items.length})`),
    items.length ? items.map((item) =>
      el("div", { class: "card" },
        el("p", { class: "body" }, describe(item)),
        el("div", {}, actions.map(([action, label]) =>
          el("button", { class: `small ${action === "approve" || action === "resolve" ? "approve" : "danger"}`, onclick: async (event) => {
            event.target.disabled = true;
            try {
              await api("/api/admin/moderate", { method: "POST", headers, body: { type, id: item.id, action } });
              event.target.closest(".card").remove();
            } catch (err) {
              event.target.disabled = false;
              alert(err.message);
            }
          }}, label), " ",
        )),
      ),
    ) : el("p", { class: "muted" }, "Nothing pending."),
  );
}

// --- router -----------------------------------------------------------------
function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, queryString] = hash.split("?");
  const params = new URLSearchParams(queryString ?? "");
  const parts = path.split("/").filter(Boolean);

  if (parts.length === 0) return pageBrowse();
  if (parts[0] === "exec" && parts[1]) return pageExecutive(parts[1]);
  if (parts[0] === "submit") return pageSubmit(params);
  if (parts[0] === "respond" && parts[1]) return pageRespond(parts[1]);
  if (parts[0] === "dispute" && parts[1] && parts[2]) return pageDispute(parts[1], parts[2]);
  if (parts[0] === "guidelines") {
    return render(document.getElementById("tpl-guidelines").content.cloneNode(true));
  }
  if (parts[0] === "admin") return pageAdmin();
  return pageBrowse();
}

window.addEventListener("hashchange", () => route());
route();
