// Pure store logic shared by the Node server (fs persistence, see store.mjs)
// and the Cloudflare Worker (KV persistence, see deploy/cloudflare/worker.mjs).
// Operates on a plain db object; `persist` is called after every mutation.
// All user submissions start "pending" and only become publicly visible after
// moderator approval.
import {
  MAX_TEXT,
  ValidationError,
  newId,
  optString,
  optUrl,
  reqEmail,
  reqString,
} from "./validators.mjs";

export { ValidationError } from "./validators.mjs";

export const REVIEW_CATEGORIES = [
  "contract-terms",
  "royalty-payments",
  "advance-recoupment",
  "ownership-rights",
  "publishing-splits",
  "unpaid-fees",
  "tour-live-deals",
  "communication",
  "misrepresentation",
  "other",
];

export const CATEGORY_LABELS = {
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

// Only these hosts may appear in a profile's link fields.
const LINK_HOSTS = {
  linkedin: ["linkedin.com"],
  instagram: ["instagram.com"],
  website: null, // any https URL
};

export function emptyDb() {
  return { executives: [], reviews: [], responses: [], disputes: [], reports: [], claims: [] };
}

// Older stored databases predate the reports/claims collections.
function normalizeDb(db) {
  for (const key of ["executives", "reviews", "responses", "disputes", "reports", "claims"]) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  return db;
}

function parseLinks(input, name = "links") {
  if (!input || typeof input !== "object") return { linkedin: "", instagram: "", website: "" };
  return {
    linkedin: optUrl(input.linkedin, "LinkedIn URL", { allowedHosts: LINK_HOSTS.linkedin }),
    instagram: optUrl(input.instagram, "Instagram URL", { allowedHosts: LINK_HOSTS.instagram }),
    website: optUrl(input.website, "Website URL"),
  };
}

export function createStoreCore(rawDb, persist) {
  const db = normalizeDb(rawDb);
  const now = () => new Date().toISOString();

  function approvedReviewsFor(executiveId) {
    return db.reviews.filter((r) => r.executiveId === executiveId && r.status === "approved");
  }

  function summarize(executive) {
    const reviews = approvedReviewsFor(executive.id);
    const avg = reviews.length
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : null;
    const byCategory = {};
    const locations = new Set();
    for (const r of reviews) {
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
      if (r.location) locations.add(r.location);
    }
    return {
      id: executive.id,
      name: executive.name,
      role: executive.role,
      company: executive.company,
      region: executive.region,
      links: executive.links ?? { linkedin: "", instagram: "", website: "" },
      claimed: Boolean(executive.claimed),
      reviewCount: reviews.length,
      averageRating: avg === null ? null : Math.round(avg * 10) / 10,
      categories: byCategory,
      // Where the reported dealings took place, aggregated from the reviews.
      locations: [...locations],
    };
  }

  function submitExecutive({ name, role, company, region, links }) {
    const executive = {
      id: newId(),
      name: reqString(name, "name", { min: 2, max: 120 }),
      role: optString(role, "role", { max: 120 }),
      company: optString(company, "company", { max: 120 }),
      region: optString(region, "region", { max: 120 }),
      links: parseLinks(links),
      claimed: false,
      status: "pending",
      createdAt: now(),
    };
    db.executives.push(executive);
    persist();
    return executive;
  }

  /**
   * Public listing with filters. `q` matches name/company/role, `location`
   * matches the profile region or any review location, `category` and
   * `minRating` narrow by review content.
   */
  function listExecutives({
    q = "",
    category = "",
    location = "",
    minRating = 0,
    maxRating = 5,
    sort = "reviews",
    includePending = false,
  } = {}) {
    const query = q.trim().toLowerCase();
    const place = location.trim().toLowerCase();
    const min = Number(minRating) || 0;
    const max = Number(maxRating) || 5;

    let rows = db.executives
      .filter((e) => includePending || e.status === "approved")
      .map(summarize)
      .filter(
        (e) =>
          !query ||
          e.name.toLowerCase().includes(query) ||
          e.company.toLowerCase().includes(query) ||
          e.role.toLowerCase().includes(query),
      )
      .filter(
        (e) =>
          !place ||
          e.region.toLowerCase().includes(place) ||
          e.locations.some((loc) => loc.toLowerCase().includes(place)),
      )
      .filter((e) => !category || (e.categories[category] ?? 0) > 0)
      .filter((e) => e.averageRating === null || (e.averageRating >= min && e.averageRating <= max));

    const sorters = {
      reviews: (a, b) => b.reviewCount - a.reviewCount || a.name.localeCompare(b.name),
      worst: (a, b) => (a.averageRating ?? 99) - (b.averageRating ?? 99),
      best: (a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    rows.sort(sorters[sort] ?? sorters.reviews);
    return rows;
  }

  function getExecutive(id) {
    const executive = db.executives.find((e) => e.id === id && e.status === "approved");
    if (!executive) return null;
    const reviews = approvedReviewsFor(id)
      .map((r) => ({
        ...r,
        responses: db.responses.filter(
          (resp) => resp.reviewId === r.id && resp.status === "approved",
        ),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { ...summarize(executive), reviews };
  }

  function submitReview({
    executiveId,
    rating,
    category,
    title,
    body,
    dealYear,
    location,
    reviewerName,
    firsthand,
  }) {
    const executive = db.executives.find((e) => e.id === executiveId);
    if (!executive) throw new ValidationError("Unknown executive");
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      throw new ValidationError("rating must be an integer from 1 to 5");
    if (!REVIEW_CATEGORIES.includes(category))
      throw new ValidationError("category is not one of the allowed values");
    if (firsthand !== true)
      throw new ValidationError(
        "You must confirm this review describes your own first-hand experience",
      );
    const year =
      dealYear === undefined || dealYear === null || dealYear === "" ? null : Number(dealYear);
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear()))
      throw new ValidationError("dealYear must be a plausible year");
    const review = {
      id: newId(),
      executiveId,
      rating,
      category,
      title: reqString(title, "title", { min: 3, max: 160 }),
      body: reqString(body, "body", { min: 30, max: MAX_TEXT }),
      dealYear: year,
      // Free text so it works worldwide, e.g. "Atlanta, GA, USA" or "London, UK".
      location: optString(location, "location", { max: 120 }),
      reviewerName: optString(reviewerName, "reviewerName", { max: 80 }) || "Anonymous",
      firsthand: true,
      status: "pending",
      createdAt: now(),
    };
    db.reviews.push(review);
    persist();
    return review;
  }

  /**
   * Submit a review, optionally creating the executive profile in the same
   * call. One request keeps it atomic and means a single captcha token covers
   * the whole submission. Rolls the new profile back if the review is invalid,
   * so a rejected submission never leaves an orphan profile in the queue.
   */
  function submitReviewBundle({ executiveId, newExecutive, ...review }) {
    if (executiveId) return submitReview({ ...review, executiveId });
    if (!newExecutive || typeof newExecutive !== "object")
      throw new ValidationError("Select an existing profile or provide details for a new one");
    const created = submitExecutive(newExecutive);
    try {
      return submitReview({ ...review, executiveId: created.id });
    } catch (err) {
      const index = db.executives.findIndex((e) => e.id === created.id);
      if (index !== -1) db.executives.splice(index, 1);
      persist();
      throw err;
    }
  }

  function submitResponse({ reviewId, responderName, responderRole, body }) {
    const review = db.reviews.find((r) => r.id === reviewId);
    if (!review) throw new ValidationError("Unknown review");
    const response = {
      id: newId(),
      reviewId,
      responderName: reqString(responderName, "responderName", { min: 2, max: 120 }),
      responderRole: optString(responderRole, "responderRole", { max: 120 }),
      body: reqString(body, "body", { min: 10, max: MAX_TEXT }),
      status: "pending",
      createdAt: now(),
    };
    db.responses.push(response);
    persist();
    return response;
  }

  function submitDispute({ subjectType, subjectId, contactEmail, reason }) {
    if (!["executive", "review"].includes(subjectType))
      throw new ValidationError("subjectType must be 'executive' or 'review'");
    const exists =
      subjectType === "executive"
        ? db.executives.some((e) => e.id === subjectId)
        : db.reviews.some((r) => r.id === subjectId);
    if (!exists) throw new ValidationError(`Unknown ${subjectType}`);
    const dispute = {
      id: newId(),
      subjectType,
      subjectId,
      contactEmail: reqEmail(contactEmail, "contactEmail"),
      reason: reqString(reason, "reason", { min: 20, max: MAX_TEXT }),
      status: "open",
      createdAt: now(),
    };
    db.disputes.push(dispute);
    persist();
    return dispute;
  }

  const REPORT_REASONS = ["false", "harassment", "private-info", "spam", "not-firsthand", "other"];

  /** Public "flag this" on an already-published review. */
  function submitReport({ reviewId, reason, detail, reporterEmail }) {
    const review = db.reviews.find((r) => r.id === reviewId);
    if (!review) throw new ValidationError("Unknown review");
    if (!REPORT_REASONS.includes(reason))
      throw new ValidationError("reason is not one of the allowed values");
    const report = {
      id: newId(),
      reviewId,
      reason,
      detail: optString(detail, "detail", { max: MAX_TEXT }),
      reporterEmail: reporterEmail ? reqEmail(reporterEmail, "reporterEmail") : "",
      status: "open",
      createdAt: now(),
    };
    db.reports.push(report);
    persist();
    return report;
  }

  /** Request to claim a profile as its subject; a moderator verifies offline. */
  function submitClaim({ executiveId, claimantName, claimantEmail, evidence, links }) {
    const executive = db.executives.find((e) => e.id === executiveId);
    if (!executive) throw new ValidationError("Unknown executive");
    const claim = {
      id: newId(),
      executiveId,
      claimantName: reqString(claimantName, "claimantName", { min: 2, max: 120 }),
      claimantEmail: reqEmail(claimantEmail, "claimantEmail"),
      evidence: reqString(evidence, "evidence", { min: 20, max: MAX_TEXT }),
      links: parseLinks(links),
      status: "open",
      createdAt: now(),
    };
    db.claims.push(claim);
    persist();
    return claim;
  }

  function moderationQueue() {
    const withReview = (item) => ({
      ...item,
      review: db.reviews.find((r) => r.id === item.reviewId) ?? null,
    });
    return {
      executives: db.executives.filter((e) => e.status === "pending"),
      reviews: db.reviews
        .filter((r) => r.status === "pending")
        .map((r) => ({
          ...r,
          executive: db.executives.find((e) => e.id === r.executiveId) ?? null,
        })),
      responses: db.responses.filter((r) => r.status === "pending"),
      disputes: db.disputes.filter((d) => d.status === "open"),
      reports: db.reports.filter((r) => r.status === "open").map(withReview),
      claims: db.claims
        .filter((c) => c.status === "open")
        .map((c) => ({
          ...c,
          executive: db.executives.find((e) => e.id === c.executiveId) ?? null,
        })),
    };
  }

  function moderate({ type, id, action, note }) {
    const collections = {
      executive: db.executives,
      review: db.reviews,
      response: db.responses,
    };
    // Triage collections use resolve/dismiss rather than approve/reject.
    const triage = { dispute: db.disputes, report: db.reports, claim: db.claims };
    if (triage[type]) {
      const item = triage[type].find((entry) => entry.id === id);
      if (!item) throw new ValidationError(`Unknown ${type}`);
      if (!["resolve", "dismiss"].includes(action))
        throw new ValidationError(`${type} action must be 'resolve' or 'dismiss'`);
      item.status = action === "resolve" ? "resolved" : "dismissed";
      item.moderatorNote = optString(note, "note", { max: MAX_TEXT });
      item.moderatedAt = now();
      // An approved claim marks the profile as verified to its subject.
      if (type === "claim" && action === "resolve") {
        const executive = db.executives.find((e) => e.id === item.executiveId);
        if (executive) {
          executive.claimed = true;
          // Adopt any links the claimant supplied and a moderator accepted.
          for (const key of ["linkedin", "instagram", "website"]) {
            if (item.links?.[key]) executive.links = { ...executive.links, [key]: item.links[key] };
          }
        }
      }
      persist();
      return item;
    }
    const collection = collections[type];
    if (!collection)
      throw new ValidationError("type must be executive, review, response, dispute, report, or claim");
    if (!["approve", "reject"].includes(action))
      throw new ValidationError("action must be 'approve' or 'reject'");
    const item = collection.find((entry) => entry.id === id);
    if (!item) throw new ValidationError(`Unknown ${type}`);
    item.status = action === "approve" ? "approved" : "rejected";
    item.moderatorNote = optString(note, "note", { max: MAX_TEXT });
    item.moderatedAt = now();
    persist();
    return item;
  }

  /** Moderator-only: attach or correct a profile's links. */
  function updateExecutiveLinks({ executiveId, links }) {
    const executive = db.executives.find((e) => e.id === executiveId);
    if (!executive) throw new ValidationError("Unknown executive");
    executive.links = parseLinks(links);
    persist();
    return executive;
  }

  return {
    submitExecutive,
    listExecutives,
    getExecutive,
    submitReview,
    submitReviewBundle,
    submitResponse,
    submitDispute,
    submitReport,
    submitClaim,
    updateExecutiveLinks,
    moderationQueue,
    moderate,
    REPORT_REASONS,
    ValidationError,
  };
}
