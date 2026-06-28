import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DIST_DIR = path.join(__dirname, "dist");

function getLanAddress() {
  const nets = os.networkInterfaces();
  for (const addresses of Object.values(nets)) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return "localhost";
}

async function setupClientRoutes() {
  app.use(express.static(PUBLIC_DIR, { index: false }));

  if (process.env.NODE_ENV === "production" && fs.existsSync(path.join(DIST_DIR, "index.html"))) {
    app.use(express.static(DIST_DIR, { index: false }));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(DIST_DIR, "index.html"));
    });
    return;
  }

  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: __dirname,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

await setupClientRoutes();

server.listen(PORT, "0.0.0.0", () => {
  const lan = getLanAddress();
  console.log("Live Event Poll is running with Firebase Realtime Database");
  console.log(`Local: http://localhost:${PORT}/admin`);
  console.log(`LAN:   http://${lan}:${PORT}/admin`);
});
