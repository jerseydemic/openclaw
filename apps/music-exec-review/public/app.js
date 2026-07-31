/* FairPlay SPA — hash-routed, no dependencies. All user content is rendered
   via textContent (never innerHTML) so submissions cannot inject markup. */
const app = document.getElementById("app");

const CATEGORY_LABELS = {
  "contract-terms": "Contract terms",
  "royalty-payments": "Royalty payments",
  "advance-recoupment": "Advances & recoupment",
  "ownership-rights": "Ownership & rights",
  "publishing-splits": "Publishing & songwriting splits",
  "unpaid-fees": "Unpaid fees or invoices",
  "tour-live-deals": "Touring & live deals",
  communication: "Communication & professionalism",
  misrepresentation: "Misrepresentation",
  other: "Other",
};

const REPORT_REASONS = {
  false: "Contains false statements",
  harassment: "Harassment or abuse",
  "private-info": "Contains private/personal information",
  spam: "Spam or fake review",
  "not-firsthand": "Not a first-hand account",
  other: "Other",
};

const LINK_LABELS = { linkedin: "LinkedIn", instagram: "Instagram", website: "Website" };

// Renders profile links safely: https only, opened in a new tab with the
// referrer and opener stripped, and nofollow so we do not pass ranking signal.
function linkRow(links = {}) {
  const entries = Object.entries(LINK_LABELS)
    .filter(([key]) => links[key])
    .map(([key, label]) =>
      el("a", {
        class: "badge link-badge",
        href: links[key],
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      }, label),
    );
  return entries.length ? el("div", { class: "link-row" }, entries) : null;
}

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

// --- captcha (Cloudflare Turnstile) -----------------------------------------
// The server tells us whether a site key is configured; when it isn't, every
// helper here degrades to a no-op so local dev needs no captcha setup.
let CONFIG = { turnstileSiteKey: null };
let configPromise = null;
let scriptPromise = null;

function ensureConfig() {
  if (!configPromise) {
    configPromise = api("/api/config")
      .then((cfg) => {
        CONFIG = cfg;
        return cfg;
      })
      .catch(() => CONFIG);
  }
  return configPromise;
}

function loadTurnstileScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("captcha script failed to load"));
    document.head.append(script);
  });
  return scriptPromise;
}

/**
 * Build a captcha slot for a form. Returns the element to append plus token
 * accessors. Tokens are single-use, so reset() after a failed submit.
 */
function captchaField() {
  if (!CONFIG.turnstileSiteKey) {
    return { element: null, getToken: () => undefined, reset: () => {} };
  }
  const holder = el("div", { class: "captcha" });
  let widgetId = null;
  loadTurnstileScript()
    .then(() => {
      widgetId = window.turnstile.render(holder, { sitekey: CONFIG.turnstileSiteKey });
    })
    .catch(() => {
      holder.replaceChildren(notice("The captcha could not load. Please refresh and try again.", true));
    });
  return {
    element: holder,
    getToken: () =>
      widgetId !== null && window.turnstile ? window.turnstile.getResponse(widgetId) : undefined,
    reset: () => {
      if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
    },
  };
}

