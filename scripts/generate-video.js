/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { GoogleGenAI, Modality } from "@google/genai";

// Ensure standard exit handler prints details
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

/**
 * Executes a Gemini function with automatic key rotation if rate limits are hit.
 */
async function callWithGeminiRotation(keys, taskFn) {
  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!key) continue;
    console.log(`[Gemini] Attempting task with key index ${i}/${keys.length - 1}...`);
    try {
      const ai = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
      return await taskFn(ai);
    } catch (err) {
      console.warn(`[Gemini] Error with key index ${i}: ${err.message}`);
      lastError = err;
      // If it's a rate limit or credential issue, we continue to the next key
    }
  }
  throw new Error(`All Gemini API keys exhausted or failed. Last error: ${lastError?.message}`);
}

/**
 * Tries fetching an image from Cloudflare URLs in sequence.
 */
async function generateCloudflareImage(urls, prompt) {
  let lastError = null;
  for (let i = 0; i < urls.length; i++) {
    const rawUrl = urls[i]?.trim();
    if (!rawUrl) continue;
    console.log(`[Image] Fetching from Cloudflare URL index ${i}...`);
    try {
      let fetchUrl = rawUrl;
      let method = 'POST';
      let headers = { 'Content-Type': 'application/json' };
      let body = null;

      // Check if URL has a placeholder
      if (rawUrl.includes('[prompt]')) {
        fetchUrl = rawUrl.replace('[prompt]', encodeURIComponent(prompt));
        method = 'GET';
      } else {
        body = JSON.stringify({ prompt: prompt });
      }

      const res = await fetch(fetchUrl, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(45000)
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength < 2000) {
        // Likely an API error message or empty response
        const text = new TextDecoder().decode(buffer);
        throw new Error(`Response too short (${buffer.byteLength} bytes). Content: ${text.substring(0, 100)}`);
      }

      console.log(`[Image] Successfully generated image (${buffer.byteLength} bytes)`);
      return Buffer.from(buffer);
    } catch (err) {
      console.warn(`[Image] Failure at URL index ${i}: ${err.message}`);
      lastError = err;
    }
  }
  throw new Error(`All Cloudflare Image Generation URLs exhausted. Last error: ${lastError?.message}`);
}

/**
 * Main orchestration function
 */
