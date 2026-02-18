/**
 * Enhanced Workflow Analysis Tool
 *
 * Provides comprehensive timing and flow analysis for scatter-kg workflow runs.
 *
 * Usage:
 *   npx tsx scripts/analyze-workflow.ts <job_collection_id>
 *   npx tsx scripts/analyze-workflow.ts <job_collection_id> --timeline
 *   npx tsx scripts/analyze-workflow.ts <job_collection_id> --stage=cluster
 *   npx tsx scripts/analyze-workflow.ts <job_collection_id> --json
 */

// Configuration - map klados IDs to stage names
const KLADOS_STAGES: Record<string, string> = {
  'IIKHHD7B3FFR681X4XG64CQGH2': 'scatter',
  'IIKH9PJ2RXCWARWT0CY5D6ZSK6': 'extract',
  'IIKHHDFPKR744D2X78GTQE9K56': 'dedupe',
  'IIKHJ4Y39SFMH2BSKED7BPQD57': 'cluster',
  'IIKHM05BX9NKE0S24TZCDKWFDF': 'describe',
};

const STAGE_ORDER = ['scatter', 'extract', 'dedupe', 'cluster', 'describe'];

const API_BASE = 'https://arke-v1.arke.institute';
const API_KEY = process.env.ARKE_USER_KEY!;

// Types
interface LogEntity {
  id: string;
  type: string;
  created_at: string;
  ts: string;
  properties: {
    klados_id: string;
    status: string;
    log_data: {
      entry: {
        started_at: string;
        completed_at: string;
        status: string;
        received?: {
          from_logs?: string[];
          target_entity?: string;
          scatter_total?: number;
        };
        handoffs?: Array<{
          type: string;
          outputs?: string[];
          invocations?: Array<unknown>;
        }>;
      };
      messages?: Array<{
        level: string;
        message: string;
        timestamp: string;
        metadata?: Record<string, unknown>;
      }>;
    };
  };
  relationships?: Array<{
    predicate: string;
    peer: string;
  }>;
}

interface LogSummary {
  id: string;
  stage: string;
  status: string;
  startedAt: Date;
  completedAt: Date;
  duration: number; // ms
  parentLogs: string[];
  childLogs: string[];
  outputCount: number;
  scatterTotal?: number;
  targetEntity?: string;
  messages: Array<{
    level: string;
    message: string;
    timestamp: Date;
    metadata?: Record<string, unknown>;
  }>;
}

interface StageMetrics {
  stage: string;
  logCount: number;
  firstStart: Date;
  lastComplete: Date;
  stageDuration: number; // ms
  avgLogDuration: number;
  maxLogDuration: number;
  minLogDuration: number;
  slowestLog: LogSummary;
  fastestLog: LogSummary;
  totalOutputs: number;
}

interface TimelineEvent {
  timestamp: Date;
  type: 'start' | 'complete';
  logId: string;
  stage: string;
  index: number; // which log in stage (1-indexed)
  totalInStage: number;
  duration?: number; // for complete events
  outputs?: number;
}

interface AnalysisResult {
  jobCollectionId: string;
  totalLogs: number;
  totalDuration: number;
  firstStart: Date;
  lastComplete: Date;
  isComplete: boolean;
  stages: StageMetrics[];
  timeline: TimelineEvent[];
  logs: LogSummary[];
  bottlenecks: string[];
}

// API Functions
async function fetchCollectionLogs(collectionId: string): Promise<string[]> {
  const res = await fetch(
    `${API_BASE}/collections/${collectionId}/entities?type=klados_log&limit=500`,
    { headers: { Authorization: `ApiKey ${API_KEY}` } }
  );
  const data = await res.json() as { entities: Array<{ id: string }> };
  return data.entities.map(e => e.id);
}