// --- pages ------------------------------------------------------------------
async function pageBrowse() {
  const list = el("div");
  const input = el("input", {
    type: "search",
    placeholder: "Search by name, company, or role…",
    "aria-label": "Search executives",
  });
  const locationInput = el("input", {
    type: "search",
    placeholder: "Filter by location…",
    "aria-label": "Filter by location",
  });
  const categorySelect = el("select", { "aria-label": "Filter by category" },
    el("option", { value: "" }, "All categories"),
    Object.entries(CATEGORY_LABELS).map(([value, label]) => el("option", { value }, label)),
  );
  const sortSelect = el("select", { "aria-label": "Sort results" },
    el("option", { value: "reviews" }, "Most reviewed"),
    el("option", { value: "worst" }, "Lowest rated first"),
    el("option", { value: "best" }, "Highest rated first"),
    el("option", { value: "name" }, "Name (A–Z)"),
  );

  async function refresh() {
    const params = new URLSearchParams({
      q: input.value,
      location: locationInput.value,
      category: categorySelect.value,
      sort: sortSelect.value,
    });
    const { executives } = await api(`/api/executives?${params}`);
    list.replaceChildren(
      el("p", { class: "muted result-count" },
        `${executives.length} profile${executives.length === 1 ? "" : "s"}`),
      executives.length
        ? el("div", {}, executives.map(execCard))
        : el("p", { class: "muted" }, "No published profiles match those filters. Profiles appear after moderation — be the first to submit a review."),
    );
  }
  let timer;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(() => refresh().catch(console.error), 200);
  };
  input.addEventListener("input", debounced);
  locationInput.addEventListener("input", debounced);
  categorySelect.addEventListener("change", () => refresh().catch(console.error));
  sortSelect.addEventListener("change", () => refresh().catch(console.error));

  render(
    el("section", { class: "hero" },
      el("h1", {}, "Know who you're signing with."),
      el("p", {}, "Moderated, first-hand reviews of music industry executives, managers, and labels — contract terms, royalty practices, and professional conduct, reported by the artists who lived them."),
      el("a", { class: "btn primary", href: "#/submit" }, "Share your experience"),
    ),
    el("div", { class: "search-row" }, input, locationInput),
    el("div", { class: "filter-row" }, categorySelect, sortSelect),
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
    el("h3", {},
      executive.name,
      executive.claimed ? el("span", { class: "badge claimed", title: "This profile has been claimed and verified by its subject" }, "Claimed") : null,
    ),
    subtitle ? el("div", { class: "meta" }, subtitle) : null,
    el("div", { class: "rating-line" },
      executive.averageRating !== null
        ? [stars(executive.averageRating), el("span", { class: "muted" }, `${executive.averageRating} · ${executive.reviewCount} review${executive.reviewCount === 1 ? "" : "s"}`)]
        : el("span", { class: "muted" }, "No published reviews yet"),
    ),
    executive.locations?.length
      ? el("div", { class: "meta" }, `Reported in: ${executive.locations.slice(0, 3).join(" · ")}`)
      : null,
    linkRow(executive.links),
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
      executive.locations?.length
        ? el("p", { class: "meta" }, `Reported dealings in: ${executive.locations.join(" · ")}`)
        : null,
      linkRow(executive.links),
      el("p", {},
        el("a", { class: "btn primary", href: `#/submit?exec=${executive.id}` }, "Write a review"),
        " ",
        el("a", { class: "btn", href: `#/dispute/executive/${executive.id}` }, "Is this you? Respond or dispute"),
        " ",
        el("a", { class: "btn", href: `#/claim/${executive.id}` }, "Claim this profile"),
      ),
      el("div", {}, executive.reviews.map(reviewBlock)),
    ),
  );
}

