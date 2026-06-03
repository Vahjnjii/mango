/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Sparkles,
  RefreshCw,
  Film,
  Download,
  Send,
  HelpCircle
} from "lucide-react";
import { VideoJob, AppConfig } from "./types";

export default function App() {
  // Detect mode automatically depending on where the app is loaded
  const isGitHubPages = typeof window !== "undefined" && window.location.hostname.endsWith("github.io");

  // Helper to extract Repo details from GitHub URL automatically
  const extractRepoDetails = () => {
    let owner = "";
    let repo = "";
    if (isGitHubPages) {
      owner = window.location.hostname.replace(".github.io", "");
      const pathParts = window.location.pathname.split("/").filter(Boolean);
      if (pathParts.length > 0) {
        repo = pathParts[0];
      }
    }
    return { owner, repo };
  };

  const [config, setConfig] = useState<AppConfig>(() => {
    const saved = localStorage.getItem("gha_video_config");
    const auto = extractRepoDetails();
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          owner: parsed.owner || auto.owner,
          repo: parsed.repo || auto.repo,
          pat: parsed.pat || localStorage.getItem("gha_pat") || "",
          cloudflareUrls: parsed.cloudflareUrls || "",
          geminiKeys: parsed.geminiKeys || "",
          mode: isGitHubPages ? "github" : "local"
        };
      } catch (e) {}
    }
    return {
      owner: auto.owner,
      repo: auto.repo,
      pat: localStorage.getItem("gha_pat") || "",
      cloudflareUrls: "",
      geminiKeys: "",
      mode: isGitHubPages ? "github" : "local"
    };
  });

  const [paragraph, setParagraph] = useState("");
  
  // --- Video Jobs State ---
  const [jobs, setJobs] = useState<VideoJob[]>(() => {
    const saved = localStorage.getItem("gha_video_jobs");
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { return []; }
    }
    return [];
  });

  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [customStatus, setCustomStatus] = useState<string>("Ready");
  const [isPolling, setIsPolling] = useState(false);
  const pollingTimer = useRef<NodeJS.Timeout | null>(null);

  // --- Active Video Playback ---
  const [selectedJob, setSelectedJob] = useState<VideoJob | null>(() => {
    const savedJobs = localStorage.getItem("gha_video_jobs");
    if (savedJobs) {
      try {
        const parsed = JSON.parse(savedJobs);
        const completed = parsed.find((j: any) => j.status === 'completed');
        return completed || parsed[0] || null;
      } catch (e) { return null; }
    }
    return null;
  });

  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Auto-saves state in background
  useEffect(() => {
    localStorage.setItem("gha_video_config", JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    localStorage.setItem("gha_video_jobs", JSON.stringify(jobs));
  }, [jobs]);

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  // Build the relative video file path cleanly
  const getFullVideoUrl = (job: VideoJob) => {
    if (!job.videoUrl) return "";
    // Inside general production setups, generated MP4 sits inside the generated folders
    return `./generated/${job.id}/${job.id}.mp4`;
  };

  // Poll for pipeline progress
  const checkJobStatus = async (jobId: string, type: string) => {
    try {
      // Clean request uniform pointing for both static deployment & development paths
      const statusUrl = `./generated/${jobId}/status.json?t=${Date.now()}`;

      const res = await fetch(statusUrl);
      if (res.ok) {
        const statusData = await res.json();
        if (statusData.status === "completed") {
          const updated: VideoJob = {
            id: jobId,
            type: type as any,
            paragraph: statusData.alignment?.text || statusData.paragraph || "",
            status: "completed",
            videoUrl: statusData.videoUrl || `generated/${jobId}/${jobId}.mp4`,
            duration: statusData.duration,
            alignment: statusData.alignment,
            completedAt: statusData.completedAt
          };

          setJobs(prev => prev.map(j => j.id === jobId ? updated : j));
          setSelectedJob(updated);
          setCustomStatus("🎉 Video rendered completely!");
          setIsPolling(false);
          setCurrentJobId(null);
        } else if (statusData.status === "failed") {
          setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: "failed", error: statusData.error } : j));
          setCustomStatus(`❌ Rendering failed: ${statusData.error}`);
          setIsPolling(false);
          setCurrentJobId(null);
        }
      }
    } catch (err) {
      console.warn("Poll interval checked, waiting for video content files...", err);
    }
  };

  useEffect(() => {
    if (isPolling && currentJobId) {
      pollingTimer.current = setInterval(() => {
        const target = jobs.find(j => j.id === currentJobId);
        if (target) checkJobStatus(currentJobId, target.type);
      }, 4000);
    }
    return () => {
      if (pollingTimer.current) clearInterval(pollingTimer.current);
    };
  }, [isPolling, currentJobId, jobs]);

  // Request to execute generator pipeline
  const triggerCompilation = async (textToSend: string) => {
    const promptText = textToSend.trim();
    if (!promptText) return;

    const videoId = `v_${Date.now()}`;
    const runMode = isGitHubPages ? "github" : "local";

    let actualOwner = config.owner;
    let actualRepo = config.repo;
    let actualPat = config.pat;

    if (runMode === "github") {
      const autoDetails = extractRepoDetails();
      actualOwner = actualOwner || autoDetails.owner;
      actualRepo = actualRepo || autoDetails.repo;

      if (!actualOwner || !actualRepo) {
        const inputOwner = prompt("Enter your GitHub repo target owner (username):", actualOwner);
        const inputRepo = prompt("Enter your GitHub repo name:", actualRepo);
        if (!inputOwner || !inputRepo) {
          setCustomStatus("Required Repository configuration missing!");
          return;
        }
        actualOwner = inputOwner;
        actualRepo = inputRepo;
        setConfig(prev => ({ ...prev, owner: inputOwner, repo: inputRepo }));
      }

      if (!actualPat) {
        const inputPat = prompt("Enter GitHub Personal Access Token (PAT) with repository trigger workflow authorization to process dispatch request:");
        if (!inputPat) {
          setCustomStatus("PAT authorization is required to continue.");
          return;
        }
        actualPat = inputPat;
        localStorage.setItem("gha_pat", inputPat);
        setConfig(prev => ({ ...prev, pat: inputPat }));
      }
    }

    const newJob: VideoJob = {
      id: videoId,
      type: runMode,
      paragraph: promptText,
      status: "processing"
    };

    setJobs(prev => [newJob, ...prev]);
    setCurrentJobId(videoId);
    setIsPolling(true);
    setSelectedJob(newJob);
    setCustomStatus("Triggering generator sequence...");
    setParagraph("");

    if (runMode === "local") {
      try {
        const res = await fetch("/api/generate-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content_paragraph: promptText,
            cloudflare_urls: config.cloudflareUrls,
            gemini_api_keys: config.geminiKeys,
            video_id: videoId
          })
        });
        if (!res.ok) throw new Error("Local worker rejection.");
        setCustomStatus("Local generator running inside container sandbox...");
      } catch (err: any) {
        setCustomStatus(`Local Execution Error: ${err.message}`);
        setIsPolling(false);
        setCurrentJobId(null);
      }
    } else {
      // Trigger via GitHub API directly from static site securely
      try {
        // Post direct Dispatch message target
        const workflowFile = "generate-video.yml";
        const dispatchUrl = `https://api.github.com/repos/${actualOwner}/${actualRepo}/actions/workflows/${workflowFile}/dispatches`;

        const res = await fetch(dispatchUrl, {
          method: "POST",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${actualPat}`,
            "X-GitHub-Api-Version": "2022-11-28"
          },
          body: JSON.stringify({
            ref: "main",
            inputs: {
              content_paragraph: promptText,
              cloudflare_urls: config.cloudflareUrls,
              gemini_api_keys: config.geminiKeys,
              video_id: videoId
            }
          })
        });

        if (!res.ok) {
          const detailMsg = await res.text();
          throw new Error(`Dispatch rejected (${res.status}): ${detailMsg}`);
        }
        setCustomStatus("🚀 GitHub Dispatch successful! Pipeline compiling video...");
      } catch (err: any) {
        setCustomStatus(`Remote Trigger Error: ${err.message}`);
        setIsPolling(false);
        setCurrentJobId(null);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      triggerCompilation(paragraph);
    }
  };

  return (
    <div id="clean_app_wrapper" className="h-[100dvh] w-full bg-[#040508] text-gray-100 font-sans antialiased overflow-hidden flex flex-col justify-between selection:bg-cyan-500 selection:text-black relative">
      
      {/* Immersive Dark Cosmic Grid */}
      <div className="absolute inset-0 bg-[radial-gradient(#121319_1.5px,transparent_1.5px)] [background-size:24px_24px] pointer-events-none opacity-40"></div>

      {/* Minimalism Header */}
      <header className="relative px-6 py-3.5 flex items-center justify-between border-b border-[#121420]/30 bg-[#06070a]/90 backdrop-blur-md z-20">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></div>
          <span className="text-xs font-bold uppercase tracking-widest text-[#8c94a9]">Live Video Engine</span>
        </div>
        
        {isPolling && (
          <div className="flex items-center gap-1.5 bg-cyan-950/30 border border-cyan-800/40 text-[9px] px-2.5 py-1 rounded-full text-cyan-300 font-mono">
            <RefreshCw className="w-3 h-3 animate-spin" /> Compiling...
          </div>
        )}
      </header>

      {/* Primary Portrait Content Viewport Area */}
      <main className="flex-1 min-h-0 w-full px-4 py-3 flex flex-col items-center justify-center relative z-10">
        
        {/* Absolute 9:16 Cinema Player with ultra round curves and razor sharp contrast */}
        <div id="vertical_showcase_frame" className="relative h-full w-full max-h-[72vh] sm:max-h-[76vh] md:max-h-[78vh] aspect-[9/16] bg-black rounded-3xl border-2 border-[#151928]/90 shadow-2xl flex flex-col overflow-hidden">
          
          <div className="relative w-full h-full overflow-hidden bg-[#05060a] flex flex-col items-center justify-center">
            
            {selectedJob?.status === "completed" && selectedJob.videoUrl ? (
              <>
                <video
                  ref={videoRef}
                  src={getFullVideoUrl(selectedJob)}
                  onTimeUpdate={handleTimeUpdate}
                  controls
                  playsInline
                  autoPlay
                  className="w-full h-full object-cover"
                />
                
                {/* Visual Segment / Words Interactive subtitled banner */}
                {selectedJob.alignment && (
                  <div className="absolute bottom-6 left-4 right-4 bg-black/85 backdrop-blur-md border border-cyan-500/20 p-2.5 text-center text-xs font-sans pointer-events-none z-10 rounded-xl max-w-[90%] mx-auto shadow-xl">
                    <p className="text-cyan-300 font-extrabold tracking-wide leading-relaxed">
                      {selectedJob.alignment.wordTimestamps
                        ?.filter(w => currentTime >= w.start && currentTime <= w.end)
                        ?.map(w => w.word)
                        .join(" ") || 
                        selectedJob.alignment.visualSegments
                          ?.find(s => currentTime >= s.startTime && currentTime <= s.endTime)
                          ?.text || 
                        "..."}
                    </p>
                  </div>
                )}
              </>
            ) : selectedJob?.status === "processing" ? (
              <div className="p-6 text-center space-y-6 text-xs font-sans">
                <div className="flex justify-center">
                  <div className="relative">
                    <div className="w-14 h-14 border-4 border-indigo-950/50 border-t-cyan-400 rounded-full animate-spin"></div>
                    <Sparkles className="w-5 h-5 text-indigo-400 animate-pulse absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                  </div>
                </div>
                <div className="space-y-1.5 px-4">
                  <span className="text-[10px] font-mono text-cyan-400 uppercase tracking-widest block">Compiling Studio Pipeline</span>
                  <div className="font-extrabold text-white text-sm">Rendering Frame Asset...</div>
                  <p className="text-[10px] text-gray-500 leading-normal">Fusing cinematic audio narration & high quality SDXL storyboard frames</p>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center space-y-4 text-xs text-gray-500">
                <div className="w-14 h-14 rounded-full bg-[#0c0d15] flex items-center justify-center mx-auto border border-[#171a2a]">
                  <Film className="w-6 h-6 text-gray-600" />
                </div>
                <div className="space-y-1">
                  <p className="text-gray-400 font-bold text-sm">No Video Generated</p>
                  <p className="text-[10px] text-gray-600 px-6 leading-relaxed">Enter a scenario flow sequence down below to create & render your cinema.</p>
                </div>
              </div>
            )}

            {/* Float Action Download Trigger */}
            {selectedJob?.status === 'completed' && selectedJob.videoUrl && (
              <a
                href={getFullVideoUrl(selectedJob)}
                download={`render_${selectedJob.id}.mp4`}
                className="absolute top-4 right-4 bg-black/80 hover:bg-black p-2.5 rounded-full border border-[#1c1f2d] text-cyan-400 hover:text-cyan-300 transition-colors z-20"
                title="Download MP4 Clip"
              >
                <Download className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>

        {/* Minimal compact subtitle status info track */}
        <div className="text-center font-mono text-[10px] text-gray-500 mt-2.5">
          {customStatus}
        </div>

      </main>

      {/* Premium Screen-Anchored Single Chat Command Box */}
      <footer id="chat_prompt_footer" className="border-t border-[#121420]/30 bg-[#050609]/95 px-4 py-4 relative z-20 pb-5">
        <div className="max-w-lg mx-auto relative flex items-end gap-2 bg-[#090b10] border border-[#161a29] rounded-xl p-2 focus-within:border-cyan-500/40 transition-colors">
          
          <textarea
            id="story_paragraph_textarea"
            rows={1}
            value={paragraph}
            onKeyDown={handleKeyDown}
            onChange={e => setParagraph(e.target.value)}
            placeholder="Type your script scenario narrative here to compile..."
            className="flex-1 bg-transparent border-none text-xs text-gray-200 leading-normal font-sans placeholder-gray-600 resize-none max-h-20 outline-none focus:ring-0 p-2 py-1"
            style={{ height: "auto" }}
          />

          <button
            id="trigger_generation_btn"
            onClick={() => triggerCompilation(paragraph)}
            disabled={isPolling || !paragraph.trim()}
            className={`p-2.5 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
              isPolling || !paragraph.trim()
                ? "bg-[#0d0f17] text-gray-700 cursor-not-allowed"
                : "bg-gradient-to-tr from-cyan-400 to-indigo-500 text-black hover:opacity-95 active:scale-95 shadow-md shadow-cyan-950/20"
            }`}
          >
            {isPolling ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </footer>

    </div>
  );
}
