/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type JobType = 'local' | 'github';

export interface VideoJob {
  id: string;
  type: JobType;
  paragraph: string;
  status: 'processing' | 'completed' | 'failed' | 'idle';
  error?: string;
  videoUrl?: string;
  duration?: number;
  completedAt?: string;
  alignment?: AlignmentData;
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface VisualSegment {
  segmentIndex: number;
  startTime: number;
  endTime: number;
  text: string;
  imagePrompt: string;
}

export interface AlignmentData {
  wordTimestamps: WordTimestamp[];
  visualSegments: VisualSegment[];
}

export interface AppConfig {
  owner: string;
  repo: string;
  pat: string;
  cloudflareUrls: string;
  geminiKeys: string;
  mode: JobType;
}
