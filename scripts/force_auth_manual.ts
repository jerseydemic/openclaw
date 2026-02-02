
import { loginGeminiCliOAuth } from "../extensions/google-gemini-cli-auth/oauth.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const mockContext = {
    isRemote: false,
    openUrl: async (url: string) => {
        console.log("\nPlease open this URL in your browser to authenticate:\n");
        console.log(url);
        console.log("\nAfter authenticating, you will remain on a local page. This script should automatically detect the completion if port 8085 is available.");
        console.log("If the automatic flow fails, check the console for a prompt to paste the redirect URL.\n");
    },
    log: (msg: string) => console.log("[AUTH] " + msg),
    note: async (msg: string) => console.log("[NOTE] " + msg),
    prompt: async (msg: string) => {
        // Simple distinct prompt handler for stdin if needed
        process.stdout.write(msg);
        const stdin = process.stdin;
        stdin.resume();
        return new Promise<string>(resolve => {
            stdin.once('data', data => {
                resolve(data.toString().trim());
            });
        });
    },
    progress: {
        update: (msg: string) => console.log("[PROGRESS] " + msg),
        stop: (msg?: string) => console.log("[DONE] " + (msg || "")),
    }
};

async function run() {
    console.log("Starting forced auth...");

    // 1. Try to load client_secret.json
    const secretPath = path.join(process.cwd(), "client_secret.json");
    if (fs.existsSync(secretPath)) {
        console.log(`Found client_secret.json at ${secretPath}`);
        try {
            const secretContent = JSON.parse(fs.readFileSync(secretPath, "utf8"));
            const data = secretContent.installed || secretContent.web;
            if (data && data.client_id && data.client_secret) {
                console.log("Setting environment variables from client_secret.json...");
                process.env.CLAWDBOT_GEMINI_OAUTH_CLIENT_ID = data.client_id;
                process.env.CLAWDBOT_GEMINI_OAUTH_CLIENT_SECRET = data.client_secret;
            } else {
                console.warn("Invalid client_secret.json format. Expected 'installed' or 'web' property with client_id/client_secret.");
            }
        } catch (e) {
            console.error("Failed to parse client_secret.json:", e);
        }
    } else {
        console.log("No client_secret.json found in current directory. Using default/environment credentials if available.");
    }

    try {
        const creds = await loginGeminiCliOAuth(mockContext);
        console.log("\nAuthentication Successful!");

        // 2. Save credentials to auth-profiles.json
        const home = os.homedir();
        // Path matches the default agent location
        const profileDir = path.join(home, ".clawdbot", "agents", "main", "agent");
        const profilePath = path.join(profileDir, "auth-profiles.json");

        console.log(`Saving credentials to ${profilePath}...`);

        if (!fs.existsSync(profileDir)) {
            console.log(`Creating directory structure: ${profileDir}`);
            fs.mkdirSync(profileDir, { recursive: true });
        }

        let profiles: Record<string, any> = {};
        if (fs.existsSync(profilePath)) {
            try {
                profiles = JSON.parse(fs.readFileSync(profilePath, "utf8"));
            } catch (e) {
                console.warn("Failed to parse existing auth-profiles.json, starting fresh.");
            }
        }

        // The key format typically used by the extension
        // We act as 'google-gemini-cli' provider.
        // We use the email as the account identifier if available, or 'default'.
        const accountId = creds.email || "default";
        const profileKey = `google-gemini-cli:${accountId}`;

        profiles[profileKey] = {
            type: "oauth",
            provider: "google-gemini-cli",
            data: creds
        };

        // Also save as default/current if it's the only one or requested?
        // For now, saving specifically under the email key is the safest bet for the extension to find it 
        // if it iterates or looks for a specific one.
        // However, the extension might look for ANY profile with provider "google-gemini-cli".

        fs.writeFileSync(profilePath, JSON.stringify(profiles, null, 2));
        console.log(`Profile saved for ${profileKey}.`);
        console.log("You can now restart Henry/Clawdbot to pick up these credentials.");

        process.exit(0);

    } catch (err) {
        console.error("Authentication failed:", err);
        process.exit(1);
    }
}

run();
