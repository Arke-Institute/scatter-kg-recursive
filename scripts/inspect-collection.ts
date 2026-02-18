#!/usr/bin/env npx tsx
import { ArkeClient } from '@arke-institute/sdk';

const client = new ArkeClient({
  authToken: process.env.ARKE_USER_KEY || '',
  network: 'test',
});

const collectionId = process.argv[2] || 'IIKHP7KZPCDG9WMX98X2EFH5MS';

interface Entity {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
}

async function inspect() {
  console.log(`Inspecting collection: ${collectionId}\n`);

  const { data, error } = await client.api.GET('/collections/{id}/entities', {
    params: {
      path: { id: collectionId },
      query: { limit: 200 }
    },
  });

  if (error || !data) {
    console.error('Failed:', error);
    return;
  }

  const entities = (data.entities || []) as Entity[];
  console.log('Total entities:', entities.length);

  // Count by type
  const typeCounts = new Map<string, number>();
  for (const e of entities) {
    const type = e.type || 'unknown';
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }

  console.log('\nBy type:');
  for (const [type, count] of typeCounts) {
    console.log(`  ${type}: ${count}`);
  }

  // Check _kg_layer on a few entities
  console.log('\nSample entities with full fetch:');
  const sampleTypes = ['person', 'city', 'whaling_ship', 'fictional_whale'];

  for (const e of entities.slice(0, 30)) {
    if (sampleTypes.includes(e.type)) {
      const { data: full } = await client.api.GET('/entities/{id}', {
        params: { path: { id: e.id } },
      });

      if (full) {
        const hasLayer = full.properties?._kg_layer !== undefined;
        const hasSummarizedBy = ((full as any).relationships || []).some(
          (r: any) => r.predicate === 'summarized_by'
        );
        console.log(`  ${e.type}: ${e.id}`);
        console.log(`    label: ${full.properties?.label}`);
        console.log(`    _kg_layer: ${full.properties?._kg_layer} (has: ${hasLayer})`);
        console.log(`    summarized_by: ${hasSummarizedBy}`);

        // Remove from sampleTypes to show one of each
        const idx = sampleTypes.indexOf(e.type);
        if (idx > -1) sampleTypes.splice(idx, 1);
      }
    }

    if (sampleTypes.length === 0) break;
  }
}

inspect().catch(console.error);
