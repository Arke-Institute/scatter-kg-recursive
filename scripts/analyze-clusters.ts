#!/usr/bin/env npx tsx
/**
 * Analyze clustering hierarchy by following summarized_by relationships
 *
 * Usage: tsx scripts/analyze-clusters.ts <collection_id>
 *
 * This script:
 * 1. Fetches all entities in the target collection
 * 2. Builds a hierarchy by following summarized_by relationships
 * 3. Prints a tree visualization
 * 4. Shows layer breakdown and identifies solo clusters
 */

import { ArkeClient } from '@arke-institute/sdk';

const client = new ArkeClient({
  authToken: process.env.ARKE_USER_KEY || '',
  network: 'test',
});

interface EntityNode {
  id: string;
  label: string;
  type: string;
  layer: number;
  summarizedBy?: string; // parent cluster ID
  children: string[];    // entities that point to this as summarized_by
}

interface Relationship {
  peer: string;
  predicate: string;
  peer_type?: string;
}

async function main() {
  const collectionId = process.argv[2];
  if (!collectionId) {
    console.error('Usage: tsx scripts/analyze-clusters.ts <collection_id>');
    console.error('\nExample: tsx scripts/analyze-clusters.ts IIKHVB6Z64T0G98CYJB13A41KJ');
    process.exit(1);
  }

  console.log(`\nAnalyzing cluster hierarchy for collection: ${collectionId}\n`);

  // 1. Fetch all entities
  const entities = await fetchAllEntities(collectionId);
  console.log(`Found ${entities.size} entities\n`);

  // 2. Build hierarchy by following summarized_by
  buildHierarchy(entities);

  // 3. Print layer breakdown
  printLayerBreakdown(entities);

  // 4. Print tree visualization
  printTree(entities);

  // 5. Identify solo clusters
  identifySoloClusters(entities);
}

async function fetchAllEntities(collectionId: string): Promise<Map<string, EntityNode>> {
  const entities = new Map<string, EntityNode>();
  let cursor: string | undefined;

  // Fetch all entities from collection
  do {
    const { data, error } = await client.api.GET('/collections/{id}/entities', {
      params: {
        path: { id: collectionId },
        query: { limit: 200, cursor },
      },
    });

    if (error || !data) {
      console.error('Failed to fetch entities:', error);
      break;
    }

    const batch = (data.entities || []) as Array<{ id: string; type: string }>;

    // Fetch full details for each entity
    for (const e of batch) {
      const { data: full } = await client.api.GET('/entities/{id}', {
        params: { path: { id: e.id } },
      });

      if (full) {
        const relationships = (full as any).relationships as Relationship[] || [];
        const summarizedByRel = relationships.find(r => r.predicate === 'summarized_by');

        entities.set(e.id, {
          id: e.id,
          label: (full.properties?.label as string) || e.id.slice(-8),
          type: full.type || e.type,
          layer: (full.properties?._kg_layer as number) ?? 0,
          summarizedBy: summarizedByRel?.peer,
          children: [],
        });
      }
    }

    cursor = data.cursor;
    process.stdout.write(`\rFetched ${entities.size} entities...`);
  } while (cursor);

  console.log(''); // newline after progress
  return entities;
}

function buildHierarchy(entities: Map<string, EntityNode>): void {
  // Link children to parents
  for (const entity of entities.values()) {
    if (entity.summarizedBy) {
      const parent = entities.get(entity.summarizedBy);
      if (parent) {
        parent.children.push(entity.id);
      }
    }
  }
}

function printLayerBreakdown(entities: Map<string, EntityNode>): void {
  const layers = new Map<number, EntityNode[]>();

  for (const entity of entities.values()) {
    const layer = entity.layer;
    if (!layers.has(layer)) {
      layers.set(layer, []);
    }
    layers.get(layer)!.push(entity);
  }

  console.log('='.repeat(60));
  console.log('LAYER BREAKDOWN');
  console.log('='.repeat(60));

  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);
  for (const layer of sortedLayers) {
    const layerEntities = layers.get(layer)!;
    const types = new Map<string, number>();
    for (const e of layerEntities) {
      types.set(e.type, (types.get(e.type) || 0) + 1);
    }

    const typeStr = [...types.entries()]
      .map(([t, c]) => `${t}: ${c}`)
      .join(', ');

    console.log(`Layer ${layer}: ${layerEntities.length} entities (${typeStr})`);
  }
  console.log('');
}

