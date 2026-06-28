import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import readline from "node:readline/promises";
import process from "node:process";

const isWindows = process.platform === "win32";
const webAppName = "Live Event Poll Web";
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(text);
  }
}

function firebase(args) {
  const firebaseArgs = ["--yes", "firebase-tools", "--json", "--non-interactive", ...args];
  const command = isWindows ? "cmd.exe" : "npx";
  const commandArgs = isWindows ? ["/d", "/s", "/c", "npx", ...firebaseArgs] : firebaseArgs;
  try {
    const output = execFileSync(command, commandArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const payload = parseJsonOutput(output);
    if (payload.status === "error") throw new Error(payload.error);
    return payload.result ?? payload;
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    const stderr = error.stderr ? String(error.stderr) : "";
    const combined = `${stdout}\n${stderr}`.trim();
    if (combined) {
      try {
        const payload = parseJsonOutput(combined);
        throw new Error(payload.error || combined);
      } catch (parseError) {
        if (parseError.message !== combined) throw parseError;
      }
    }
    throw new Error(error.message || combined || "Firebase CLI command failed");
  }
}

function arrayFrom(value, keys) {
  const result = value?.result ?? value;
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(result[key])) return result[key];
  }
  return [];
}

function projectId(project) {
  return project.projectId || project.project_id || project.id || project.name;
}

function appId(app) {
  return app.appId || app.app_id || app.appID || app.id;
}

function appName(app) {
  return app.displayName || app.name || app.nickname || "Firebase Web App";
}

async function choose(label, items, describe, envValue) {
  if (envValue) {
    const match = items.find((item) => describe(item).includes(envValue));
    if (match) return match;
    throw new Error(`${label} "${envValue}" was not found.`);
  }

  if (items.length === 1) return items[0];

  console.log(`\nChoose ${label}:`);
  items.forEach((item, index) => {
    console.log(`${index + 1}. ${describe(item)}`);
  });

  const answer = await rl.question("> ");
  const index = Number(answer.trim()) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new Error(`Invalid ${label} selection.`);
  }
  return items[index];
}

function extractSdkConfig(value) {
  if (!value) return null;
  if (value.apiKey) return value;
  if (value.firebaseConfig?.apiKey) return value.firebaseConfig;
  if (value.config?.apiKey) return value.config;
  if (value.sdkConfig?.apiKey) return value.sdkConfig;

  const candidates = [value.fileContents, value.sdkConfig, value.config, value].filter(
    (candidate) => typeof candidate === "string"
  );

  for (const candidate of candidates) {
    const match =
      candidate.match(/firebaseConfig\s*=\s*({[\s\S]*?});?/) ||
      candidate.match(/({[\s\S]*})/);
    if (!match) continue;
    try {
      return Function(`"use strict"; return (${match[1]});`)();
    } catch {
      continue;
    }
  }

  return null;
}

function instanceName(instance) {
  const raw =
    instance.name ||
    instance.instance ||
    instance.instanceName ||
    instance.databaseInstance ||
    instance.databaseName ||
    "";
  return String(raw).split("/").filter(Boolean).at(-1);
}

function instanceUrl(instance) {
  const direct =
    instance.databaseURL ||
    instance.databaseUrl ||
    instance.url ||
    instance.endpoint ||
    instance.host;
  if (direct) return String(direct).startsWith("http") ? String(direct) : `https://${direct}`;

  const name = instanceName(instance);
  if (!name) return "";
  const location = String(instance.location || instance.locationId || instance.region || "");
  if (location && location !== "us-central1") {
    return `https://${name}.${location}.firebasedatabase.app`;
  }
  return `https://${name}.firebaseio.com`;
}

async function listProjects() {
  const result = firebase(["projects:list"]);
  return arrayFrom(result, ["projects"]);
}

async function listWebApps(project) {
  const result = firebase(["-P", project, "apps:list", "WEB"]);
  return arrayFrom(result, ["apps"]);
}

async function listDatabaseInstances(project) {
  const result = firebase(["-P", project, "database:instances:list"]);
  return arrayFrom(result, ["instances", "databases"]).filter((instance) => instanceName(instance) || instanceUrl(instance));
}

