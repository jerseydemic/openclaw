// Run with: node --test  (uses node:test; not part of the repo's vitest suites)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createStore } from "./store.mjs";

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mer-test-"));
  return createStore(dir);
}

test("submissions stay hidden until approved", () => {
  const store = freshStore();
  const executive = store.submitExecutive({ name: "Test Person", company: "Test Co" });
  assert.equal(store.listExecutives().length, 0);
  assert.equal(store.getExecutive(executive.id), null);

  store.moderate({ type: "executive", id: executive.id, action: "approve" });
  assert.equal(store.listExecutives().length, 1);

  const review = store.submitReview({
    executiveId: executive.id,
    rating: 2,
    category: "contract-terms",
    title: "Bad terms",
    body: "x".repeat(40),
    firsthand: true,
  });
  assert.equal(store.getExecutive(executive.id).reviews.length, 0);
  store.moderate({ type: "review", id: review.id, action: "approve" });
  const loaded = store.getExecutive(executive.id);
  assert.equal(loaded.reviews.length, 1);
  assert.equal(loaded.averageRating, 2);
});

test("review validation enforces rating, category, and firsthand attestation", () => {
  const store = freshStore();
  const executive = store.submitExecutive({ name: "Test Person" });
  const base = {
    executiveId: executive.id,
    rating: 3,
    category: "other",
    title: "A title",
    body: "y".repeat(40),
    firsthand: true,
  };
  assert.throws(() => store.submitReview({ ...base, rating: 6 }), /rating/);
  assert.throws(() => store.submitReview({ ...base, rating: 2.5 }), /rating/);
  assert.throws(() => store.submitReview({ ...base, category: "libel" }), /category/);
  assert.throws(() => store.submitReview({ ...base, firsthand: false }), /first-hand/);
  assert.throws(() => store.submitReview({ ...base, body: "too short" }), /body/);
  assert.throws(() => store.submitReview({ ...base, dealYear: 1800 }), /dealYear/);
  assert.throws(() => store.submitReview({ ...base, executiveId: "nope" }), /Unknown executive/);
});

test("rejected reviews never surface and average uses approved only", () => {
  const store = freshStore();
  const executive = store.submitExecutive({ name: "Avg Person" });
  store.moderate({ type: "executive", id: executive.id, action: "approve" });
  const mk = (rating) =>
    store.submitReview({
      executiveId: executive.id,
      rating,
      category: "other",
      title: "Title here",
      body: "z".repeat(40),
      firsthand: true,
    });
  const a = mk(5);
  const b = mk(1);
  const c = mk(1);
  store.moderate({ type: "review", id: a.id, action: "approve" });
  store.moderate({ type: "review", id: b.id, action: "approve" });
  store.moderate({ type: "review", id: c.id, action: "reject", note: "second-hand account" });
  const loaded = store.getExecutive(executive.id);
  assert.equal(loaded.reviews.length, 2);
  assert.equal(loaded.averageRating, 3);
});

test("responses attach to reviews after approval (right of reply)", () => {
  const store = freshStore();
  const executive = store.submitExecutive({ name: "Reply Person" });
  store.moderate({ type: "executive", id: executive.id, action: "approve" });
  const review = store.submitReview({
    executiveId: executive.id,
    rating: 1,
    category: "royalty-payments",
    title: "No statements",
    body: "w".repeat(40),
    firsthand: true,
  });
  store.moderate({ type: "review", id: review.id, action: "approve" });
  const response = store.submitResponse({
    reviewId: review.id,
    responderName: "Reply Person",
    responderRole: "the executive named",
    body: "Statements were sent to the address on file; happy to re-send.",
  });
  assert.equal(store.getExecutive(executive.id).reviews[0].responses.length, 0);
  store.moderate({ type: "response", id: response.id, action: "approve" });
  assert.equal(store.getExecutive(executive.id).reviews[0].responses.length, 1);
});

test("disputes are recorded and resolvable", () => {
  const store = freshStore();
  const executive = store.submitExecutive({ name: "Disputed Person" });
  const dispute = store.submitDispute({
    subjectType: "executive",
    subjectId: executive.id,
    contactEmail: "person@example.com",
    reason: "This profile is about me and the company listed is wrong.",
  });
  assert.equal(store.moderationQueue().disputes.length, 1);
  store.moderate({ type: "dispute", id: dispute.id, action: "resolve", note: "fixed company" });
  assert.equal(store.moderationQueue().disputes.length, 0);
  assert.throws(() => store.submitDispute({ subjectType: "album", subjectId: "x", contactEmail: "a@b.co", reason: "r".repeat(30) }), /subjectType/);
});

test("submitReviewBundle creates profile and review atomically", () => {
  const store = freshStore();
  const review = store.submitReviewBundle({
    newExecutive: { name: "Bundled Person", company: "Bundle Co" },
    rating: 3,
    category: "other",
    title: "Bundled title",
    body: "b".repeat(40),
    firsthand: true,
  });
  const queue = store.moderationQueue();
  assert.equal(queue.executives.length, 1);
  assert.equal(queue.reviews.length, 1);
  assert.equal(queue.reviews[0].id, review.id);
  assert.equal(queue.reviews[0].executive.name, "Bundled Person");
});

test("submitReviewBundle rolls back the profile when the review is invalid", () => {
  const store = freshStore();
  assert.throws(
    () =>
      store.submitReviewBundle({
        newExecutive: { name: "Orphan Person" },
        rating: 9, // invalid
        category: "other",
        title: "Title",
        body: "c".repeat(40),
        firsthand: true,
      }),
    /rating/,
  );
  // No orphaned profile left behind in the moderation queue.
  assert.equal(store.moderationQueue().executives.length, 0);

  assert.throws(
    () =>
      store.submitReviewBundle({
        rating: 3,
        category: "other",
        title: "Title",
        body: "d".repeat(40),
        firsthand: true,
      }),
    /Select an existing profile/,
  );
});

test("submitReviewBundle uses an existing profile when given an id", () => {
  const store = freshStore();
  const executive = store.submitExecutive({ name: "Existing Person" });
  store.moderate({ type: "executive", id: executive.id, action: "approve" });
  const review = store.submitReviewBundle({
    executiveId: executive.id,
    rating: 4,
    category: "other",
    title: "Existing title",
    body: "e".repeat(40),
    firsthand: true,
  });
  assert.equal(review.executiveId, executive.id);
  assert.equal(store.moderationQueue().executives.length, 0);
});

test("search matches name, company, and role", () => {
  const store = freshStore();
  const a = store.submitExecutive({ name: "Alpha One", company: "Beta Records", role: "Manager" });
  store.moderate({ type: "executive", id: a.id, action: "approve" });
  assert.equal(store.listExecutives({ q: "alpha" }).length, 1);
  assert.equal(store.listExecutives({ q: "beta" }).length, 1);
  assert.equal(store.listExecutives({ q: "manager" }).length, 1);
  assert.equal(store.listExecutives({ q: "zzz" }).length, 0);
});
