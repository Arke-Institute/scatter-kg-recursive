/**
 * Moby Dick Real Chunks Test
 *
 * Tests the scatter → extract → dedupe → cluster → describe workflow
 * with real text chunks from Moby Dick (~8k characters each)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  configureTestClient,
  createCollection,
  createEntity,
  getEntity,
  invokeRhiza,
  waitForWorkflowTree,
  log,
} from '@arke-institute/klados-testing';

// =============================================================================
// Configuration
// =============================================================================

const ARKE_API_BASE = process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute';
const ARKE_USER_KEY = process.env.ARKE_USER_KEY;
const NETWORK = (process.env.ARKE_NETWORK || 'test') as 'test' | 'main';
const SCATTER_KG_RHIZA = process.env.SCATTER_KG_RHIZA;
const SCATTER_KLADOS = process.env.SCATTER_KLADOS;
const KG_EXTRACTOR_KLADOS = process.env.KG_EXTRACTOR_KLADOS;
const KG_DEDUPE_RESOLVER_KLADOS = process.env.KG_DEDUPE_RESOLVER_KLADOS;
const KG_CLUSTER_KLADOS = process.env.KG_CLUSTER_KLADOS;
const DESCRIBE_KLADOS = process.env.DESCRIBE_KLADOS;

const MOBY_DICK_PATH = '/Users/chim/Downloads/classics/moby-dick.txt';
const CHUNK_SIZE = 8000; // ~2000 tokens
const NUM_CHUNKS = 4; // Number of chunks to test with

// =============================================================================
// Helper Functions
// =============================================================================

function loadMobyDickChunks(): string[] {
  const content = fs.readFileSync(MOBY_DICK_PATH, 'utf-8');

  // Find where actual content starts (after Project Gutenberg header)
  const startMarker = 'CHAPTER 1. Loomings.';
  const contentStart = content.lastIndexOf(startMarker);
  if (contentStart === -1) {
    throw new Error('Could not find start of Moby Dick content');
  }

  // Find where content ends (before Project Gutenberg footer)
  const endMarker = '*** END OF THE PROJECT GUTENBERG';
  let contentEnd = content.indexOf(endMarker);
  if (contentEnd === -1) {
    contentEnd = content.length;
  }

  const mainContent = content.slice(contentStart, contentEnd);

  // Split into chunks at chapter boundaries when possible
  const chapters = mainContent.split(/(?=CHAPTER \d+\.)/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const chapter of chapters) {
    if (currentChunk.length + chapter.length > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = chapter;
    } else {
      currentChunk += chapter;
    }

    if (chunks.length >= NUM_CHUNKS) break;
  }

  if (currentChunk.length > 0 && chunks.length < NUM_CHUNKS) {
    chunks.push(currentChunk.trim());
  }

  return chunks.slice(0, NUM_CHUNKS);
}

// =============================================================================
// Test Suite
// =============================================================================

describe('moby-dick real chunks', () => {
  let targetCollection: { id: string };
  let manifestEntity: { id: string };
  let textEntities: { id: string }[] = [];
  let jobCollectionId: string;
  let chunks: string[] = [];

  beforeAll(() => {
    if (!ARKE_USER_KEY) {
      console.warn('Skipping tests: ARKE_USER_KEY not set');
      return;
    }
    if (!SCATTER_KG_RHIZA || !SCATTER_KLADOS || !KG_EXTRACTOR_KLADOS || !KG_DEDUPE_RESOLVER_KLADOS || !KG_CLUSTER_KLADOS || !DESCRIBE_KLADOS) {
      console.warn('Skipping tests: Missing env vars');
      return;
    }
    if (!fs.existsSync(MOBY_DICK_PATH)) {
      console.warn(`Skipping tests: Moby Dick file not found at ${MOBY_DICK_PATH}`);
      return;
    }

    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: NETWORK,
    });

    // Load chunks
    chunks = loadMobyDickChunks();
    log(`Loaded ${chunks.length} chunks from Moby Dick`);
    for (let i = 0; i < chunks.length; i++) {
      log(`  Chunk ${i + 1}: ${chunks[i].length} chars`);
    }

    log(`Using rhiza: ${SCATTER_KG_RHIZA}`);
  });

  beforeAll(async () => {
    if (!ARKE_USER_KEY || !SCATTER_KG_RHIZA || chunks.length === 0) return;

    log('Creating test fixtures...');

    // Create target collection
    targetCollection = await createCollection({
      label: `Moby Dick Test ${Date.now()}`,
      description: 'Test collection for Moby Dick KG extraction',
      roles: { public: ['*:view', '*:invoke'] },
    });
    log(`Created target collection: ${targetCollection.id}`);

    // Create text entities for each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunkPreview = chunks[i].slice(0, 100).replace(/\n/g, ' ');
      const entity = await createEntity({
        type: 'text_chunk',
        properties: {
          label: `Moby Dick Chunk ${i + 1}`,
          content: chunks[i],
          source: 'Moby Dick by Herman Melville',
          chunk_index: i,
          created_at: new Date().toISOString(),
        },
        collection: targetCollection.id,
      });
      textEntities.push(entity);
      log(`Created text entity ${i + 1}: ${entity.id} (${chunks[i].length} chars)`);
      log(`  Preview: "${chunkPreview}..."`);
    }

    // Create manifest entity
    manifestEntity = await createEntity({
      type: 'scatter_job',
      properties: {
        label: 'Moby Dick Extraction Job',
        description: 'KG extraction from Moby Dick chapters',
        entity_count: textEntities.length,
        created_at: new Date().toISOString(),
      },
      collection: targetCollection.id,
    });
    log(`Created manifest entity: ${manifestEntity.id}`);
  });

  afterAll(async () => {
    if (!ARKE_USER_KEY || !SCATTER_KG_RHIZA) return;

    log('Cleanup DISABLED for inspection');
    log(`  Target collection: ${targetCollection?.id}`);
    log(`  Manifest entity: ${manifestEntity?.id}`);
    log(`  Text entities: ${textEntities.map(e => e.id).join(', ')}`);
    log(`  Job collection: ${jobCollectionId}`);
  });

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('should extract KG from real Moby Dick text', async () => {
    if (!ARKE_USER_KEY || !SCATTER_KG_RHIZA || chunks.length === 0) {
      console.warn('Test skipped: missing environment variables or chunks');
      return;
    }

    // Invoke the workflow
    log('Invoking scatter-kg workflow...');
    const entityIds = textEntities.map(e => e.id);
    log(`Entity IDs to scatter: ${entityIds.join(', ')}`);

    const result = await invokeRhiza({
      rhizaId: SCATTER_KG_RHIZA,
      targetEntity: manifestEntity.id,
      targetCollection: targetCollection.id,
      input: {
        entity_ids: entityIds,
      },
      confirm: true,
    });

    expect(result.status).toBe('started');
    expect(result.job_id).toBeDefined();
    expect(result.job_collection).toBeDefined();

    jobCollectionId = result.job_collection!;
    log(`Workflow started: ${result.job_id}`);
    log(`Job collection: ${jobCollectionId}`);

    // Wait for workflow to complete
    log('Waiting for workflow to complete (real text extraction may take a while)...');
    const tree = await waitForWorkflowTree(jobCollectionId, {
      timeout: 600000, // 10 minutes for real text
      pollInterval: 10000,
      onPoll: (t, elapsed) => {
        const elapsedSec = Math.round(elapsed / 1000);
        log(`[${elapsedSec}s] ${t.logs.size} logs, complete=${t.isComplete}`);
      },
    });

    expect(tree.isComplete).toBe(true);
    log(`Workflow complete with ${tree.logs.size} logs`);

    // Wait for additive updates to be processed (status updates are eventually consistent)
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Analyze logs
    const logs = Array.from(tree.logs.values());

    // Find scatter log ID from tree, then re-fetch to get updated status
    const scatterLogId = logs.find(l => l.properties?.klados_id === SCATTER_KLADOS)?.id;
    const scatterLog = scatterLogId ? await getEntity(scatterLogId) : undefined;
    const extractLogs = logs.filter(l => l.properties?.klados_id === KG_EXTRACTOR_KLADOS);
    const dedupeLogs = logs.filter(l => l.properties?.klados_id === KG_DEDUPE_RESOLVER_KLADOS);
    const clusterLogs = logs.filter(l => l.properties?.klados_id === KG_CLUSTER_KLADOS);
    const describeLogs = logs.filter(l => l.properties?.klados_id === DESCRIBE_KLADOS);

    log(`Scatter log: ${scatterLog?.id} (status: ${scatterLog?.properties?.status})`);
    log(`Extract logs: ${extractLogs.length}`);
    log(`Dedupe logs: ${dedupeLogs.length}`);
    log(`Cluster logs: ${clusterLogs.length}`);
    log(`Describe logs: ${describeLogs.length}`);

    // Verify scatter succeeded
    expect(scatterLog).toBeDefined();
    expect(scatterLog?.properties?.status).toBe('done');

    // Verify extractions completed
    expect(extractLogs.length).toBe(chunks.length);
    for (const extractLog of extractLogs) {
      expect(extractLog.properties?.status).toBe('done');
    }

    // Log summary
    log('');
    log('='.repeat(60));
    log('Moby Dick KG Extraction Summary');
    log('='.repeat(60));
    log(`  Text chunks processed: ${chunks.length}`);
    log(`  Entities extracted: ${dedupeLogs.length}`);
    log(`  Clusters formed: ${clusterLogs.length}`);
    log(`  Clusters described: ${describeLogs.length}`);
    log('='.repeat(60));
  }, 900000); // 15 minute test timeout
});