async function batchFetchEntities(ids: string[]): Promise<LogEntity[]> {
  const entities: LogEntity[] = [];

  // Fetch in batches of 100
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await fetch(`${API_BASE}/entities/batch-get`, {
      method: 'POST',
      headers: {
        Authorization: `ApiKey ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: batch }),
    });
    const data = await res.json() as { entities: LogEntity[] };
    entities.push(...data.entities);
  }

  return entities;
}

// Analysis Functions
function parseLog(entity: LogEntity): LogSummary {
  const entry = entity.properties.log_data.entry;
  const messages = entity.properties.log_data.messages ?? [];
  const sentTo = (entity.relationships ?? [])
    .filter(r => r.predicate === 'sent_to')
    .map(r => r.peer);

  const handoffs = entry.handoffs ?? [];
  let outputCount = 0;
  for (const h of handoffs) {
    if (h.outputs) outputCount += h.outputs.length;
  }

  const startedAt = new Date(entry.started_at);
  const completedAt = new Date(entry.completed_at);

  return {
    id: entity.id,
    stage: KLADOS_STAGES[entity.properties.klados_id] ?? 'unknown',
    status: entry.status,
    startedAt,
    completedAt,
    duration: completedAt.getTime() - startedAt.getTime(),
    parentLogs: entry.received?.from_logs ?? [],
    childLogs: sentTo,
    outputCount,
    scatterTotal: entry.received?.scatter_total,
    targetEntity: entry.received?.target_entity,
    messages: messages.map(m => ({
      ...m,
      timestamp: new Date(m.timestamp),
    })),
  };
}

function computeStageMetrics(logs: LogSummary[]): StageMetrics[] {
  const byStage = new Map<string, LogSummary[]>();

  for (const log of logs) {
    const existing = byStage.get(log.stage) ?? [];
    existing.push(log);
    byStage.set(log.stage, existing);
  }

  const metrics: StageMetrics[] = [];

  for (const stage of STAGE_ORDER) {
    const stageLogs = byStage.get(stage);
    if (!stageLogs || stageLogs.length === 0) continue;

    const durations = stageLogs.map(l => l.duration);
    const starts = stageLogs.map(l => l.startedAt.getTime());
    const completes = stageLogs.map(l => l.completedAt.getTime());

    const firstStart = new Date(Math.min(...starts));
    const lastComplete = new Date(Math.max(...completes));

    const sortedByDuration = [...stageLogs].sort((a, b) => b.duration - a.duration);

    metrics.push({
      stage,
      logCount: stageLogs.length,
      firstStart,
      lastComplete,
      stageDuration: lastComplete.getTime() - firstStart.getTime(),
      avgLogDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      maxLogDuration: Math.max(...durations),
      minLogDuration: Math.min(...durations),
      slowestLog: sortedByDuration[0],
      fastestLog: sortedByDuration[sortedByDuration.length - 1],
      totalOutputs: stageLogs.reduce((sum, l) => sum + l.outputCount, 0),
    });
  }

  return metrics;
}

function computeTimeline(logs: LogSummary[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const stageCounters = new Map<string, { started: number; completed: number; total: number }>();

  // Count totals per stage
  for (const log of logs) {
    const counter = stageCounters.get(log.stage) ?? { started: 0, completed: 0, total: 0 };
    counter.total++;
    stageCounters.set(log.stage, counter);
  }

  // Create events
  for (const log of logs) {
    const counter = stageCounters.get(log.stage)!;

    events.push({
      timestamp: log.startedAt,
      type: 'start',
      logId: log.id,
      stage: log.stage,
      index: ++counter.started,
      totalInStage: counter.total,
    });

    events.push({
      timestamp: log.completedAt,
      type: 'complete',
      logId: log.id,
      stage: log.stage,
      index: ++counter.completed,
      totalInStage: counter.total,
      duration: log.duration,
      outputs: log.outputCount,
    });
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Renumber completion indices
  const completionCounters = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'complete') {
      const count = (completionCounters.get(event.stage) ?? 0) + 1;
      completionCounters.set(event.stage, count);
      event.index = count;
    }
  }

  return events;
}

function identifyBottlenecks(stages: StageMetrics[], totalDuration: number): string[] {
  const bottlenecks: string[] = [];

  for (const stage of stages) {
    const pct = (stage.stageDuration / totalDuration) * 100;

    if (pct > 40) {
      bottlenecks.push(
        `${stage.stage} stage took ${formatDuration(stage.stageDuration)} (${pct.toFixed(0)}% of total)`
      );
    }

    // Check for stragglers
    if (stage.logCount > 1 && stage.maxLogDuration > stage.avgLogDuration * 2) {
      bottlenecks.push(
        `${stage.stage} straggler: ${stage.slowestLog.id.slice(-8)} took ${formatDuration(stage.maxLogDuration)} ` +
        `(avg: ${formatDuration(stage.avgLogDuration)})`
      );
    }
  }

  return bottlenecks;
}

async function analyze(jobCollectionId: string): Promise<AnalysisResult> {
  // Fetch all log IDs
  const logIds = await fetchCollectionLogs(jobCollectionId);

  // Batch fetch all logs
  const entities = await batchFetchEntities(logIds);

  // Parse logs
  const logs = entities.map(parseLog);

  // Compute metrics
  const stages = computeStageMetrics(logs);
  const timeline = computeTimeline(logs);

  // Overall timing
  const allStarts = logs.map(l => l.startedAt.getTime());
  const allCompletes = logs.map(l => l.completedAt.getTime());
  const firstStart = new Date(Math.min(...allStarts));
  const lastComplete = new Date(Math.max(...allCompletes));
  const totalDuration = lastComplete.getTime() - firstStart.getTime();

  // Check completion
  const isComplete = logs.every(l => l.status === 'done' || l.status === 'error');

  // Identify bottlenecks
  const bottlenecks = identifyBottlenecks(stages, totalDuration);

  return {
    jobCollectionId,
    totalLogs: logs.length,
    totalDuration,
    firstStart,
    lastComplete,
    isComplete,
    stages,
    timeline,
    logs,
    bottlenecks,
  };
}

// Formatting Helpers
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

function formatTime(date: Date, reference: Date): string {
  const diff = date.getTime() - reference.getTime();
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  const ms = diff % 1000;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

// Output Functions
function printSummary(result: AnalysisResult): void {
  const { jobCollectionId, totalLogs, totalDuration, firstStart, isComplete, stages, bottlenecks } = result;

  console.log('='.repeat(70));
  console.log('WORKFLOW ANALYSIS');
  console.log('='.repeat(70));
  console.log(`Collection:     ${jobCollectionId}`);
  console.log(`Total Logs:     ${totalLogs}`);
  console.log(`Total Duration: ${formatDuration(totalDuration)}`);
  console.log(`Status:         ${isComplete ? 'Complete' : 'Incomplete'}`);
  console.log(`Started:        ${firstStart.toISOString()}`);
  console.log('');

  // Stage breakdown table
  console.log('STAGE BREAKDOWN');
  console.log('-'.repeat(70));
  console.log(
    'Stage'.padEnd(10) +
    'Logs'.padStart(6) +
    'Duration'.padStart(12) +
    'Avg/Log'.padStart(10) +
    'Max'.padStart(10) +
    'Outputs'.padStart(9) +
    '  Slowest'
  );
  console.log('-'.repeat(70));

  for (const stage of stages) {
    console.log(
      stage.stage.padEnd(10) +
      stage.logCount.toString().padStart(6) +
      formatDuration(stage.stageDuration).padStart(12) +
      formatDuration(stage.avgLogDuration).padStart(10) +
      formatDuration(stage.maxLogDuration).padStart(10) +
      stage.totalOutputs.toString().padStart(9) +
      '  ' + stage.slowestLog.id.slice(-8)
    );
  }
  console.log('');

  // Parallelization efficiency
  console.log('PARALLELIZATION EFFICIENCY');
  console.log('-'.repeat(70));
  for (const stage of stages) {
    if (stage.logCount <= 1) continue;

    // Ideal: all logs run in parallel, stage takes as long as slowest log
    // Actual: stage takes from first start to last complete
    const ideal = stage.maxLogDuration;
    const actual = stage.stageDuration;
    const efficiency = (ideal / actual) * 100;

    const bar = '█'.repeat(Math.round(efficiency / 5)) + '░'.repeat(20 - Math.round(efficiency / 5));
    console.log(`${stage.stage.padEnd(10)} ${bar} ${efficiency.toFixed(0)}%`);
  }
  console.log('');

  // Bottlenecks
  if (bottlenecks.length > 0) {
    console.log('BOTTLENECKS');
    console.log('-'.repeat(70));
    for (const b of bottlenecks) {
      console.log(`  • ${b}`);
    }
    console.log('');
  }

  // Time to first completion per stage
  console.log('TIME TO FIRST COMPLETION');
  console.log('-'.repeat(70));
  for (const stage of stages) {
    const timeToFirst = stage.firstStart.getTime() - result.firstStart.getTime();
    const firstComplete = stage.logs?.[0]?.completedAt ?? stage.lastComplete;
    // Find actual first completion
    const stageLogs = result.logs.filter(l => l.stage === stage.stage);
    const sortedByComplete = [...stageLogs].sort(
      (a, b) => a.completedAt.getTime() - b.completedAt.getTime()
    );
    const firstCompleteTime = sortedByComplete[0].completedAt.getTime() - result.firstStart.getTime();

    console.log(
      `${stage.stage.padEnd(10)} started at ${formatTime(stage.firstStart, result.firstStart)}, ` +
      `first complete at ${formatTime(sortedByComplete[0].completedAt, result.firstStart)}`
    );
  }
}

function printTimeline(result: AnalysisResult): void {
  console.log('='.repeat(70));
  console.log('WORKFLOW TIMELINE');
  console.log('='.repeat(70));
  console.log('');

  const stageLastComplete = new Map<string, TimelineEvent>();

  for (const event of result.timeline) {
    const time = formatTime(event.timestamp, result.firstStart);
    const shortId = event.logId.slice(-8);

    if (event.type === 'start') {
      // Only show starts for first log in stage
      if (event.index === 1) {
        console.log(`${time}  START  ${event.stage}`);
      }
    } else {
      // Track last complete per stage
      stageLastComplete.set(event.stage, event);

      const isLast = event.index === event.totalInStage;
      const marker = isLast ? '←' : ' ';
      const outputs = event.outputs ? ` (${event.outputs} outputs)` : '';

      if (isLast || event.totalInStage <= 10) {
        console.log(
          `${time}  DONE   ${event.stage}[${event.index}/${event.totalInStage}] ` +
          `${shortId} ${formatDuration(event.duration!)}${outputs} ${marker}`
        );
      }
    }
  }

  console.log('');
  console.log('← = last completion for stage (stage boundary)');
}

function printStageDetail(result: AnalysisResult, stageName: string): void {
  const stageLogs = result.logs
    .filter(l => l.stage === stageName)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  if (stageLogs.length === 0) {
    console.log(`No logs found for stage: ${stageName}`);
    return;
  }

  const stageMetrics = result.stages.find(s => s.stage === stageName)!;

  console.log('='.repeat(70));
  console.log(`STAGE DETAIL: ${stageName.toUpperCase()}`);
  console.log('='.repeat(70));
  console.log(`Logs:          ${stageLogs.length}`);
  console.log(`First Start:   ${formatTime(stageMetrics.firstStart, result.firstStart)}`);
  console.log(`Last Complete: ${formatTime(stageMetrics.lastComplete, result.firstStart)}`);
  console.log(`Duration:      ${formatDuration(stageMetrics.stageDuration)}`);
  console.log('');

  console.log('LOG BREAKDOWN');
  console.log('-'.repeat(70));
  console.log(
    'ID'.padEnd(10) +
    'Started'.padStart(12) +
    'Duration'.padStart(10) +
    'Outputs'.padStart(9) +
    '  Notes'
  );
  console.log('-'.repeat(70));

  for (const log of stageLogs) {
    const shortId = log.id.slice(-8);
    const startTime = formatTime(log.startedAt, result.firstStart);
    const notes: string[] = [];

    if (log.outputCount === 0 && stageName === 'cluster') {
      notes.push('solo (dissolved)');
    }
    if (log.status === 'error') {
      notes.push('ERROR');
    }
    if (log === stageMetrics.slowestLog) {
      notes.push('slowest');
    }

    console.log(
      shortId.padEnd(10) +
      startTime.padStart(12) +
      formatDuration(log.duration).padStart(10) +
      log.outputCount.toString().padStart(9) +
      '  ' + notes.join(', ')
    );
  }
  console.log('');

  // Message analysis for slowest log
  console.log(`SLOWEST LOG MESSAGES (${stageMetrics.slowestLog.id.slice(-8)})`);
  console.log('-'.repeat(70));

  let prevTime = stageMetrics.slowestLog.startedAt;
  for (const msg of stageMetrics.slowestLog.messages) {
    const gap = msg.timestamp.getTime() - prevTime.getTime();
    const gapStr = gap > 1000 ? ` (+${formatDuration(gap)})` : '';
    console.log(`  ${formatTime(msg.timestamp, result.firstStart)} ${msg.message}${gapStr}`);
    prevTime = msg.timestamp;
  }
}

function printJson(result: AnalysisResult): void {
  // Convert dates to ISO strings for JSON
  const jsonResult = {
    ...result,
    firstStart: result.firstStart.toISOString(),
    lastComplete: result.lastComplete.toISOString(),
    stages: result.stages.map(s => ({
      ...s,
      firstStart: s.firstStart.toISOString(),
      lastComplete: s.lastComplete.toISOString(),
      slowestLog: { id: s.slowestLog.id, duration: s.slowestLog.duration },
      fastestLog: { id: s.fastestLog.id, duration: s.fastestLog.duration },
    })),
    timeline: result.timeline.map(e => ({
      ...e,
      timestamp: e.timestamp.toISOString(),
    })),
    logs: result.logs.map(l => ({
      ...l,
      startedAt: l.startedAt.toISOString(),
      completedAt: l.completedAt.toISOString(),
      messages: l.messages.map(m => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
      })),
    })),
  };

  console.log(JSON.stringify(jsonResult, null, 2));
}

// Main
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: npx tsx scripts/analyze-workflow.ts <job_collection_id> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --timeline       Show chronological event timeline');
    console.log('  --stage=NAME     Show detailed breakdown for a specific stage');
    console.log('  --json           Output as JSON');
    process.exit(1);
  }

  const jobCollectionId = args[0];
  const showTimeline = args.includes('--timeline');
  const showJson = args.includes('--json');
  const stageArg = args.find(a => a.startsWith('--stage='));
  const stageName = stageArg?.split('=')[1];

  console.log(`Analyzing workflow: ${jobCollectionId}`);
  console.log('Fetching logs...');

  const result = await analyze(jobCollectionId);

  console.log(`Found ${result.totalLogs} logs`);
  console.log('');

  if (showJson) {
    printJson(result);
  } else if (stageName) {
    printStageDetail(result, stageName);
  } else if (showTimeline) {
    printTimeline(result);
  } else {
    printSummary(result);
  }
}

main().catch(console.error);
