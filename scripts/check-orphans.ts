#!/usr/bin/env npx tsx
/**
 * Check for orphaned entities (not part of any cluster)
 *
 * Plan:
 * 1. Fetch all entities from collection
 * 2. Exclude: cluster_leader, text_chunk, scatter_job
 * 3. For each KG entity, fetch full entity and check for summarized_by
 * 4. Report orphans
 */

import { ArkeClient } from '@arke-institute/sdk';

const client = new ArkeClient({
  authToken: process.env.ARKE_USER_KEY || '',
  network: 'test',
});

const collectionId = process.argv[2];

if (!collectionId) {
  console.error('Usage: npx tsx check-orphans.ts <collection_id>');
  process.exit(1);
}

// Types that should NOT have summarized_by (they're not KG entities)
const EXCLUDED_TYPES = ['cluster_leader', 'text_chunk', 'scatter_job'];

interface Entity {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  relationships?: Array<{ predicate: string; peer: string }>;
}

async function checkOrphans() {
  console.log(`Checking collection: ${collectionId}\n`);

  // Step 1: Fetch all entities from collection
  const { data, error } = await client.api.GET('/collections/{id}/entities', {
    params: {
      path: { id: collectionId },
      query: { limit: 500 }
    },
  });

  if (error || !data) {
    console.error('Failed to fetch entities:', error);
    return;
  }

  const allEntities = (data.entities || []) as Entity[];
  console.log(`Total entities in collection: ${allEntities.length}`);

  // Step 2: Filter out excluded types
  const kgEntities = allEntities.filter(e => !EXCLUDED_TYPES.includes(e.type));
  console.log(`KG entities (excluding ${EXCLUDED_TYPES.join(', ')}): ${kgEntities.length}`);

  // Step 3: Check each entity for summarized_by relationship
  let orphaned = 0;
  let clustered = 0;
  const orphanList: Array<{ id: string; type: string; label: string }> = [];

  console.log(`\nChecking ${kgEntities.length} entities...`);

  for (let i = 0; i < kgEntities.length; i++) {
    const entity = kgEntities[i];

    // Fetch full entity to get relationships
    const { data: full, error: fetchErr } = await client.api.GET('/entities/{id}', {
      params: { path: { id: entity.id } },
    });

    if (fetchErr || !full) {
      console.error(`Failed to fetch ${entity.id}`);
      continue;
    }

    const fullEntity = full as Entity;
    const hasSummarizedBy = (fullEntity.relationships || []).some(
      r => r.predicate === 'summarized_by'
    );

    if (hasSummarizedBy) {
      clustered++;
    } else {
      orphaned++;
      orphanList.push({
        id: entity.id,
        type: entity.type,
        label: String(fullEntity.properties?.label || 'unknown'),
      });
    }

    // Progress indicator
    if ((i + 1) % 20 === 0) {
      console.log(`  Checked ${i + 1}/${kgEntities.length}...`);
    }
  }

  // Step 4: Report results
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results:`);
  console.log(`  Clustered: ${clustered}`);
  console.log(`  Orphaned: ${orphaned}`);
  console.log(`${'='.repeat(50)}`);

  if (orphanList.length > 0) {
    console.log(`\nOrphaned entities (no summarized_by):`);
    for (const e of orphanList.slice(0, 30)) {
      console.log(`  - ${e.id} (${e.type}: "${e.label}")`);
    }
    if (orphanList.length > 30) {
      console.log(`  ... and ${orphanList.length - 30} more`);
    }
  } else {
    console.log(`\n✓ All KG entities are part of a cluster!`);
  }
}

checkOrphans().catch(console.error);
