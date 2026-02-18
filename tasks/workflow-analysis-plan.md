# Enhanced Workflow Analysis Tool Plan

## Goal

Create a comprehensive diagnostic tool that provides deep timing and flow analysis for scatter-kg workflow runs, enabling identification of bottlenecks and understanding of parallelization efficiency.

## Available Data in Logs

From examining the existing collection (`IIKHQ31B4VBAYK77SZAE1F9RXG`), each `klados_log` entity contains:

### Timing Fields
| Field | Location | Description |
|-------|----------|-------------|
| `created_at` | Root | Entity creation timestamp |
| `started_at` | `log_data.entry.started_at` | When job processing started |
| `completed_at` | `log_data.entry.completed_at` | When job completed |
| `ts` | Root | Last update timestamp |
| Message timestamps | `log_data.messages[].timestamp` | Per-message timing |

### Stage Identification
| Field | Location | Description |
|-------|----------|-------------|
| `klados_id` | `properties.klados_id` | Which klados ran |
| `rhiza_path` | `log_data.entry.received.rhiza_path` | (Sometimes null) |
| `handoffs[].type` | `log_data.entry.handoffs[].type` | scatter/pass/done |

### Klados ID → Stage Mapping (from `.env`)
```
IIKHHD7B3FFR681X4XG64CQGH2 = scatter (entry point)
IIKH9PJ2RXCWARWT0CY5D6ZSK6 = extract
IIKHHDFPKR744D2X78GTQE9K56 = dedupe
IIKHJ4Y39SFMH2BSKED7BPQD57 = cluster
IIKHM05BX9NKE0S24TZCDKWFDF = describe
```

### Relationship Data
- `sent_to` relationships: Links to child logs
- `from_logs` in received: Parent log IDs
- `scatter_total`: Expected parallel branches

### Output Data
- `handoffs[].outputs`: Entity IDs produced
- `handoffs[].invocations`: Invocation details with requests

## Analysis Metrics to Compute

### 1. Overall Workflow Timing
- **Total duration**: First `started_at` → Last `completed_at`
- **Stage durations**: Time from first log start to last log complete per stage
- **Time to first output**: When did the first extract/dedupe/cluster complete?

### 2. Per-Stage Analysis
For each stage (scatter, extract, dedupe, cluster, describe):
- **Log count**: How many jobs ran
- **First start / Last complete**: Stage boundaries
- **Stage duration**: Last complete - First start
- **Parallelization efficiency**: Ideal vs actual duration
- **Stragglers**: Which branches took longest? How much did they delay the stage?

### 3. Bottleneck Identification
- **Longest-running logs**: Which individual jobs took longest?
- **Stage transitions**: Time between one stage completing and next starting
- **Blocking branches**: If one branch is 2x slower, quantify delay impact
- **Fan-out ratios**: scatter_total at each stage

### 4. Per-Branch Timeline
- **Branch traces**: Follow each entity's path through the workflow
- **Branch completion times**: When did each parallel path finish?
- **Latest finisher per stage**: Which branch held up the stage?

### 5. Output Analysis
- **Entities created per stage**: Count outputs
- **Output distribution**: Were outputs evenly distributed?
- **Dropped branches**: Logs with no sent_to (terminal with outputs)

## Implementation Plan

### Phase 1: Data Collection Script

**File**: `scripts/analyze-workflow.ts`

```typescript
// 1. Fetch all logs from collection
// 2. Build in-memory data structure with:
//    - Logs indexed by ID
//    - Logs grouped by stage (klados_id)
//    - Parent-child relationships
//    - Timeline events (start/complete for each log)

interface LogSummary {
  id: string;
  stage: 'scatter' | 'extract' | 'dedupe' | 'cluster' | 'describe';
  status: string;
  startedAt: Date;
  completedAt: Date;
  duration: number;  // ms
  parentLogs: string[];
  childLogs: string[];
  outputCount: number;
  scatterTotal?: number;
}

interface StageMetrics {
  stage: string;
  logCount: number;
  firstStart: Date;
  lastComplete: Date;
  stageDuration: number;
  avgLogDuration: number;
  maxLogDuration: number;
  minLogDuration: number;
  slowestLog: string;
}
```

### Phase 2: Batch Fetching

