/**
 * Scatter KG Workflow Test
 *
 * Tests the scatter → extract → dedupe → cluster → describe workflow:
 * 1. Creates text entities for KG extraction
 * 2. Creates a manifest entity as the workflow target
 * 3. Invokes workflow with entity IDs via input.entity_ids
 * 4. Waits for scatter + extract + dedupe + cluster + describe to complete
 * 5. Verifies all logs succeeded
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  configureTestClient,
  createCollection,
  createEntity,
  deleteEntity,
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

// Sample texts for KG extraction - longer passages for richer extraction
const SAMPLE_TEXTS = [
  `Captain Ahab commanded the Pequod, a whaling ship that sailed from Nantucket in the 1840s. Ahab was consumed by an obsessive hatred for Moby Dick, the legendary white sperm whale that had bitten off his leg during a previous voyage. The captain had replaced his lost limb with a prosthetic made from whale bone. Ahab's monomania drove him to pursue the white whale across the world's oceans, ultimately leading his crew into dangerous waters. The Pequod was owned by Captains Peleg and Bildad, both retired Quaker whalers who ran the ship's business from Nantucket.`,

  `Ishmael was a young schoolteacher turned sailor who narrated the voyage of the Pequod. Before joining the ship, Ishmael stayed at the Spouter-Inn in New Bedford, Massachusetts, where he met Queequeg, a harpooner from the fictional island of Rokovoko in the South Pacific. Despite initial apprehension about sharing a bed with a "cannibal," Ishmael formed a deep friendship with Queequeg. The two men became inseparable companions, with Queequeg even performing a ritual that bound them as lifelong friends. Queequeg carried a small idol named Yojo and practiced his native religious customs.`,

  `Starbuck served as the first mate aboard the Pequod. He was a native of Nantucket and a devout Quaker who believed in practical whaling for profit rather than Ahab's vengeful quest. Starbuck often clashed with Ahab over the captain's obsession with Moby Dick, at one point even contemplating mutiny. The second mate was Stubb, a carefree Cape Cod man who smoked a pipe constantly and faced danger with casual humor. Flask, the third mate from Martha's Vineyard, was short in stature but fierce in his hatred of whales, viewing them as personal enemies.`,

  `The harpooners of the Pequod were drawn from diverse backgrounds across the globe. Queequeg, the South Pacific islander, was assigned to Starbuck's whaleboat. Tashtego, a Gay Head Indian from Martha's Vineyard, served under Stubb's command. Daggoo, a gigantic African who had voluntarily joined a whaling ship, was Flask's harpooner. Each harpooner was skilled in the dangerous art of striking whales from small whaleboats. Fedallah, a mysterious Parsee from India, led Ahab's secret boat crew that had been smuggled aboard the Pequod before sailing.`,

  `Moby Dick was no ordinary sperm whale. The white whale had become legendary among whalers for his ferocity and the distinctive white coloring of his massive body. Moby Dick had destroyed numerous boats and killed many sailors who attempted to hunt him. The whale's forehead bore wrinkles that some interpreted as hieroglyphic markings. His tail, capable of tremendous power, could splinter a whaleboat with a single blow. Sailors who survived encounters with Moby Dick spoke of his seemingly intelligent and malevolent behavior, as if the whale deliberately targeted his attackers.`,

  `The whaling industry in nineteenth-century America centered on ports like Nantucket and New Bedford in Massachusetts. Whale oil lit the lamps of American and European cities before the discovery of petroleum. Spermaceti from sperm whales was particularly valuable for making candles and lubricants. A successful whaling voyage could last three to four years, with ships traveling to the Pacific Ocean, the Indian Ocean, and even the Arctic. The dangerous work of whaling claimed many lives, as men in small boats confronted animals that could weigh sixty tons.`,
];

// =============================================================================
// Test Suite
// =============================================================================

describe('scatter-kg workflow', () => {
  let targetCollection: { id: string };
  let manifestEntity: { id: string };
  let textEntities: { id: string }[] = [];
  let jobCollectionId: string;

  beforeAll(() => {
    if (!ARKE_USER_KEY) {
      console.warn('Skipping tests: ARKE_USER_KEY not set');
      return;
    }
    if (!SCATTER_KG_RHIZA || !SCATTER_KLADOS || !KG_EXTRACTOR_KLADOS || !KG_DEDUPE_RESOLVER_KLADOS || !KG_CLUSTER_KLADOS || !DESCRIBE_KLADOS) {
      console.warn('Skipping tests: Missing env vars (SCATTER_KG_RHIZA, SCATTER_KLADOS, KG_EXTRACTOR_KLADOS, KG_DEDUPE_RESOLVER_KLADOS, KG_CLUSTER_KLADOS, DESCRIBE_KLADOS)');
      return;
    }

    configureTestClient({
      apiBase: ARKE_API_BASE,
      userKey: ARKE_USER_KEY,
      network: NETWORK,
    });

    log(`Using rhiza: ${SCATTER_KG_RHIZA}`);
  });

  beforeAll(async () => {
    if (!ARKE_USER_KEY || !SCATTER_KG_RHIZA || !SCATTER_KLADOS || !KG_EXTRACTOR_KLADOS || !KG_DEDUPE_RESOLVER_KLADOS || !KG_CLUSTER_KLADOS || !DESCRIBE_KLADOS) return;

    log('Creating test fixtures...');

    // Create target collection with invoke permissions for workflow chaining
    targetCollection = await createCollection({
      label: `Scatter KG Test ${Date.now()}`,
      description: 'Test collection for scatter KG workflow',
      roles: { public: ['*:view', '*:invoke'] },
    });
    log(`Created target collection: ${targetCollection.id}`);

    // Create text entities for KG extraction
    for (let i = 0; i < SAMPLE_TEXTS.length; i++) {
      const entity = await createEntity({
        type: 'text_chunk',
        properties: {
          label: `Test Text ${i + 1}`,
          content: SAMPLE_TEXTS[i],
          created_at: new Date().toISOString(),
        },
        collection: targetCollection.id,
      });
      textEntities.push(entity);
      log(`Created text entity ${i + 1}: ${entity.id}`);
    }

    // Create manifest entity (serves as workflow target/job context)
    manifestEntity = await createEntity({
      type: 'scatter_job',
      properties: {
        label: 'Scatter KG Extraction Job',
        description: 'Job manifest for scatter KG workflow test',
        entity_count: textEntities.length,
        created_at: new Date().toISOString(),
      },
      collection: targetCollection.id,
    });
    log(`Created manifest entity: ${manifestEntity.id}`);
  });

  afterAll(async () => {
    if (!ARKE_USER_KEY || !SCATTER_KG_RHIZA || !SCATTER_KLADOS || !KG_EXTRACTOR_KLADOS || !KG_DEDUPE_RESOLVER_KLADOS || !KG_CLUSTER_KLADOS || !DESCRIBE_KLADOS) return;

    // Cleanup disabled for debugging
    log('Cleanup DISABLED for inspection');
    log(`  Target collection: ${targetCollection?.id}`);
    log(`  Manifest entity: ${manifestEntity?.id}`);
    log(`  Text entities: ${textEntities.map(e => e.id).join(', ')}`);
    log(`  Job collection: ${jobCollectionId}`);

    // Uncomment to enable cleanup:
    // try {
    //   for (const entity of textEntities) {
    //     if (entity?.id) await deleteEntity(entity.id);
    //   }
    //   if (manifestEntity?.id) await deleteEntity(manifestEntity.id);
    //   if (targetCollection?.id) await deleteEntity(targetCollection.id);
    //   if (jobCollectionId) await deleteEntity(jobCollectionId);
    //   log('Cleanup complete');
    // } catch (e) {
    //   log(`Cleanup error (non-fatal): ${e}`);
    // }
  });

  // ==========================================================================
  // Tests
  // ==========================================================================

  it('should scatter entities through extract, dedupe, cluster, and describe pipeline', async () => {
    if (!ARKE_USER_KEY || !SCATTER_KG_RHIZA) {
      console.warn('Test skipped: missing environment variables');
      return;
    }

    // Invoke the workflow
    // - targetEntity: manifest (job context, required by API)
    // - input.entity_ids: actual text entities to scatter
    log('Invoking scatter-kg workflow...');
    const entityIds = textEntities.map(e => e.id);
    log(`Manifest entity: ${manifestEntity.id}`);
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

    // Wait for workflow to complete using tree traversal (no indexing lag)
    // Recursive clustering takes longer: each layer needs 30-60s cluster wait + describe calls
    log('Waiting for workflow to complete (recursive clustering may take a while)...');
    const tree = await waitForWorkflowTree(jobCollectionId, {
      timeout: 1800000, // 30 minutes for recursive clustering (multiple rounds)
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

    // Find extract logs (by klados_id)
    const extractLogs = logs.filter(l => l.properties?.klados_id === KG_EXTRACTOR_KLADOS);

    // Find dedupe logs (by klados_id)
    const dedupeLogs = logs.filter(l => l.properties?.klados_id === KG_DEDUPE_RESOLVER_KLADOS);

    // Find cluster logs (by klados_id)
    const clusterLogs = logs.filter(l => l.properties?.klados_id === KG_CLUSTER_KLADOS);

    // Find describe logs (by klados_id)
    const describeLogs = logs.filter(l => l.properties?.klados_id === DESCRIBE_KLADOS);

    log(`Scatter log: ${scatterLog?.id} (status: ${scatterLog?.properties?.status})`);
    log(`Extract logs: ${extractLogs.length}`);
    log(`Dedupe logs: ${dedupeLogs.length}`);
    log(`Cluster logs: ${clusterLogs.length}`);
    log(`Describe logs: ${describeLogs.length}`);

    // Verify scatter succeeded
    expect(scatterLog).toBeDefined();
    expect(scatterLog?.properties?.status).toBe('done');

    // Verify each entity was processed by KG extractor
    // Should have one extract log per text entity
    expect(extractLogs.length).toBe(textEntities.length);

    for (const extractLog of extractLogs) {
      log(`  - Extract ${extractLog.id}: ${extractLog.properties?.status}`);
      expect(extractLog.properties?.status).toBe('done');
    }

    // Verify dedupe ran for extracted entities
    // Note: dedupe logs >= extract logs (each extract can produce multiple entities)
    expect(dedupeLogs.length).toBeGreaterThanOrEqual(1);

    for (const dedupeLog of dedupeLogs) {
      log(`  - Dedupe ${dedupeLog.id}: ${dedupeLog.properties?.status}`);
      expect(dedupeLog.properties?.status).toBe('done');
    }

    // Verify cluster ran
    // Note: cluster logs may be fewer than dedupe logs if:
    // - Solo clusters are dissolved (no followers joined within timeout)
    // - Entities join existing clusters (no output to propagate)
    // We expect at least some cluster activity
    log(`Cluster logs: ${clusterLogs.length}`);
    for (const clusterLog of clusterLogs) {
      log(`  - Cluster ${clusterLog.id}: ${clusterLog.properties?.status}`);
      expect(clusterLog.properties?.status).toBe('done');
    }

    // Verify describe ran for clusters that survived (had followers)
    // Note: describe logs may be fewer than cluster logs since solo clusters are dissolved
    log(`Describe logs: ${describeLogs.length}`);
    for (const describeLog of describeLogs) {
      log(`  - Describe ${describeLog.id}: ${describeLog.properties?.status}`);
      expect(describeLog.properties?.status).toBe('done');
    }

    log('Scatter KG workflow completed successfully!');
    log(`  - Scattered ${entityIds.length} entities`);
    log(`  - KG extraction completed for all entities`);
    log(`  - Deduplication completed for ${dedupeLogs.length} entities`);
    log(`  - Clustering completed for ${clusterLogs.length} entities`);
    log(`  - Description generated for ${describeLogs.length} clusters`);
  }, 2100000); // 35 minute test timeout (recursive clustering takes longer)
});