function reviewBlock(review) {
  const meta = [
    review.reviewerName,
    review.dealYear ? `deal year ${review.dealYear}` : null,
    review.location || null,
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
    el("div", { class: "review-actions" },
      el("a", { class: "muted", href: `#/respond/${review.id}` }, "Respond to this review"),
      el("a", { class: "muted", href: `#/report/${review.id}` }, "Report this review"),
    ),
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
    el("label", {}, "Where they are based", el("input", { name: "newRegion", placeholder: "e.g. Atlanta, GA" })),
    el("label", {}, "LinkedIn profile (optional)",
      el("span", { class: "hint" }, "Helps moderators confirm this is the right person and avoid mixing up people with the same name."),
      el("input", { name: "newLinkedin", type: "url", placeholder: "https://www.linkedin.com/in/…" }),
    ),
    el("label", {}, "Instagram profile (optional)",
      el("input", { name: "newInstagram", type: "url", placeholder: "https://www.instagram.com/…" }),
    ),
    el("label", {}, "Company website (optional)",
      el("input", { name: "newWebsite", type: "url", placeholder: "https://…" }),
    ),
  );
  const syncNewFields = () => { newExecFields.style.display = select.value ? "none" : ""; };
  select.addEventListener("change", syncNewFields);

  const status = el("div");
  const captcha = captchaField();
  const form = el("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      const submitButton = form.querySelector("button[type=submit]");
      status.replaceChildren();
      submitButton.disabled = true;
      try {
        const executiveId = fd.get("executiveId");
        // One atomic request: the server creates the profile when needed, so a
        // single captcha token covers the whole submission.
        await api("/api/reviews", { method: "POST", body: {
          executiveId: executiveId || undefined,
          newExecutive: executiveId ? undefined : {
            name: fd.get("newName"), role: fd.get("newRole"),
            company: fd.get("newCompany"), region: fd.get("newRegion"),
            links: {
              linkedin: fd.get("newLinkedin"),
              instagram: fd.get("newInstagram"),
              website: fd.get("newWebsite"),
            },
          },
          rating: Number(fd.get("rating")),
          category: fd.get("category"),
          title: fd.get("title"),
          body: fd.get("body"),
          dealYear: fd.get("dealYear") || null,
          location: fd.get("location"),
          reviewerName: fd.get("reviewerName"),
          firsthand: fd.get("firsthand") === "on",
          turnstileToken: captcha.getToken(),
        }});
        render(
          notice("Thank you — your review was submitted and will appear once a moderator approves it."),
          el("a", { class: "btn", href: "#/" }, "Back to browse"),
        );
      } catch (err) {
        // Captcha tokens are single-use, so re-arm the widget before a retry.
        captcha.reset();
        submitButton.disabled = false;
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
    el("label", {}, "Where did this take place? (optional)",
      el("span", { class: "hint" }, "City and country, e.g. “Atlanta, GA, USA” or “London, UK”. This is where the dealings happened, which may differ from where they are based."),
      el("input", { name: "location", maxlength: "120", placeholder: "e.g. Atlanta, GA, USA" }),
    ),
    el("label", {}, "Display name (optional — leave blank to post as Anonymous)", el("input", { name: "reviewerName", maxlength: "80" })),
    el("label", { class: "check" },
      el("input", { type: "checkbox", name: "firsthand", required: "" }),
      el("span", {},
        "I confirm this review describes my own first-hand experience and is truthful to the best of my knowledge, and I agree to the ",
        el("a", { href: "#/guidelines" }, "community guidelines"), ", ",
        el("a", { href: "#/terms" }, "terms of service"), ", and ",
        el("a", { href: "#/privacy" }, "privacy policy"), ".",
      ),
    ),
    captcha.element,
    el("button", { class: "primary", type: "submit" }, "Submit for moderation"),
    status,
  );

  render(el("h1", {}, "Share your experience"), form);
  syncNewFields();
}

function pageRespond(reviewId) {
  const status = el("div");
  const captcha = captchaField();
  const form = el("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      try {
        await api("/api/responses", { method: "POST", body: {
          reviewId,
          responderName: fd.get("responderName"),
          responderRole: fd.get("responderRole"),
          body: fd.get("body"),
          turnstileToken: captcha.getToken(),
        }});
        render(notice("Response submitted. It will appear under the review once approved."), el("a", { class: "btn", href: "#/" }, "Back"));
      } catch (err) {
        captcha.reset();
        status.replaceChildren(notice(err.message, true));
      }
    }},
    el("label", {}, "Your name", el("input", { name: "responderName", required: "" })),
    el("label", {}, "Your role (optional)", el("input", { name: "responderRole", placeholder: "e.g. the executive named, their representative" })),
    el("label", {}, "Response", el("textarea", { name: "body", required: "", minlength: "10", maxlength: "5000" })),
    captcha.element,
    el("button", { class: "primary", type: "submit" }, "Submit response"),
    status,
  );
  render(
    el("h1", {}, "Respond to a review"),
    el("p", { class: "muted" }, "Right of reply: anyone reviewed on this site may publish a response. Responses are moderated for guidelines compliance only — disagreement with the review is fine."),
    form,
  );
}