Fetch all logs efficiently:
1. Get log IDs from collection listing
2. Batch fetch entities (up to 100 at a time via `/entities/batch`)
3. Parse and index in memory

### Phase 3: Analysis Functions

```typescript
// Timeline Analysis
function computeTimeline(logs: LogSummary[]): TimelineEvent[];
function computeStageMetrics(logs: LogSummary[]): StageMetrics[];

// Bottleneck Detection
function findStragglers(logs: LogSummary[]): Straggler[];
function computeParallelizationEfficiency(stage: StageMetrics): number;

// Branch Tracing
function traceBranch(rootLog: string, logs: Map<string, LogSummary>): BranchTrace;
function findLatestFinisher(stage: string, logs: LogSummary[]): LogSummary;
```

### Phase 4: Output Formats

#### 4.1 Summary Report (Default)
```
============================================================
WORKFLOW ANALYSIS: IIKHQ31B4VBAYK77SZAE1F9RXG
============================================================
Total Duration: 7m 28s
Total Logs: 130
Status: Complete

STAGE BREAKDOWN:
Stage     | Logs | Duration | Parallel Eff | Slowest Log
----------|------|----------|--------------|-------------
scatter   |    1 |     4.9s |         100% | ...17B8
extract   |    6 |    40.5s |          78% | ...6K64 (took 35s)
dedupe    |   57 |    62.1s |          43% | ...BYHQ (took 12s)
cluster   |   63 |   312.5s |          89% | ...ZDMY (took 6s)
describe  |    3 |    10.6s |          95% | ...BYHQT

BOTTLENECKS:
1. Cluster stage: 5m 12s (70% of total time)
   - Jittery wait times account for most duration
2. Extract branch IIKHQ31F277S3RGXS0XN4J6K64 took 35s
   - 26s in Gemini call, 3.4s in entity creation
```

#### 4.2 Timeline View (--timeline)
```
00:00.000  START workflow
00:04.966  COMPLETE scatter (1 log, scattered to 6)
00:12.619  COMPLETE extract[1] (12 entities created)
00:35.171  COMPLETE extract[2] (15 entities created)
00:40.520  COMPLETE extract[3] (8 entities created)
00:42.123  COMPLETE extract[4] (11 entities created)
00:43.089  COMPLETE extract[5] (14 entities created)
00:43.823  COMPLETE extract[6] (10 entities created) ← last extract
00:45.234  COMPLETE dedupe[1] (passed through)
...
07:28.006  COMPLETE describe[3] ← workflow done
```

#### 4.3 Stage Detail (--stage=cluster)
```
CLUSTER STAGE DETAIL (63 logs)
First started: 00:52.123
Last completed: 05:24.628
Stage duration: 4m 32s

LOG BREAKDOWN:
ID        | Started   | Completed | Duration | Outputs | Notes
----------|-----------|-----------|----------|---------|-------
...AKXA83 | 00:52.123 | 00:58.671 |    6.5s  |       1 |
...BYHQ   | 00:52.456 | 01:04.891 |   12.4s  |       0 | solo (dissolved)
...ZDMY   | 00:53.012 | 00:59.037 |    6.0s  |       1 |
...
```

#### 4.4 JSON Output (--json)
Full structured data for programmatic analysis.

## Command Interface

```bash
# Basic analysis
npx tsx scripts/analyze-workflow.ts <job_collection_id>

# Detailed timeline
npx tsx scripts/analyze-workflow.ts <job_collection_id> --timeline

# Stage detail
npx tsx scripts/analyze-workflow.ts <job_collection_id> --stage=cluster

# JSON output
npx tsx scripts/analyze-workflow.ts <job_collection_id> --json

# Compare two runs
npx tsx scripts/analyze-workflow.ts <id1> <id2> --compare
```

## Implementation Order

1. **Batch fetch all logs** - Get all data in memory
2. **Parse and index** - Build LogSummary map
3. **Compute stage metrics** - Group by klados, compute timing
4. **Generate summary report** - Default output
5. **Add timeline view** - Chronological events
6. **Add stage detail view** - Per-stage breakdown
7. **Add JSON output** - Structured data

## Next Steps

1. Run the plan on existing collection `IIKHQ31B4VBAYK77SZAE1F9RXG` to verify data structure assumptions
2. Implement Phase 1-3
3. Generate report and validate findings
4. Integrate insights into test output
