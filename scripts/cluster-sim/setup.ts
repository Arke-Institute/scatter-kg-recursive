#!/usr/bin/env npx tsx
/**
 * Setup script for cluster simulation
 *
 * Fetches entities from a collection and pre-computes similarity matrix
 * so we can run clustering simulations without API calls.
 *
 * Usage: npx tsx scripts/cluster-sim/setup.ts <collection_id>
 */

import { ArkeClient } from '@arke-institute/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new ArkeClient({
  authToken: process.env.ARKE_USER_KEY || '',
  network: 'test',
});

const collectionId = process.argv[2];

if (!collectionId) {
  console.error('Usage: npx tsx scripts/cluster-sim/setup.ts <collection_id>');
  process.exit(1);
}

// Types we don't want to include (not KG entities)
const EXCLUDED_TYPES = ['cluster_leader', 'text_chunk', 'scatter_job'];

interface Entity {
  id: string;
  type: string;
  label: string;
  description?: string;
  _kg_layer: number;
}

interface SimilarityEntry {
  peerId: string;
  score: number;
}

interface SimulationData {
  collectionId: string;
  fetchedAt: string;
  entities: Entity[];
  // For each entity, store top-N similar peers (we'll fetch more than we need)
  similarities: Record<string, SimilarityEntry[]>;
}

interface ListingEntity {
  id: string;
  type: string;
  label?: string;
  properties?: Record<string, unknown>;
}

async function fetchEntities(): Promise<Entity[]> {
  console.log(`Fetching entities from collection: ${collectionId}`);

  const { data, error } = await client.api.GET('/collections/{id}/entities', {
    params: {
      path: { id: collectionId },
      query: { limit: 500 },
    },
  });

  if (error || !data) {
    throw new Error(`Failed to fetch entities: ${JSON.stringify(error)}`);
  }

  const allEntities = (data.entities || []) as ListingEntity[];
  console.log(`Total entities in collection: ${allEntities.length}`);

  // Filter out excluded types
  const kgEntities = allEntities.filter(e => !EXCLUDED_TYPES.includes(e.type));
  console.log(`KG entities (excluding ${EXCLUDED_TYPES.join(', ')}): ${kgEntities.length}`);

  // Fetch full entities to get descriptions
  console.log(`Fetching full entity details...`);
  const entities: Entity[] = [];

  for (let i = 0; i < kgEntities.length; i++) {
    const listing = kgEntities[i];

    const { data: full, error: fetchError } = await client.api.GET('/entities/{id}', {
      params: { path: { id: listing.id } },
    });

    if (fetchError || !full) {
      console.error(`  Failed to fetch ${listing.id}`);
      continue;
    }

    entities.push({
      id: full.id,
      type: full.type,
      label: (full.properties?.label as string) || listing.label || '',
      description: full.properties?.description as string | undefined,
      _kg_layer: (full.properties?._kg_layer as number) ?? 0,
    });

    if ((i + 1) % 20 === 0 || i === kgEntities.length - 1) {
      console.log(`  [${i + 1}/${kgEntities.length}] Fetched entity details`);
    }
  }

  return entities;
}

async function computeSimilarities(
  entities: Entity[],
  topN: number = 20
): Promise<Record<string, SimilarityEntry[]>> {
  console.log(`\nComputing similarities for ${entities.length} entities (top ${topN} each)...`);

  const similarities: Record<string, SimilarityEntry[]> = {};

  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];

    // Build query from label and description
    const queryParts: string[] = [];
    if (entity.label) queryParts.push(entity.label);
    if (entity.description) queryParts.push(entity.description);
    const query = queryParts.join(' ').trim();

    if (!query) {
      console.log(`  [${i + 1}/${entities.length}] ${entity.id}: no query text, skipping`);
      similarities[entity.id] = [];
      continue;
    }

    // Semantic search filtered by layer
    const { data, error } = await (client.api.POST as Function)('/search/entities', {
      body: {
        collection_id: collectionId,
        query,
        filter: { _kg_layer: entity._kg_layer },
        limit: topN + 1, // Extra to account for self
        expand: 'preview',
      },
    });

    if (error || !data) {
      console.error(`  [${i + 1}/${entities.length}] ${entity.id}: search failed`);
      similarities[entity.id] = [];
      continue;
    }

    const results = (data.results || []) as Array<{ id: string; score: number }>;

    // Filter out self, map to similarity entries
    similarities[entity.id] = results
      .filter(r => r.id !== entity.id)
      .map(r => ({ peerId: r.id, score: r.score }))
      .slice(0, topN);

    if ((i + 1) % 10 === 0 || i === entities.length - 1) {
      console.log(`  [${i + 1}/${entities.length}] Computed similarities`);
    }
  }

  return similarities;
}

async function main() {
  const entities = await fetchEntities();

  if (entities.length === 0) {
    console.error('No KG entities found in collection');
    process.exit(1);
  }

  // Show some sample entities
  console.log('\nSample entities:');
  for (const e of entities.slice(0, 5)) {
    console.log(`  - ${e.label} (${e.type}, layer ${e._kg_layer})`);
  }

  const similarities = await computeSimilarities(entities);

  const data: SimulationData = {
    collectionId,
    fetchedAt: new Date().toISOString(),
    entities,
    similarities,
  };

  // Save to data directory
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const outPath = path.join(dataDir, 'simulation-data.json');

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\nSaved simulation data to: ${outPath}`);
  console.log(`  - ${entities.length} entities`);
  console.log(`  - ${Object.keys(similarities).length} similarity lists`);

  // Print some stats
  const layerCounts: Record<number, number> = {};
  for (const e of entities) {
    layerCounts[e._kg_layer] = (layerCounts[e._kg_layer] || 0) + 1;
  }
  console.log(`\nEntities by layer:`);
  for (const [layer, count] of Object.entries(layerCounts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  Layer ${layer}: ${count} entities`);
  }

  // Print similarity stats
  let totalSims = 0;
  let entitiesWithSims = 0;
  for (const [_, sims] of Object.entries(similarities)) {
    if (sims.length > 0) {
      totalSims += sims.length;
      entitiesWithSims++;
    }
  }
  console.log(`\nSimilarity stats:`);
  console.log(`  Entities with similarities: ${entitiesWithSims}`);
  console.log(`  Avg similarities per entity: ${entitiesWithSims > 0 ? (totalSims / entitiesWithSims).toFixed(1) : 0}`);
}

main().catch(console.error);