function printTree(entities: Map<string, EntityNode>): void {
  console.log('='.repeat(60));
  console.log('CLUSTER HIERARCHY (top-down from roots)');
  console.log('='.repeat(60));

  // Find roots (entities with no summarized_by OR highest layer)
  const maxLayer = Math.max(...[...entities.values()].map(e => e.layer));

  // Get all entities at max layer as roots
  const roots = [...entities.values()]
    .filter(e => e.layer === maxLayer)
    .sort((a, b) => a.label.localeCompare(b.label));

  if (roots.length === 0) {
    console.log('No root clusters found');
    return;
  }

  console.log(`\nFound ${roots.length} root(s) at layer ${maxLayer}:\n`);

  for (const root of roots) {
    printNode(entities, root, 0);
    console.log('');
  }
}

function printNode(entities: Map<string, EntityNode>, node: EntityNode, depth: number): void {
  const indent = '  '.repeat(depth);
  const childCount = node.children.length;
  const soloMarker = childCount === 1 ? ' [SOLO]' : '';

  console.log(`${indent}├─ [L${node.layer}] ${node.label} (${node.type})${soloMarker}`);
  console.log(`${indent}│  ID: ${node.id}`);

  if (childCount > 0) {
    console.log(`${indent}│  Members: ${childCount}`);

    // Sort children by layer (descending) then label
    const children = node.children
      .map(id => entities.get(id))
      .filter((e): e is EntityNode => e !== undefined)
      .sort((a, b) => b.layer - a.layer || a.label.localeCompare(b.label));

    for (const child of children) {
      printNode(entities, child, depth + 1);
    }
  }
}

function identifySoloClusters(entities: Map<string, EntityNode>): void {
  console.log('='.repeat(60));
  console.log('SOLO CLUSTERS (clusters with only 1 member that recursed)');
  console.log('='.repeat(60));

  const soloClusters: EntityNode[] = [];

  for (const entity of entities.values()) {
    // A solo cluster is one that:
    // 1. Has children (is a cluster)
    // 2. Has exactly 1 child
    // 3. Its child is also a cluster (recursed up)
    if (entity.children.length === 1) {
      const child = entities.get(entity.children[0]);
      if (child && child.type === 'cluster_leader') {
        soloClusters.push(entity);
      }
    }
  }

  if (soloClusters.length === 0) {
    console.log('\nNo solo clusters found (good!)');
  } else {
    console.log(`\nFound ${soloClusters.length} solo clusters:\n`);
    for (const cluster of soloClusters.sort((a, b) => b.layer - a.layer)) {
      const child = entities.get(cluster.children[0]);
      console.log(`  [L${cluster.layer}] ${cluster.label}`);
      console.log(`    ID: ${cluster.id}`);
      console.log(`    Sole member: ${child?.label} (${child?.type})`);
      console.log('');
    }
  }

  // Also check for clusters that have exactly 1 member of any type
  console.log('-'.repeat(60));
  console.log('ALL SINGLE-MEMBER CLUSTERS:');
  console.log('-'.repeat(60));

  const singleMember = [...entities.values()]
    .filter(e => e.children.length === 1)
    .sort((a, b) => b.layer - a.layer);

  if (singleMember.length === 0) {
    console.log('\nNone found');
  } else {
    console.log(`\nFound ${singleMember.length} single-member clusters:\n`);
    for (const cluster of singleMember) {
      const child = entities.get(cluster.children[0]);
      console.log(`  [L${cluster.layer}] ${cluster.label} → ${child?.label}`);
    }
  }
}

main().catch(console.error);
