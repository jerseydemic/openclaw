import { GoogleAuth } from "google-auth-library";

// This script instruments a minimal Cloud Code Assist request
// to see exactly what payload triggers the 400 error.

const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

async function testCloudCodeAssist() {
    const client = await auth.getClient();
    const projectId = await auth.getProjectId();

    const url = `https://cloudcodeassist.googleapis.com/v1/projects/${projectId}/locations/us-central1/models/cloudcodeassist:generateCode`;

    // Minimal payload - just a single user message
    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: "hello" }],
            },
        ],
        generationConfig: {
            // Try without any generation config first
        },
    };

    console.log("=== REQUEST PAYLOAD ===");
    console.log(JSON.stringify(payload, null, 2));
    console.log("======================\n");

    try {
        const response = await client.request({
            url,
            method: "POST",
            data: payload,
        });
        console.log("✅ SUCCESS:", response.data);
    } catch (error: any) {
        console.log("❌ FAILURE");
        console.log("Status:", error?.response?.status);
        console.log("Error:", error?.response?.data.error || error.message);
    }
}

testCloudCodeAssist().catch(console.error);
