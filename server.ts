/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import fs from "fs";
import { fork } from "child_process";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Use JSON and Text body parsers
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API Route: Trigger remote GitHub Action Workflow dispatch
  app.post("/api/trigger-workflow", async (req, res) => {
    const { owner, repo, pat, content_paragraph, cloudflare_urls, gemini_api_keys, video_id } = req.body;

    if (!owner || !repo || !pat) {
      return res.status(400).json({ error: "Missing required GitHub Repository (owner/repo) or Access Token (PAT)" });
    }

    try {
      const workflowFile = "generate-video.yml";
      const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

      console.log(`[Proxy] Triggering workflow dispatch on ${owner}/${repo}...`);

      const response = await fetch(dispatchUrl, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${pat}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "aistudio-build-app"
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            content_paragraph: content_paragraph || "Narrative prompt text",
            cloudflare_urls: cloudflare_urls || "",
            gemini_api_keys: gemini_api_keys || "",
            video_id: video_id
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Proxy] GitHub API error: ${response.status}`, errorText);
        return res.status(response.status).json({
          error: `GitHub API error: ${response.status} ${response.statusText}`,
          details: errorText
        });
      }

      console.log(`[Proxy] GitHub Workflow triggered successfully!`);
      return res.json({ success: true, message: "GitHub Action workflow successfully triggered!" });
    } catch (err: any) {
      console.error(`[Proxy] Connection failed:`, err);
      return res.status(500).json({ error: "Failed to communicate with GitHub API", details: err.message });
    }
  });

  // API Route: Local simulation/direct runner inside AI Studio
  app.post("/api/generate-local", (req, res) => {
    const { content_paragraph, cloudflare_urls, gemini_api_keys, video_id } = req.body;
    const videoId = video_id || `v_local_${Date.now()}`;
    const outputDir = path.resolve(process.cwd(), "public/generated");

    // Spawn script as background fork so server doesn't block
    console.log(`[Local Generator] Spawning child process for video ID: ${videoId}...`);
    try {
      const child = fork(path.resolve(process.cwd(), "scripts/generate-video.js"), [], {
        env: {
          ...process.env,
          CONTENT_PARAGRAPH: content_paragraph,
          CLOUDFLARE_URLS: cloudflare_urls,
          // Fall back to system key if keys not explicitly provided in inputs
          GEMINI_API_KEYS: gemini_api_keys || process.env.GEMINI_API_KEY || "",
          VIDEO_ID: videoId,
          OUTPUT_DIR: outputDir
        },
        silent: false
      });

      // Write initial status placeholder
      fs.mkdirSync(path.join(outputDir, videoId), { recursive: true });
      fs.writeFileSync(path.join(outputDir, videoId, "status.json"), JSON.stringify({
        status: "processing",
        videoId,
        startedAt: new Date().toISOString()
      }, null, 2));

      return res.json({ success: true, videoId, status: "processing" });
    } catch (err: any) {
      console.error("[Local Generator] Failed to start:", err);
      return res.status(500).json({ error: "Failed to initiate video builder process", details: err.message });
    }
  });

  // Serve static folders
  const publicPath = path.resolve(process.cwd(), "public");
  fs.mkdirSync(publicPath, { recursive: true });
  fs.mkdirSync(path.resolve(publicPath, "generated"), { recursive: true });
  app.use(express.static(publicPath));

  // Vite integration in Dev mode
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production fallbacks
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
