// Pure store logic shared by the Node server (fs persistence, see store.mjs)
// and the Cloudflare Worker (KV persistence, see deploy/cloudflare/worker.mjs).
// Operates on a plain db object; `persist` is called after every mutation.
// All user submissions start "pending" and only become publicly visible after
// moderator approval.

export const REVIEW_CATEGORIES = [
  "contract-terms",
  "royalty-payments",
  "advance-recoupment",
  "ownership-rights",
  "communication",
  "misrepresentation",
  "other",
];

export const CATEGORY_LABELS = {
  "contract-terms": "Contract terms",
  "royalty-payments": "Royalty payments",
  "advance-recoupment": "Advances & recoupment",
  "ownership-rights": "Ownership & rights",
  communication: "Communication & professionalism",
  misrepresentation: "Misrepresentation",
  other: "Other",
};

const MAX_TEXT = 5000;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

export function emptyDb() {
  return { executives: [], reviews: [], responses: [], disputes: [] };
}

function reqString(value, name, { min = 1, max = 300 } = {}) {
  if (typeof value !== "string") throw new ValidationError(`${name} is required`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new ValidationError(`${name} is too short`);
  if (trimmed.length > max) throw new ValidationError(`${name} is too long (max ${max} chars)`);
  return trimmed;
}

function optString(value, name, opts = {}) {
  if (value === undefined || value === null || value === "") return "";
  return reqString(value, name, { min: 0, ...opts });
}

function newId() {
  // Web Crypto so the same code runs on Node 22+ and Cloudflare Workers.
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createStoreCore(db, persist) {
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
    for (const r of reviews) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    return {
      id: executive.id,
      name: executive.name,
      role: executive.role,
      company: executive.company,
      region: executive.region,
      reviewCount: reviews.length,
      averageRating: avg === null ? null : Math.round(avg * 10) / 10,
      categories: byCategory,
    };
  }

  function submitExecutive({ name, role, company, region }) {
    const executive = {
      id: newId(),
      name: reqString(name, "name", { min: 2, max: 120 }),
      role: optString(role, "role", { max: 120 }),
      company: optString(company, "company", { max: 120 }),
      region: optString(region, "region", { max: 120 }),
      status: "pending",
      createdAt: now(),
    };
    db.executives.push(executive);
    persist();
    return executive;
  }

  function listExecutives({ q = "", includePending = false } = {}) {
    const query = q.trim().toLowerCase();
    return db.executives
      .filter((e) => includePending || e.status === "approved")
      .filter(
        (e) =>
          !query ||
          e.name.toLowerCase().includes(query) ||
          e.company.toLowerCase().includes(query) ||
          e.role.toLowerCase().includes(query),
      )
      .map(summarize)
      .sort((a, b) => b.reviewCount - a.reviewCount || a.name.localeCompare(b.name));
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
    const year = dealYear === undefined || dealYear === null || dealYear === "" ? null : Number(dealYear);
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
      reviewerName: optString(reviewerName, "reviewerName", { max: 80 }) || "Anonymous",
      firsthand: true,
      status: "pending",
      createdAt: now(),
    };
    db.reviews.push(review);
    persist();
    return review;
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
      contactEmail: reqString(contactEmail, "contactEmail", { min: 5, max: 200 }),
      reason: reqString(reason, "reason", { min: 20, max: MAX_TEXT }),
      status: "open",
      createdAt: now(),
    };
    db.disputes.push(dispute);
    persist();
    return dispute;
  }

  function moderationQueue() {
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
    };
  }

  function moderate({ type, id, action, note }) {
    const collections = {
      executive: db.executives,
      review: db.reviews,
      response: db.responses,
    };
    if (type === "dispute") {
      const dispute = db.disputes.find((d) => d.id === id);
      if (!dispute) throw new ValidationError("Unknown dispute");
      if (!["resolve", "dismiss"].includes(action))
        throw new ValidationError("dispute action must be 'resolve' or 'dismiss'");
      dispute.status = action === "resolve" ? "resolved" : "dismissed";
      dispute.moderatorNote = optString(note, "note", { max: MAX_TEXT });
      dispute.moderatedAt = now();
      persist();
      return dispute;
    }
    const collection = collections[type];
    if (!collection) throw new ValidationError("type must be executive, review, response, or dispute");
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

  return {
    submitExecutive,
    listExecutives,
    getExecutive,
    submitReview,
    submitResponse,
    submitDispute,
    moderationQueue,
    moderate,
    ValidationError,
  };
}
