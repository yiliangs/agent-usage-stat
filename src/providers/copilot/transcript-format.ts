export interface CopilotEvent<T = Record<string, unknown>> {
  type?: string;
  timestamp?: string;
  data?: T;
}

export interface CopilotSessionStart {
  sessionId?: string;
  startTime?: string;
  context?: {
    cwd?: string;
    gitRoot?: string;
    branch?: string;
  };
}

export interface CopilotTokenCount {
  tokenCount?: number;
}

export interface CopilotModelMetric {
  /** Native billed amount in billionths of one GitHub AI Credit. */
  totalNanoAiu?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  tokenDetails?: {
    input?: CopilotTokenCount;
    output?: CopilotTokenCount;
    cache_read?: CopilotTokenCount;
    cache_write?: CopilotTokenCount;
  };
}

export interface CopilotSessionShutdown {
  modelMetrics?: Record<string, CopilotModelMetric>;
  currentModel?: string;
}