async function main() {
  const paragraph = process.env.CONTENT_PARAGRAPH || "In the quiet depth of space, a small explorer ship drifts past the rings of an uncharted planet. Cosmic dust glows in a brilliant azure light, casting long shadows across the metal hull. The crew holds their breath as the scanner signals a rhythmic, mysterious transmission.";
  const rawUrls = process.env.CLOUDFLARE_URLS || "";
  const rawGeminiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
  const outputDir = process.env.OUTPUT_DIR || "./public/generated";
  const videoId = process.env.VIDEO_ID || `v_${Date.now()}`;

  const finalDir = path.resolve(outputDir, videoId);
  fs.mkdirSync(finalDir, { recursive: true });

  console.log(`=========================================`);
  console.log(`GitHub Actions Video Editor Engine`);
  console.log(`Video ID: ${videoId}`);
  console.log(`Output Directory: ${finalDir}`);
  console.log(`Paragraph length: ${paragraph.length} chars`);
  console.log(`=========================================`);

  // Parse rotating input parameters to support commas, semicolons, or newlines
  const geminiKeys = rawGeminiKeys.split(/[\n,;]+/)
    .map(k => k.trim())
    .filter(k => k.length > 0);

  const cloudflareUrls = rawUrls.split(/[\n,;]+/)
    .map(u => u.trim())
    .filter(u => u.length > 0);

  if (geminiKeys.length === 0) {
    console.error("No Gemini API Keys provided! Please make sure to add them.");
    process.exit(1);
  }

  if (cloudflareUrls.length === 0) {
    console.warn("No Cloudflare Image URLs provided. Using standard placeholders for visual layers.");
  }

  // 1. Generate Voiceover via Gemini Text-to-Speech
  console.log("\n[Step 1] Generating Voiceover with Gemini TTS...");
  let voiceoverBase64 = null;
  try {
    voiceoverBase64 = await callWithGeminiRotation(geminiKeys, async (ai) => {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: paragraph }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Zephyr' }, // Clear cinematic voice
            },
          },
        },
      });

      const audioPart = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioPart) {
        throw new Error("No inline audio data returned from Gemini TTS.");
      }
      return audioPart;
    });
  } catch (err) {
    console.error("Failed to generate voiceover:", err);
    // Write mistake status JSON
    fs.writeFileSync(path.join(finalDir, "status.json"), JSON.stringify({
      status: "failed",
      error: `Voiceover generation failed: ${err.message}`
    }, null, 2));
    process.exit(1);
  }

  // Save the raw PCM file
  const rawPcmPath = path.join(finalDir, "raw_voice.pcm");
  fs.writeFileSync(rawPcmPath, Buffer.from(voiceoverBase64, 'base64'));
  console.log(`Saved raw voice PCM to ${rawPcmPath}`);

  // Convert raw 24kHz PCM mono to high quality WAV using FFmpeg
  const wavPath = path.join(finalDir, "voiceover.wav");
  try {
    console.log("Converting PCM to WAV via FFmpeg...");
    execSync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${rawPcmPath}" "${wavPath}"`);
    console.log(`Converted successfully to ${wavPath}`);
  } catch (err) {
    console.error("FFmpeg PCM conversion failed. Ensure FFmpeg is installed.", err);
    fs.writeFileSync(path.join(finalDir, "status.json"), JSON.stringify({
      status: "failed",
      error: `WAV audio encoding failed: ${err.message}. Please install FFmpeg.`
    }, null, 2));
    process.exit(1);
  }

  // Query FFmpeg to find out precise audio duration
  let audioDuration = 15.0; // Fail-safe default
  try {
    const durStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`).toString().trim();
    if (durStr && !isNaN(durStr)) {
      audioDuration = parseFloat(durStr);
    }
    console.log(`Detected audio duration: ${audioDuration} seconds`);
  } catch (e) {
    console.warn("Could not retrieve precise audio duration. Using estimated duration based on paragraph.");
    audioDuration = Math.max(10, Math.ceil(paragraph.split(/\s+/).length * 0.45));
  }

  // 2. Generate Timed Transcription and Image Prompts using Gemini
  console.log("\n[Step 2] Aligning script and generating image prompts...");
  let alignmentData = null;
  try {
    const alignmentText = await callWithGeminiRotation(geminiKeys, async (ai) => {
      const prompt = `You are a professional video automation editor. We have generated a narrated voiceover of ${audioDuration.toFixed(1)} seconds matching this paragraph:
"${paragraph}"

Your task is to:
1. Provide a word-by-word transcription with precision timestamps (occurring between 0.0 and ${audioDuration.toFixed(1)} seconds) so we can create professional subtitles.
2. Break the video into scenic intervals of exactly 5 seconds each. For each 5-second interval, define an elegant, atmospheric, and highly detailed visual prompt for an image generator (SDXL) in a modern vertical 9:16 aspect ratio (cinematic, dramatic lighting).
3. Estimate the total number of 5-second intervals needed to cover the voiceover (e.g. if duration is 13s, you will need 3 segments: 0-5s, 5-10s, 10-15s).

Format your output strictly as a valid JSON object matching the following structure:
{
  "wordTimestamps": [
    { "word": "In", "start": 0.1, "end": 0.4 },
    { "word": "the", "start": 0.4, "end": 0.6 }
  ],
  "visualSegments": [
    {
      "segmentIndex": 0,
      "startTime": 0,
      "endTime": 5,
      "text": "In the quiet depth of space, a small explorer ship drifts",
      "imagePrompt": "Cinematic 9:16 portrait. A micro astronaut scout spaceship drifting silently near the glowing neon rings of a turquoise gas giant, atmospheric starfield, extreme detail, octanerender, 8k"
    }
  ]
}

Only return clean, valid JSON. No markdown code wraps, no trailing junk.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      return response.text;
    });

    alignmentData = JSON.parse(alignmentText.trim());
    console.log(`Aligned ${alignmentData.wordTimestamps?.length} words with ${alignmentData.visualSegments?.length} scenery slides.`);
    fs.writeFileSync(path.join(finalDir, "alignment.json"), JSON.stringify(alignmentData, null, 2));
  } catch (err) {
    console.error("Script alignment JSON generation failed, using programmatic backup:", err);
    // Programmatic segment fallback if Gemini fails or rate limits
    const words = paragraph.split(/\s+/);
    const estWordsPerSec = words.length / audioDuration;
    const wordTimestamps = words.map((w, index) => {
      const start = index / estWordsPerSec;
      return { word: w, start, end: start + (1 / estWordsPerSec) };
    });

    const numSegments = Math.ceil(audioDuration / 5);
    const visualSegments = [];
    for (let s = 0; s < numSegments; s++) {
      const sStart = s * 5;
      const sEnd = Math.min(audioDuration, (s + 1) * 5);
      const segmentWords = words.slice(
        Math.floor(sStart * estWordsPerSec),
        Math.floor(sEnd * estWordsPerSec)
      );
      visualSegments.push({
        segmentIndex: s,
        startTime: sStart,
        endTime: sEnd,
        text: segmentWords.join(" "),
        imagePrompt: `Cinematic dramatic still matching: ${segmentWords.slice(0, 10).join(" ")}, high detailed movie frame vertical 9:16 ratio`
      });
    }

    alignmentData = { wordTimestamps, visualSegments };
    fs.writeFileSync(path.join(finalDir, "alignment.json"), JSON.stringify(alignmentData, null, 2));
  }

  // 3. Generate Visuals using the Cloudflare rotating endpoints
  console.log("\n[Step 3] Fetching image layers from Cloudflare AI...");
  const segmentImagePaths = [];

  for (const seg of alignmentData.visualSegments) {
    const idx = seg.segmentIndex;
    const prompt = seg.imagePrompt;
    const imgFilename = `slide_${idx}.png`;
    const finalImgPath = path.join(finalDir, imgFilename);

    console.log(`Slide #${idx} prompt: "${prompt}"`);

    let imgBuffer = null;
    if (cloudflareUrls.length > 0) {
      try {
        imgBuffer = await generateCloudflareImage(cloudflareUrls, prompt);
      } catch (err) {
        console.error(`Failed to generate custom image for slide ${idx}:`, err.message);
      }
    }

    if (imgBuffer) {
      fs.writeFileSync(finalImgPath, imgBuffer);
    } else {
      // Create high-color gradient placeholder using canvas/imagemagick or simple colored images
      console.warn(`Could not generate Cloudflare image. Generating colorful SVG fallback...`);
      // Since SVG can represent a high quality slide, we convert SVG to PNG or let ffmpeg render directly!
      // FFmpeg can handle colorful slides directly using a pure color filter! Let's write down a note.
      // But creating a base solid color file is very easy using node fs or standard tool if needed.
      // Let's copy a small generic image or make a clean blank file. Wait, FFmpeg has a built-in virtual color source!
      // If a slide is missing, we can instruct FFmpeg to output a beautiful colored video slice with text, e.g. color=c=blue
    }
    segmentImagePaths.push(finalImgPath);
  }

  // 4. Create SRT Subtitles file
  console.log("\n[Step 4] Writing SRT subtitles...");
  const srtPath = path.join(finalDir, "subtitles.srt");
  let srtContent = "";

  // Group words into short readable subtitle phrases (around 3 to 5 words each)
  const phrases = [];
  const words = alignmentData.wordTimestamps || [];
  const phraseSize = 4;
  for (let i = 0; i < words.length; i += phraseSize) {
    const slice = words.slice(i, i + phraseSize);
    if (slice.length === 0) continue;
    const phraseText = slice.map(w => w.word).join(" ");
    const start = slice[0].start;
    const end = slice[slice.length - 1].end;
    phrases.push({ text: phraseText, start, end });
  }

  function formatSRTTime(seconds) {
    const hrs = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const mins = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    const ms = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
    return `${hrs}:${mins}:${secs},${ms}`;
  }

  phrases.forEach((ph, i) => {
    srtContent += `${i + 1}\n`;
    srtContent += `${formatSRTTime(ph.start)} --> ${formatSRTTime(ph.end)}\n`;
    srtContent += `${ph.text}\n\n`;
  });

  fs.writeFileSync(srtPath, srtContent);
  console.log(`SRT subtitles generated at ${srtPath}`);

  // 5. Render Video via FFmpeg
  console.log("\n[Step 5] Compiling final vertical video slide series...");
  const finalVideoName = `video_${videoId}.mp4`;
  const finalVideoPath = path.join(finalDir, finalVideoName);

  // We have multiple slides.
  // Let's create an input text file for FFmpeg concat demuxer!
  // This is highly efficient and avoids massive filter_complex compilation errors.
  const inputTxtPath = path.join(finalDir, "slides.txt");
  let inputTxtContent = "";

  alignmentData.visualSegments.forEach((seg, index) => {
    const imgFilename = `slide_${seg.segmentIndex}.png`;
    const slideImgPath = path.join(finalDir, imgFilename);

    // If the image doesn't exist, we generate a simple solid color frame with text using FFmpeg!
    if (!fs.existsSync(slideImgPath)) {
      console.log(`Image missing for slide ${index}. Generating neon space fallback frame...`);
      try {
        const command = `ffmpeg -y -f lavfi -i "color=c=0x181824:s=720x1280:d=5" -vf "drawtext=text='${seg.text.replace(/'/g, "'\\''")}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2" -pix_fmt yuv420p "${slideImgPath}"`;
        execSync(command);
      } catch (err) {
        console.warn(`Could not generate fallback frame via FFmpeg: ${err.message}. Writing black dummy bytes.`);
        fs.writeFileSync(slideImgPath, Buffer.alloc(1000)); // Minimal block
      }
    }

    inputTxtContent += `file '${slideImgPath}'\n`;
    inputTxtContent += `duration 5.0\n`;
  });

  // Last image needs to be repeated in FFmpeg concat demuxer
  if (alignmentData.visualSegments.length > 0) {
    const lastSeg = alignmentData.visualSegments[alignmentData.visualSegments.length - 1];
    const lastImgFilename = `slide_${lastSeg.segmentIndex}.png`;
    inputTxtContent += `file '${path.join(finalDir, lastImgFilename)}'\n`;
  }

  fs.writeFileSync(inputTxtPath, inputTxtContent);
  console.log(`FFmpeg concat list written to ${inputTxtPath}`);

  try {
    // Phase A: Generate slideshow video from images
    const slideshowVideoPath = path.join(finalDir, "slideshow.mp4");
    console.log("Rendering slideshow from concat filter...");
    execSync(`ffmpeg -y -f concat -safe 0 -i "${inputTxtPath}" -pix_fmt yuv420p -vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -r 30 "${slideshowVideoPath}"`);

    // Phase B: Merge slides video with synthesized audio track and burn subtitles
    console.log("Merging audio track and burning subtitles... (vertical 9:16)");
    const cleanSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:'); // Escape backslashes/colons for FFmpeg filters

    // Burn stylish subtitles onto the vertical canvas
    const ffmpegCmd = `ffmpeg -y -i "${slideshowVideoPath}" -i "${wavPath}" -filter_complex "subtitles='${cleanSrtPath}':force_style='Alignment=10,FontSize=20,PrimaryColour=&H00FFFF00,OutlineColour=&H00000000,Outline=2,MarginV=120'" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest "${finalVideoPath}"`;
    console.log(`Running FFmpeg: ${ffmpegCmd}`);
    execSync(ffmpegCmd);

    console.log(`\n🎉 Success! Output vertical video rendered at: ${finalVideoPath}`);

    // Create completed status.json file
    fs.writeFileSync(path.join(finalDir, "status.json"), JSON.stringify({
      status: "completed",
      videoId,
      duration: audioDuration,
      videoUrl: `generated/${videoId}/${finalVideoName}`,
      alignment: alignmentData,
      completedAt: new Date().toISOString()
    }, null, 2));

  } catch (err) {
    console.error("FFmpeg video rendering failed:", err);
    fs.writeFileSync(path.join(finalDir, "status.json"), JSON.stringify({
      status: "failed",
      error: `Video rendering failed: ${err.message}`
    }, null, 2));
    process.exit(1);
  }

  // Cleanup huge temp files to save disk Space
  try {
    if (fs.existsSync(rawPcmPath)) fs.unlinkSync(rawPcmPath);
    console.log("Temporary audio files cleared.");
  } catch (e) {
    console.warn("Cleanup warning:", e.message);
  }
}

main();
