// Seeds the local database with clearly-fictional demo data so the UI has
// something to show during development. Never run against production data.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = createStore(process.env.DATA_DIR || path.join(here, "data"));

const demo = [
  {
    executive: { name: "Jordan Placeholder (Demo)", role: "A&R Executive", company: "Example Records", region: "Demo City" },
    reviews: [
      {
        rating: 1,
        category: "royalty-payments",
        title: "Two years of streaming revenue, zero statements",
        body: "Demo data: signed a single deal in 2023. Contract promised quarterly royalty statements; I received none for two years despite repeated written requests. Only after involving a lawyer did statements appear, showing unrecouped 'marketing costs' never itemized.",
        dealYear: 2023,
        reviewerName: "Demo Artist A",
      },
      {
        rating: 2,
        category: "contract-terms",
        title: "Perpetual rights buried in the appendix",
        body: "Demo data: the draft presented in the meeting differed from the signature copy — the appendix assigned master ownership in perpetuity rather than the 7-year term we discussed. Caught it before signing thanks to independent counsel.",
        dealYear: 2024,
        reviewerName: "Anonymous",
      },
    ],
  },
  {
    executive: { name: "Avery Sample (Demo)", role: "Artist Manager", company: "Placeholder Management", region: "Demo City" },
    reviews: [
      {
        rating: 5,
        category: "communication",
        title: "Transparent from day one",
        body: "Demo data: clear commission structure, every expense documented, encouraged me to have the contract reviewed by my own lawyer before signing. This is what good looks like — the platform is for positive experiences too.",
        dealYear: 2025,
        reviewerName: "Demo Artist B",
      },
    ],
  },
];

for (const { executive, reviews } of demo) {
  const created = store.submitExecutive(executive);
  store.moderate({ type: "executive", id: created.id, action: "approve", note: "seed" });
  for (const review of reviews) {
    const submitted = store.submitReview({ ...review, executiveId: created.id, firsthand: true });
    store.moderate({ type: "review", id: submitted.id, action: "approve", note: "seed" });
  }
  console.log(`Seeded ${executive.name} with ${reviews.length} review(s)`);
}
console.log("Done. Start the server with: node server.mjs");
