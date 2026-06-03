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
  HelpCircle,
  Play,
  RotateCcw,
  Plus
} from "lucide-react";
import { VideoJob, AppConfig } from "./types";

const SUGGESTIONS = [
  "A glowing deep sea submarine discovering glowing ancient ruins",
  "A futuristic rover driving into a massive Martian dust storm",
  "An ancient steam train speeding through a misty pine valley"
];

export default function App() {
  const isGitHubPages = typeof window !== "undefined" && window.location.hostname.endsWith("github.io");

  // Auto-detect Repository structure cleanly
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

  // Active video tracking
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

  // Save Settings state changes
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

  const getFullVideoUrl = (job: VideoJob) => {
    if (!job.videoUrl) return "";
    return `./generated/${job.id}/${job.id}.mp4`;
  };

  const checkJobStatus = async (jobId: string, type: string) => {
    try {
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
          setCustomStatus("Ready");
          setIsPolling(false);
          setCurrentJobId(null);
        } else if (statusData.status === "failed") {
          setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: "failed", error: statusData.error } : j));
          setCustomStatus(`Failed: ${statusData.error}`);
          setIsPolling(false);
          setCurrentJobId(null);
        }
      }
    } catch (err) {
      // Quietly wait for generation pipeline
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
        const inputOwner = prompt("Enter GitHub Username / Owner:", actualOwner);
        const inputRepo = prompt("Enter GitHub Repository Name:", actualRepo);
        if (!inputOwner || !inputRepo) {
          setCustomStatus("Error: GitHub Owner and Repo configuration required.");
          return;
        }
        actualOwner = inputOwner;
        actualRepo = inputRepo;
        setConfig(prev => ({ ...prev, owner: inputOwner, repo: inputRepo }));
      }

      if (!actualPat) {
        const inputPat = prompt("Enter GitHub Personal Access Token (PAT) with workflow scope action triggers:");
        if (!inputPat) {
          setCustomStatus("Error: PAT authorization required.");
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
    setCustomStatus("Triggering generator pipeline...");
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
        if (!res.ok) throw new Error("Local task request failed.");
        setCustomStatus("Creating assets inside sandbox...");
      } catch (err: any) {
        setCustomStatus(`Execution Error: ${err.message}`);
        setIsPolling(false);
        setCurrentJobId(null);
      }
    } else {
      try {
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
          const errMsg = await res.text();
          throw new Error(`Dispatch rejected (${res.status}): ${errMsg}`);
        }
        setCustomStatus("Action dispatched! Compiling cinematic frames...");
      } catch (err: any) {
        setCustomStatus(`Error: ${err.message}`);
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

  const loadRandomSuggestion = () => {
    const randomIndex = Math.floor(Math.random() * SUGGESTIONS.length);
    setParagraph(SUGGESTIONS[randomIndex]);
  };

  return (
    <div id="clean_app_wrapper" className="h-[100dvh] w-full bg-[#050608] text-gray-100 font-sans antialiased overflow-hidden flex flex-col justify-between selection:bg-cyan-500 selection:text-black relative">
      
      {/* Immersive space background noise */}
      <div className="absolute inset-0 bg-[radial-gradient(#151720_1.2px,transparent_1.2px)] [background-size:24px_24px] pointer-events-none opacity-40"></div>

      {/* Minimalism Header */}
      <header className="relative px-6 py-3 flex items-center justify-between border-b border-[#121420]/20 bg-[#06070a]/90 backdrop-blur-md z-20">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></div>
          <span className="text-xs font-semibold tracking-wider text-gray-400">Live Video Engine</span>
        </div>
        
        {isPolling ? (
          <div className="flex items-center gap-1.5 bg-cyan-950/20 border border-cyan-800/30 text-[9px] px-2.5 py-1 rounded-full text-cyan-300 font-mono">
            <RefreshCw className="w-3 h-3 animate-spin text-cyan-400/90" /> {customStatus || "Generating..."}
          </div>
        ) : (
          <div className="text-[10px] text-gray-500 font-mono">
            {customStatus}
          </div>
        )}
      </header>

      {/* Pure Portrait Content Viewport Area */}
      <main className="flex-1 min-h-0 w-full px-4 py-2 flex flex-col items-center justify-center relative z-10">
        
        {/* Simple 9:16 Video Player Card with absolute minimum distraction */}
        <div id="vertical_showcase_frame" className="relative h-full w-full max-h-[75vh] md:max-h-[78vh] aspect-[9/16] bg-black rounded-2xl border border-white/5 shadow-2xl flex flex-col overflow-hidden group">
          
          <div className="relative w-full h-full overflow-hidden bg-black flex flex-col items-center justify-center">
            
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
                
                {/* Text overlay dynamic subtitle overlay */}
                {selectedJob.alignment && (
                  <div className="absolute bottom-6 left-4 right-4 bg-black/80 backdrop-blur-md border border-white/10 p-2.5 text-center text-xs font-sans pointer-events-none z-10 rounded-xl max-w-[90%] mx-auto">
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
              <div className="p-6 text-center space-y-5 text-xs font-sans">
                <div className="flex justify-center">
                  <div className="relative">
                    <div className="w-12 h-12 border-3 border-cyan-500/10 border-t-cyan-400 rounded-full animate-spin"></div>
                    <Sparkles className="w-4 h-4 text-cyan-400 animate-pulse absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                  </div>
                </div>
                <div className="space-y-1 px-4">
                  <div className="font-bold text-gray-200">Rendering Video...</div>
                  <p className="text-[10px] text-gray-500 leading-normal">Fusing sound effects, narrations & visual segments in the cloud</p>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center space-y-4 text-xs text-gray-500">
                <div className="w-12 h-12 rounded-full bg-[#0b0c10] flex items-center justify-center mx-auto border border-white/[0.04]">
                  <Film className="w-5 h-5 text-gray-500" />
                </div>
                <div className="space-y-1">
                  <p className="text-gray-300 font-medium">Render Screen Empty</p>
                  <p className="text-[10px] text-gray-500 leading-relaxed max-w-[200px] mx-auto">
                    Type a prompt scenario below to compile and preview your cinema immediately.
                  </p>
                </div>
              </div>
            )}

            {/* Quick floating Actions */}
            {selectedJob?.status === 'completed' && selectedJob.videoUrl && (
              <a
                href={getFullVideoUrl(selectedJob)}
                download={`render_${selectedJob.id}.mp4`}
                className="absolute top-4 right-4 bg-black/60 hover:bg-black p-2.5 rounded-full border border-white/10 text-cyan-400 hover:text-cyan-300 transition-colors z-20 opacity-0 group-hover:opacity-100 duration-200"
                title="Download Video File"
              >
                <Download className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>

      </main>

      {/* Elegant Bottom Action Chat-style prompt */}
      <footer id="chat_prompt_footer" className="border-t border-[#121420]/20 bg-[#06070a]/90 backdrop-blur-lg px-4 py-4 relative z-20 pb-6">
        <div className="max-w-lg mx-auto relative flex items-end gap-2 bg-[#090a0f] border border-white/[0.07] rounded-xl p-2 focus-within:border-cyan-500/30 transition-colors">
          
          <textarea
            id="story_paragraph_textarea"
            rows={1}
            value={paragraph}
            onKeyDown={handleKeyDown}
            onChange={e => setParagraph(e.target.value)}
            placeholder="Describe your scene space story scenario..."
            className="flex-1 bg-transparent border-none text-xs text-gray-200 leading-normal font-sans placeholder-gray-500 resize-none max-h-20 outline-none focus:ring-0 p-2 py-1"
            style={{ height: "auto" }}
          />

          <button
            onClick={loadRandomSuggestion}
            className="p-2 text-gray-500 hover:text-gray-300 transition-colors"
            title="Load random scenario idea"
          >
            <Sparkles className="w-4 h-4" />
          </button>

          <button
            id="trigger_generation_btn"
            onClick={() => triggerCompilation(paragraph)}
            disabled={isPolling || !paragraph.trim()}
            className={`p-2.5 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
              isPolling || !paragraph.trim()
                ? "bg-white/[0.02] text-gray-600 cursor-not-allowed"
                : "bg-gradient-to-tr from-cyan-400 to-indigo-500 text-black hover:opacity-95 active:scale-95"
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
