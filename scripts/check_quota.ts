
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function checkQuota() {
    const home = os.homedir();
    const profilePath = path.join(home, ".clawdbot", "agents", "main", "agent", "auth-profiles.json");

    if (!fs.existsSync(profilePath)) {
        console.error("Auth profile not found at " + profilePath);
        process.exit(1);
    }

    const profiles = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    // Look for the google-gemini-cli profile. It could be under various keys.
    // The one we saved was "google-gemini-cli:urbanbackground@gmail.com"

    let token = "";
    for (const key in profiles) {
        if (key.startsWith("google-gemini-cli") && profiles[key].data?.access) {
            token = profiles[key].data.access;
            console.log("Found token for " + key);
            break;
        }
    }

    if (!token) {
        console.error("No access token found in profiles.");
        process.exit(1);
    }

    console.log("Fetching quota...");
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: "{}",
    });

    if (!res.ok) {
        console.error(`Error fetching quota: ${res.status} ${res.statusText}`);
        const text = await res.text();
        console.error(text);
        process.exit(1);
    }

    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));

    // Parse meaningful info like in the original file
    const buckets = data.buckets || [];
    console.log("\n--- Quota Summary ---");
    if (buckets.length === 0) {
        console.log("No specific quota buckets returned (Unimited/Default?)");
    }
    for (const bucket of buckets) {
        console.log(`Model: ${bucket.modelId || 'Unknown'}`);
        console.log(`Remaining Fraction: ${bucket.remainingFraction}`);
        console.log(`(Used: ${((1 - (bucket.remainingFraction ?? 1)) * 100).toFixed(1)}%)`);
        console.log("---");
    }
}

checkQuota();
