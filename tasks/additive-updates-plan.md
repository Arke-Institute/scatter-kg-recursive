# Migration to /updates/additive for Rhiza Log Updates

## Problem Summary

The current log update flow uses `withCasRetry` which causes multi-minute delays:

```
processJob() completes (01:25)
    ↓
interpretThen() - fires handoff (immediate)
    ↓
updateLogWithHandoffs() ← BLOCKING: CAS retries with concurrency=10
    ↓
updateLogStatus() ← BLOCKING: CAS retries with concurrency=10
    ↓
Returns (07:17)  ← 5+ minute delay!
```

The `concurrency=10` setting adds 0-1000ms initial spread delay, plus exponential backoff on conflicts.

## Solution: Use `/updates/additive`

The `/updates/additive` endpoint:
- **Fire-and-forget**: Returns 202 immediately
- **Handles CAS internally**: Retries conflicts server-side
- **Deep merges properties**: Nested objects are merged
- **Upserts relationships**: `relationships_add` adds or updates

## Current CAS Retry Locations in writer.ts

| Location | Lines | Purpose | Concurrency | Can Use Additive? |
|----------|-------|---------|-------------|-------------------|
| writeKladosLog | 146-167 | Add received_from to new log | 100 | Yes - relationships |
| writeKladosLog | 172-197 | Add first_log to collection | 10 | Yes - relationships |
| writeKladosLog | 200-281 | Add sent_to to parent logs | dynamic | Yes - relationships |
| updateLogWithHandoffs | 298-333 | Set log_data.entry.handoffs | 10 | Yes - deep merge |
| updateLogStatus | 368-413 | Set status, completed_at, etc | 10 | Yes - deep merge |

## Migration Plan

### Phase 1: Relationship Updates (Safe, Big Impact)

These are pure relationship additions - perfect for `/updates/additive`:

#### 1.1 received_from relationships (lines 146-167)
```typescript
// BEFORE: CAS retry
await withCasRetry({...}, { concurrency: 100 });

// AFTER: Fire-and-forget additive
await client.api.POST('/updates/additive', {
  body: {
    updates: [{
      entity_id: logEntityId,
      relationships_add: relationships.map(r => ({
        predicate: r.predicate,
        peer: r.peer,
      })),
    }],
  },
});
// Don't await - fire and forget
```

#### 1.2 first_log relationship (lines 172-197)
```typescript
// BEFORE: CAS retry
await withCasRetry({...}, { concurrency: 10 });

// AFTER: Fire-and-forget additive
client.api.POST('/updates/additive', {
  body: {
    updates: [{
      entity_id: jobCollectionId,
      relationships_add: [{
        predicate: 'first_log',
        peer: logEntityId,
      }],
    }],
  },
}).catch(console.error); // Fire and forget
```

#### 1.3 sent_to relationships (lines 200-281) - BIGGEST WIN
```typescript
// BEFORE: CAS retry per parent, or external service
await Promise.all(parentBatch.map(parentLogId =>
  withCasRetry({...}, { concurrency: concurrencyPerParent })
));

// AFTER: Single batch additive update
client.api.POST('/updates/additive', {
  body: {
    updates: parentLogIds.map(parentLogId => ({
      entity_id: parentLogId,
      relationships_add: [{
        predicate: 'sent_to',
        peer: logEntityId,
      }],
    })),
  },
}).catch(console.error); // Fire and forget
```

This is the biggest win - instead of N CAS retry loops with concurrency conflicts, one fire-and-forget call handles all parent updates.

### Phase 2: Property Updates (Requires Deep Merge)

These update nested properties in `log_data`:

#### 2.1 updateLogWithHandoffs (lines 293-334)
```typescript
// BEFORE: Read-modify-write with CAS
await withCasRetry({
  getTip: async () => {...},
  update: async (tip) => {
    const entity = await client.api.GET('/entities/{id}');
    const logData = entity.properties.log_data;
    logData.entry.handoffs = handoffs;
    return client.api.PUT('/entities/{id}', {...});
  }
}, { concurrency: 10 });

// AFTER: Deep merge additive
client.api.POST('/updates/additive', {
  body: {
    updates: [{
      entity_id: logFileId,
      properties: {
        log_data: {
          entry: {
            handoffs: handoffs,
          },
        },
      },
    }],
  },
}).catch(console.error);
```

#### 2.2 updateLogStatus (lines 360-414)
```typescript
// BEFORE: Read-modify-write with CAS

// AFTER: Deep merge additive
const now = new Date().toISOString();
client.api.POST('/updates/additive', {
  body: {
    updates: [{
      entity_id: logFileId,
      properties: {
        status, // Top-level for easy querying
        log_data: {
          entry: {
            status,
            completed_at: now,
            ...(logError && { error: logError }),
          },
          ...(messages && { messages }),
        },
      },
    }],
  },
}).catch(console.error);
```

## Implementation Details

### New Helper Function

Add to `writer.ts`:

```typescript
/**
 * Queue additive updates (fire-and-forget)
 *
 * Uses /updates/additive for CAS-conflict-free updates.
 * Returns immediately, updates are processed asynchronously.
 */
async function queueAdditiveUpdates(
  client: ArkeClient,
  updates: Array<{
    entity_id: string;
    properties?: Record<string, unknown>;
    relationships_add?: Array<{
      predicate: string;
      peer: string;
      peer_type?: string;
    }>;
  }>
): Promise<void> {
  // Fire and forget - don't await
  client.api.POST('/updates/additive', {
    body: { updates },
  }).catch((err) => {
    console.error('[rhiza] Failed to queue additive updates:', err);
  });
}
```

### Order of Operations

The key insight is that the **actual handoff happens immediately** in `interpretThen()`. The log updates are just recording what happened. So fire-and-forget is safe:

```
processJob() completes
    ↓
interpretThen() ← Actual handoff fires here (immediate)
    ↓
queueAdditiveUpdates() ← Fire-and-forget log updates
    ↓
Returns immediately ← No more blocking!
```

### Backwards Compatibility

- Tree traversal (`waitForWorkflowTree`) may temporarily see missing `sent_to` relationships
- This is already handled - it polls until complete
- Status queries may see stale status briefly - acceptable for observability

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Handoff delay | 5+ minutes | < 1 second |
| API calls per log update | 3+ with retries | 1 |
| CAS conflicts | Many (exponential backoff) | None (handled server-side) |
| Worker response time | Blocked by updates | Immediate return |

## Files to Modify

1. **rhiza/src/logging/writer.ts**
   - Add `queueAdditiveUpdates` helper
   - Modify `writeKladosLog` to use additive for relationships
   - Modify `updateLogWithHandoffs` to use additive
   - Modify `updateLogStatus` to use additive

2. **rhiza/src/worker/job.ts** (if it calls these directly)
   - Update any direct CAS retry usage

## Testing Plan

1. Deploy updated rhiza package
2. Run scatter-kg test
3. Verify with workflow analysis:
   - Handoff delays should be < 1s
   - All logs should still have correct relationships
   - Status updates should propagate

## Rollback Plan

Keep the old CAS retry code available behind a flag:
```typescript
const USE_ADDITIVE_UPDATES = true; // Feature flag
```