function pageReport(reviewId) {
  const status = el("div");
  const captcha = captchaField();
  const form = el("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      try {
        await api("/api/reports", { method: "POST", body: {
          reviewId,
          reason: fd.get("reason"),
          detail: fd.get("detail"),
          reporterEmail: fd.get("reporterEmail"),
          turnstileToken: captcha.getToken(),
        }});
        render(
          notice("Thank you — a moderator will re-review this content."),
          el("a", { class: "btn", href: "#/" }, "Back to browse"),
        );
      } catch (err) {
        captcha.reset();
        status.replaceChildren(notice(err.message, true));
      }
    }},
    el("label", {}, "What is wrong with this review?",
      el("select", { name: "reason", required: "" },
        Object.entries(REPORT_REASONS).map(([value, label]) => el("option", { value }, label)),
      ),
    ),
    el("label", {}, "Details (optional)",
      el("span", { class: "hint" }, "Anything that helps a moderator assess it — what specifically is inaccurate, and how you know."),
      el("textarea", { name: "detail", maxlength: "5000" }),
    ),
    el("label", {}, "Your email (optional)",
      el("span", { class: "hint" }, "Only used if a moderator needs to follow up. Never published."),
      el("input", { name: "reporterEmail", type: "email" }),
    ),
    captcha.element,
    el("button", { class: "primary", type: "submit" }, "Submit report"),
    status,
  );
  render(
    el("h1", {}, "Report a review"),
    el("p", { class: "muted" }, "Anyone can flag published content for re-review. If you are the person named, you can also use the dispute form on their profile."),
    form,
  );
}

function pageClaim(executiveId) {
  const status = el("div");
  const captcha = captchaField();
  const form = el("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      try {
        await api("/api/claims", { method: "POST", body: {
          executiveId,
          claimantName: fd.get("claimantName"),
          claimantEmail: fd.get("claimantEmail"),
          evidence: fd.get("evidence"),
          links: {
            linkedin: fd.get("linkedin"),
            instagram: fd.get("instagram"),
            website: fd.get("website"),
          },
          turnstileToken: captcha.getToken(),
        }});
        render(
          notice("Claim received. A moderator will verify it and contact you by email."),
          el("a", { class: "btn", href: "#/" }, "Back to browse"),
        );
      } catch (err) {
        captcha.reset();
        status.replaceChildren(notice(err.message, true));
      }
    }},
    el("label", {}, "Your full name", el("input", { name: "claimantName", required: "" })),
    el("label", {}, "Your email",
      el("span", { class: "hint" }, "Used to verify the claim. Never published."),
      el("input", { name: "claimantEmail", type: "email", required: "" }),
    ),
    el("label", {}, "How can we verify this is you?",
      el("span", { class: "hint" }, "For example a company email address we can write to, or a profile you control that mentions your role."),
      el("textarea", { name: "evidence", required: "", minlength: "20", maxlength: "5000" }),
    ),
    el("label", {}, "LinkedIn profile", el("input", { name: "linkedin", type: "url", placeholder: "https://www.linkedin.com/in/…" })),
    el("label", {}, "Instagram profile", el("input", { name: "instagram", type: "url", placeholder: "https://www.instagram.com/…" })),
    el("label", {}, "Website", el("input", { name: "website", type: "url", placeholder: "https://…" })),
    captcha.element,
    el("button", { class: "primary", type: "submit" }, "Submit claim"),
    status,
  );
  render(
    el("h1", {}, "Claim this profile"),
    el("p", { class: "muted" }, "If this profile is about you, claiming it marks it as verified and lets readers see that you are engaging. Claiming does not remove or edit reviews — for that, use the response and dispute options."),
    form,
  );
}