async function ensureWebApp(project) {
  let apps = await listWebApps(project);
  if (!apps.length) {
    const answer = await rl.question(`No Firebase Web app found. Create "${webAppName}" now? [Y/n] `);
    if (answer.trim().toLowerCase().startsWith("n")) {
      throw new Error("Create a Firebase Web app, then run this command again.");
    }
    firebase(["-P", project, "apps:create", "WEB", webAppName]);
    apps = await listWebApps(project);
  }

  return choose(
    "Firebase Web app",
    apps,
    (app) => `${appName(app)} (${appId(app)})`,
    process.env.FIREBASE_APP_ID
  );
}

async function ensureDatabaseUrl(project) {
  let instances = await listDatabaseInstances(project);
  if (!instances.length) {
    const defaultName = `${project}-default-rtdb`;
    const answer = await rl.question(
      `No Realtime Database instance found. Create "${defaultName}" in us-central1 now? [Y/n] `
    );
    if (answer.trim().toLowerCase().startsWith("n")) {
      throw new Error("Create a Realtime Database, then run this command again.");
    }
    firebase(["-P", project, "database:instances:create", defaultName, "--location", "us-central1"]);
    instances = await listDatabaseInstances(project);
    if (!instances.length) {
      return `https://${defaultName}.firebaseio.com`;
    }
  }

  const instance = await choose(
    "Realtime Database",
    instances,
    (item) => `${instanceName(item)} (${instanceUrl(item)})`,
    process.env.FIREBASE_DATABASE_NAME
  );
  return instanceUrl(instance);
}

function envLine(key, value) {
  return `${key}=${String(value || "").trim()}`;
}

async function main() {
  console.log("Fetching Firebase projects...");
  const projects = await listProjects();
  if (!projects.length) {
    throw new Error("No Firebase projects found for this account.");
  }

  const project = await choose(
    "Firebase project",
    projects,
    (item) => `${item.displayName || item.name || projectId(item)} (${projectId(item)})`,
    process.env.FIREBASE_PROJECT_ID
  );
  const selectedProjectId = projectId(project);

  const webApp = await ensureWebApp(selectedProjectId);
  const selectedAppId = appId(webApp);

  console.log("Fetching Firebase Web SDK config...");
  const sdkResult = firebase(["-P", selectedProjectId, "apps:sdkconfig", "WEB", selectedAppId]);
  const config = extractSdkConfig(sdkResult);
  if (!config?.apiKey) {
    throw new Error("Could not read Firebase Web SDK config.");
  }

  if (!config.databaseURL) {
    console.log("Finding Realtime Database URL...");
    config.databaseURL = await ensureDatabaseUrl(selectedProjectId);
  }

  const required = ["apiKey", "authDomain", "databaseURL", "projectId", "appId"];
  const missing = required.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`Firebase config is missing: ${missing.join(", ")}`);
  }

  const env = [
    envLine("VITE_FIREBASE_API_KEY", config.apiKey),
    envLine("VITE_FIREBASE_AUTH_DOMAIN", config.authDomain),
    envLine("VITE_FIREBASE_DATABASE_URL", config.databaseURL),
    envLine("VITE_FIREBASE_PROJECT_ID", config.projectId || selectedProjectId),
    envLine("VITE_FIREBASE_STORAGE_BUCKET", config.storageBucket),
    envLine("VITE_FIREBASE_MESSAGING_SENDER_ID", config.messagingSenderId),
    envLine("VITE_FIREBASE_APP_ID", config.appId)
  ].join("\n");

  if (existsSync(".env.local")) {
    const answer = await rl.question(".env.local already exists. Overwrite it? [y/N] ");
    if (!answer.trim().toLowerCase().startsWith("y")) {
      console.log("Canceled. .env.local was not changed.");
      return;
    }
  }

  writeFileSync(".env.local", `${env}\n`, "utf8");
  console.log(`\nWrote .env.local for ${selectedProjectId}.`);
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    console.error("\nRun `npm run firebase:login` first, then run `npm run firebase:env` again.");
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });
