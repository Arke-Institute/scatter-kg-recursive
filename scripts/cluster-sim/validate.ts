#!/usr/bin/env npx tsx
/**
 * Validate simulation results for integrity
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load simulation data
const dataPath = path.join(__dirname, 'data', 'simulation-data.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

console.log(`Loaded ${data.entities.length} entities\n`);

interface Entity {
  id: string;
  type: string;
  label: string;
  _kg_layer: number;
}

interface SimilarityEntry {
  peerId: string;
  score: number;
}

// Seeded random
function seededRandom(seed: number): () => number {
  return function() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function shuffle<T>(array: T[], random: () => number): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Run simulation with seed 42
const seed = 42;
const random = seededRandom(seed);
const entities: Entity[] = data.entities;
const similarities: Record<string, SimilarityEntry[]> = data.similarities;

// Config
const k = 5;
const arrivalSpreadMs = 100;
const indexDelayMs = 1000;
const recheckDelayMs = 10000;
const followerWaitMinMs = 30000;
const followerWaitMaxMs = 90000;

// State
const entityStates = new Map<string, {
  clusterId: string | null;
  indexed: boolean;
}>();

const clusters = new Map<string, {
  id: string;
  members: Set<string>;
}>();

let nextClusterId = 1;

// Initialize
for (const e of entities) {
  entityStates.set(e.id, { clusterId: null, indexed: false });
}

// Event queue
interface Event {
  time: number;
  type: string;
  entityId: string;
  clusterId?: string;
}

const events: Event[] = [];

function scheduleEvent(e: Event) {
  events.push(e);
  events.sort((a, b) => a.time - b.time);
}

// Schedule arrivals
const shuffled = shuffle(entities, random);
for (let i = 0; i < shuffled.length; i++) {
  const arrivalTime = Math.floor((i / shuffled.length) * arrivalSpreadMs);
  scheduleEvent({ time: arrivalTime, type: 'arrives', entityId: shuffled[i].id });
}

// Process events
let currentTime = 0;

function getVisiblePeers(entityId: string, layer: number): SimilarityEntry[] {
  const sims = similarities[entityId] || [];
  return sims
    .filter(s => {
      const peer = entities.find(e => e.id === s.peerId);
      if (!peer || peer._kg_layer !== layer) return false;
      const peerState = entityStates.get(s.peerId);
      return peerState?.indexed === true;
    })
    .slice(0, k);
}

function findClusteredPeer(peers: SimilarityEntry[]): { peerId: string; clusterId: string } | null {
  for (const p of peers) {
    const state = entityStates.get(p.peerId);
    if (state?.clusterId) {
      return { peerId: p.peerId, clusterId: state.clusterId };
    }
  }
  return null;
}

function createCluster(leaderId: string): string {
  const id = `cluster_${nextClusterId++}`;
  clusters.set(id, { id, members: new Set([leaderId]) });
  return id;
}

function joinCluster(entityId: string, clusterId: string) {
  const cluster = clusters.get(clusterId);
  if (cluster) {
    cluster.members.add(entityId);
  }
  const state = entityStates.get(entityId)!;
  state.clusterId = clusterId;
}

function leaveCluster(entityId: string, clusterId: string) {
  const cluster = clusters.get(clusterId);
  if (cluster) {
    cluster.members.delete(entityId);
    if (cluster.members.size === 0) {
      clusters.delete(clusterId);
    }
  }
}

function getJitteryWait(): number {
  return followerWaitMinMs + Math.floor(random() * (followerWaitMaxMs - followerWaitMinMs));
}

while (events.length > 0) {
  const event = events.shift()!;
  currentTime = event.time;
  const state = entityStates.get(event.entityId)!;
  const entity = entities.find(e => e.id === event.entityId)!;

  switch (event.type) {
    case 'arrives': {
      scheduleEvent({ time: currentTime + indexDelayMs, type: 'indexed', entityId: event.entityId });
      scheduleEvent({ time: currentTime, type: 'searches', entityId: event.entityId });
      break;
    }

    case 'indexed': {
      state.indexed = true;
      break;
    }

    case 'searches': {
      const peers = getVisiblePeers(event.entityId, entity._kg_layer);
      if (peers.length === 0) {
        const clusterId = createCluster(event.entityId);
        state.clusterId = clusterId;
        const jitter = getJitteryWait();
        scheduleEvent({ time: currentTime + jitter, type: 'follower_wait_ends', entityId: event.entityId, clusterId });
      } else {
        const clusteredPeer = findClusteredPeer(peers);
        if (clusteredPeer) {
          joinCluster(event.entityId, clusteredPeer.clusterId);
        } else {
          scheduleEvent({ time: currentTime + recheckDelayMs, type: 'rechecks', entityId: event.entityId });
        }
      }
      break;
    }

    case 'rechecks': {
      const peers = getVisiblePeers(event.entityId, entity._kg_layer);
      const clusteredPeer = findClusteredPeer(peers);
      if (clusteredPeer) {
        joinCluster(event.entityId, clusteredPeer.clusterId);
      } else {
        const clusterId = createCluster(event.entityId);
        state.clusterId = clusterId;
        const jitter = getJitteryWait();
        scheduleEvent({ time: currentTime + jitter, type: 'follower_wait_ends', entityId: event.entityId, clusterId });
      }
      break;
    }

    case 'follower_wait_ends': {
      const myClusterId = event.clusterId!;
      const cluster = clusters.get(myClusterId);
      if (cluster && cluster.members.size === 1) {
        // Solo cluster - run semantic fallback
        const allSims = similarities[event.entityId] || [];
        const visiblePeers = allSims.filter(s => {
          const peer = entities.find(e => e.id === s.peerId);
          if (!peer || peer._kg_layer !== entity._kg_layer) return false;
          return entityStates.get(s.peerId)?.indexed === true;
        });

        for (const peer of visiblePeers) {
          const peerState = entityStates.get(peer.peerId);
          if (peerState?.clusterId && peerState.clusterId !== myClusterId) {
            // Leave my cluster and join theirs
            leaveCluster(event.entityId, myClusterId);
            state.clusterId = null;
            joinCluster(event.entityId, peerState.clusterId);
            break;
          }
        }
      }
      break;
    }
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

console.log('='.repeat(60));
console.log('VALIDATION RESULTS');
console.log('='.repeat(60));

let errors = 0;

// Check 1: Every entity should be in exactly one cluster
console.log('\n1. Checking each entity is in exactly one cluster...');
const entityClusterCount = new Map<string, string[]>();
for (const [clusterId, cluster] of clusters) {
  for (const memberId of cluster.members) {
    if (!entityClusterCount.has(memberId)) {
      entityClusterCount.set(memberId, []);
    }
    entityClusterCount.get(memberId)!.push(clusterId);
  }
}

let inMultiple = 0;
let inNone = 0;
for (const entity of entities) {
  const clusterList = entityClusterCount.get(entity.id) || [];
  if (clusterList.length === 0) {
    inNone++;
  } else if (clusterList.length > 1) {
    inMultiple++;
    console.log(`  ERROR: ${entity.label} (${entity.id}) is in ${clusterList.length} clusters: ${clusterList.join(', ')}`);
    errors++;
  }
}
console.log(`  Entities in no cluster: ${inNone}`);
console.log(`  Entities in multiple clusters: ${inMultiple}`);
console.log(`  Result: ${inMultiple === 0 ? 'PASS' : 'FAIL'}`);

// Check 2: Entity state clusterId matches cluster membership
console.log('\n2. Checking entity state matches cluster membership...');
let mismatches = 0;
for (const entity of entities) {
  const state = entityStates.get(entity.id)!;
  const clusterList = entityClusterCount.get(entity.id) || [];

  if (state.clusterId && clusterList.length === 0) {
    console.log(`  ERROR: ${entity.label} state says cluster=${state.clusterId} but not in members`);
    mismatches++;
    errors++;
  }
  if (!state.clusterId && clusterList.length > 0) {
    console.log(`  ERROR: ${entity.label} state says no cluster but is in ${clusterList.join(', ')}`);
    mismatches++;
    errors++;
  }
  if (state.clusterId && clusterList.length === 1 && state.clusterId !== clusterList[0]) {
    console.log(`  ERROR: ${entity.label} state says cluster=${state.clusterId} but is in ${clusterList[0]}`);
    mismatches++;
    errors++;
  }
}
console.log(`  Mismatches: ${mismatches}`);
console.log(`  Result: ${mismatches === 0 ? 'PASS' : 'FAIL'}`);

// Check 3: No duplicate entity IDs in any cluster
console.log('\n3. Checking no duplicates within clusters...');
let duplicates = 0;
for (const [clusterId, cluster] of clusters) {
  const memberArray = Array.from(cluster.members);
  const uniqueMembers = new Set(memberArray);
  if (memberArray.length !== uniqueMembers.size) {
    console.log(`  ERROR: Cluster ${clusterId} has duplicate members!`);
    duplicates++;
    errors++;
  }
}
console.log(`  Clusters with duplicates: ${duplicates}`);
console.log(`  Result: ${duplicates === 0 ? 'PASS' : 'FAIL'}`);

// Check 4: All cluster members exist as entities
console.log('\n4. Checking all cluster members are valid entities...');
const entityIds = new Set(entities.map(e => e.id));
let invalidMembers = 0;
for (const [clusterId, cluster] of clusters) {
  for (const memberId of cluster.members) {
    if (!entityIds.has(memberId)) {
      console.log(`  ERROR: Cluster ${clusterId} has unknown member ${memberId}`);
      invalidMembers++;
      errors++;
    }
  }
}
console.log(`  Invalid members: ${invalidMembers}`);
console.log(`  Result: ${invalidMembers === 0 ? 'PASS' : 'FAIL'}`);

// Check 5: Total members across clusters
console.log('\n5. Checking total cluster membership...');
let totalMembers = 0;
for (const cluster of clusters.values()) {
  totalMembers += cluster.members.size;
}
const clusteredEntities = Array.from(entityStates.values()).filter(s => s.clusterId !== null).length;
const unclustered = entities.length - clusteredEntities;
console.log(`  Total entities: ${entities.length}`);
console.log(`  Total cluster members (sum): ${totalMembers}`);
console.log(`  Entities with clusterId set: ${clusteredEntities}`);
console.log(`  Unclustered entities: ${unclustered}`);

// Check 6: Summary stats
console.log('\n6. Summary stats...');
const clusterSizes = Array.from(clusters.values()).map(c => c.members.size).sort((a, b) => a - b);
console.log(`  Total clusters: ${clusters.size}`);
console.log(`  Avg size: ${clusters.size > 0 ? (totalMembers / clusters.size).toFixed(2) : 0}`);
console.log(`  Max size: ${clusterSizes.length > 0 ? clusterSizes[clusterSizes.length - 1] : 0}`);
console.log(`  Min size: ${clusterSizes.length > 0 ? clusterSizes[0] : 0}`);
console.log(`  Singletons (size=1): ${clusterSizes.filter(s => s === 1).length}`);

// Size distribution
console.log('\n  Size distribution:');
const distribution: Record<number, number> = {};
for (const size of clusterSizes) {
  distribution[size] = (distribution[size] || 0) + 1;
}
for (const size of Object.keys(distribution).map(Number).sort((a, b) => a - b)) {
  console.log(`    Size ${size}: ${distribution[size]} clusters`);
}

console.log('\n' + '='.repeat(60));
if (errors === 0) {
  console.log('ALL VALIDATIONS PASSED');
} else {
  console.log(`TOTAL ERRORS: ${errors}`);
}
console.log('='.repeat(60));
