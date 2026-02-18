#!/usr/bin/env npx tsx
/**
 * Investigate an orphaned entity - check its relationships and cluster history
 */

import { ArkeClient } from '@arke-institute/sdk';

const client = new ArkeClient({
  authToken: process.env.ARKE_USER_KEY || '',
  network: 'test',
});

const entityId = process.argv[2];

if (!entityId) {
  console.error('Usage: npx tsx investigate-orphan.ts <entity_id>');
  process.exit(1);
}

async function investigate() {
  console.log(`Investigating entity: ${entityId}\n`);

  // Fetch full entity
  const { data, error } = await client.api.GET('/entities/{id}', {
    params: { path: { id: entityId } },
  });

  if (error || !data) {
    console.error('Failed to fetch entity:', error);
    return;
  }

  console.log('Entity details:');
  console.log(`  Type: ${data.type}`);
  console.log(`  Label: ${data.properties?.label}`);
  console.log(`  _kg_layer: ${data.properties?._kg_layer}`);
  console.log(`  Created: ${data.created_at}`);

  console.log('\nRelationships:');
  const rels = (data as any).relationships || [];
  if (rels.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of rels) {
      console.log(`  - ${r.predicate} → ${r.peer}`);
    }
  }

  // Check if it has summarized_by
  const hasSummarizedBy = rels.some((r: any) => r.predicate === 'summarized_by');
  console.log(`\nHas summarized_by: ${hasSummarizedBy}`);

  // Check if there are any clusters that reference this entity
  console.log('\nSearching for clusters that might reference this entity...');

  // Get the collection from the entity's extracted_from relationship
  const extractedFrom = rels.find((r: any) => r.predicate === 'extracted_from');
  if (extractedFrom) {
    console.log(`  Extracted from: ${extractedFrom.peer}`);
  }
}

investigate().catch(console.error);