function pageDispute(subjectType, subjectId) {
  const status = el("div");
  const captcha = captchaField();
  const form = el("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      const fd = new FormData(form);
      try {
        await api("/api/disputes", { method: "POST", body: {
          subjectType, subjectId,
          contactEmail: fd.get("contactEmail"),
          reason: fd.get("reason"),
          turnstileToken: captcha.getToken(),
        }});
        render(notice("Dispute received. A moderator will re-review the content and contact you."), el("a", { class: "btn", href: "#/" }, "Back"));
      } catch (err) {
        captcha.reset();
        status.replaceChildren(notice(err.message, true));
      }
    }},
    el("label", {}, "Contact email", el("input", { name: "contactEmail", type: "email", required: "" })),
    el("label", {}, "What is inaccurate or unfair, and why?",
      el("span", { class: "hint" }, "Content that cannot be substantiated against our guidelines is removed."),
      el("textarea", { name: "reason", required: "", minlength: "20", maxlength: "5000" }),
    ),
    captcha.element,
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
        adminSection("Pending profiles", queue.executives, (e) => {
          const links = Object.entries(e.links ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("  ");
          return `${e.name} — ${[e.role, e.company, e.region].filter(Boolean).join(", ") || "no details"}${links ? `\n${links}` : ""}`;
        }, "executive", headers),
        adminSection("Pending reviews", queue.reviews, (r) =>
          `${r.title} (${r.rating}★, ${CATEGORY_LABELS[r.category] ?? r.category}${r.location ? `, ${r.location}` : ""}) about ${r.executive?.name ?? "?"}\n${r.body}`,
          "review", headers),
        adminSection("Pending responses", queue.responses, (r) => `${r.responderName}: ${r.body}`, "response", headers),
        adminSection("Reported reviews", queue.reports ?? [], (r) =>
          `${REPORT_REASONS[r.reason] ?? r.reason} — on "${r.review?.title ?? "?"}"\n${r.detail || "(no detail given)"}${r.reporterEmail ? `\ncontact: ${r.reporterEmail}` : ""}`,
          "report", headers),
        adminSection("Profile claims", queue.claims ?? [], (c) =>
          `${c.claimantName} <${c.claimantEmail}> claims ${c.executive?.name ?? "?"}\n${c.evidence}`,
          "claim", headers),
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
  // Triage items are resolved/dismissed; content items are approved/rejected.
  const isTriage = ["dispute", "report", "claim"].includes(type);
  const actions = isTriage
    ? [["resolve", type === "claim" ? "Verify claim" : "Resolve"], ["dismiss", "Dismiss"]]
    : [["approve", "Approve"], ["reject", "Reject"]];
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
async function route() {
  // Cached after the first call; forms need it to decide whether to mount a captcha.
  await ensureConfig();
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, queryString] = hash.split("?");
  const params = new URLSearchParams(queryString ?? "");
  const parts = path.split("/").filter(Boolean);

  if (parts.length === 0) return pageBrowse();
  if (parts[0] === "exec" && parts[1]) return pageExecutive(parts[1]);
  if (parts[0] === "submit") return pageSubmit(params);
  if (parts[0] === "respond" && parts[1]) return pageRespond(parts[1]);
  if (parts[0] === "report" && parts[1]) return pageReport(parts[1]);
  if (parts[0] === "claim" && parts[1]) return pageClaim(parts[1]);
  if (parts[0] === "dispute" && parts[1] && parts[2]) return pageDispute(parts[1], parts[2]);
  // Static legal/policy pages live as <template> blocks in index.html.
  const staticPages = { guidelines: "tpl-guidelines", terms: "tpl-terms", privacy: "tpl-privacy" };
  if (staticPages[parts[0]]) {
    return render(document.getElementById(staticPages[parts[0]]).content.cloneNode(true));
  }
  if (parts[0] === "admin") return pageAdmin();
  return pageBrowse();
}

window.addEventListener("hashchange", () => route());
route();
