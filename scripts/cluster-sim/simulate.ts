#!/usr/bin/env npx tsx
/**
 * Cluster Simulation
 *
 * Simulates the clustering algorithm with temporal dynamics:
 * - Entities arrive at different times
 * - Semantic search only finds entities that have been "indexed"
 * - Simulates delays (recheck, follower wait with jitter)
 * - Models race conditions
 * - Semantic fallback before lexicographic fallback
 *
 * Usage: npx tsx scripts/cluster-sim/simulate.ts [options]
 *
 * Options:
 *   --k=N                  Semantic search limit (default: 5)
 *   --arrival-spread=N     Time spread for entity arrivals in ms (default: 5000)
 *   --index-delay=N        Delay before entity appears in search in ms (default: 1000)
 *   --recheck-delay=N      Delay before re-checking peers in ms (default: 10000)
 *   --follower-wait-min=N  Min time to wait for followers in ms (default: 30000)
 *   --follower-wait-max=N  Max time to wait for followers in ms (default: 90000)
 *   --seed=N               Random seed for reproducibility
 *   --verbose              Print detailed logs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types
// ============================================================================

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
  similarities: Record<string, SimilarityEntry[]>;
}

interface SimConfig {
  k: number;
  arrivalSpreadMs: number;
  indexDelayMs: number;
  recheckDelayMs: number;
  followerWaitMinMs: number;
  followerWaitMaxMs: number;
  seed: number;
  verbose: boolean;
}

// Event types for discrete event simulation
type EventType =
  | 'entity_arrives'
  | 'entity_indexed'
  | 'entity_searches'
  | 'entity_rechecks'
  | 'entity_creates_cluster'
  | 'entity_joins_cluster'
  | 'follower_wait_ends';

interface Event {
  time: number;
  type: EventType;
  entityId: string;
  data?: Record<string, unknown>;
}

// Entity state during simulation
interface EntityState {
  arrived: boolean;
  indexed: boolean;
  clusterId: string | null;
  isClusterLeader: boolean;
  processing: boolean;
  waitingForFollowers: boolean;
  followerWaitStartTime: number | null;
}

// Cluster state
interface ClusterState {
  id: string;
  leaderId: string;
  members: Set<string>;
  createdAt: number;
}

// ============================================================================
// Seeded Random
// ============================================================================

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

// ============================================================================
// Simulation Engine
// ============================================================================

class ClusterSimulation {
  private config: SimConfig;
  private entities: Entity[];
  private similarities: Record<string, SimilarityEntry[]>;
  private random: () => number;

  // State
  private entityStates: Map<string, EntityState> = new Map();
  private clusters: Map<string, ClusterState> = new Map();
  private eventQueue: Event[] = [];
  private currentTime: number = 0;
  private nextClusterId: number = 1;

  constructor(data: SimulationData, config: SimConfig) {
    this.config = config;
    this.entities = data.entities;
    this.similarities = data.similarities;
    this.random = seededRandom(config.seed);

    // Initialize entity states
    for (const entity of this.entities) {
      this.entityStates.set(entity.id, {
        arrived: false,
        indexed: false,
        clusterId: null,
        isClusterLeader: false,
        processing: false,
        waitingForFollowers: false,
        followerWaitStartTime: null,
      });
    }
  }

  private log(msg: string) {
    if (this.config.verbose) {
      console.log(`[${this.currentTime}ms] ${msg}`);
    }
  }

  private scheduleEvent(event: Event) {
    this.eventQueue.push(event);
    // Keep sorted by time
    this.eventQueue.sort((a, b) => a.time - b.time);
  }

  private getVisiblePeers(entityId: string, layer: number): SimilarityEntry[] {
    const sims = this.similarities[entityId] || [];

    // Filter to:
    // 1. Same layer
    // 2. Already indexed (visible in search)
    // 3. Limit to top K
    return sims
      .filter(s => {
        const peer = this.entities.find(e => e.id === s.peerId);
        if (!peer || peer._kg_layer !== layer) return false;
        const peerState = this.entityStates.get(s.peerId);
        return peerState?.indexed === true;
      })
      .slice(0, this.config.k);
  }

  private findClusteredPeer(peers: SimilarityEntry[]): { peerId: string; clusterId: string } | null {
    for (const peer of peers) {
      const peerState = this.entityStates.get(peer.peerId);
      if (peerState?.clusterId) {
        return { peerId: peer.peerId, clusterId: peerState.clusterId };
      }
    }
    return null;
  }

  private createCluster(leaderId: string): string {
    const clusterId = `cluster_${this.nextClusterId++}`;
    this.clusters.set(clusterId, {
      id: clusterId,
      leaderId,
      members: new Set([leaderId]),
      createdAt: this.currentTime,
    });
    return clusterId;
  }

  private joinCluster(entityId: string, clusterId: string) {
    const cluster = this.clusters.get(clusterId);
    if (cluster) {
      cluster.members.add(entityId);
    }
    const state = this.entityStates.get(entityId)!;
    state.clusterId = clusterId;
  }

  private getJitteryWait(): number {
    const range = this.config.followerWaitMaxMs - this.config.followerWaitMinMs;
    return this.config.followerWaitMinMs + Math.floor(this.random() * range);
  }

  private processEvent(event: Event) {
    const state = this.entityStates.get(event.entityId)!;
    const entity = this.entities.find(e => e.id === event.entityId)!;

    switch (event.type) {
      case 'entity_arrives': {
        state.arrived = true;
        this.log(`${entity.label} (${entity.id}) arrives`);

        // Schedule indexing
        this.scheduleEvent({
          time: this.currentTime + this.config.indexDelayMs,
          type: 'entity_indexed',
          entityId: event.entityId,
        });

        // Start processing (search for peers)
        this.scheduleEvent({
          time: this.currentTime,
          type: 'entity_searches',
          entityId: event.entityId,
        });
        break;
      }

      case 'entity_indexed': {
        state.indexed = true;
        this.log(`${entity.label} (${entity.id}) now indexed/searchable`);
        break;
      }

      case 'entity_searches': {
        state.processing = true;
        const peers = this.getVisiblePeers(event.entityId, entity._kg_layer);
        this.log(`${entity.label} searches, finds ${peers.length} visible peers`);

        if (peers.length === 0) {
          // No peers visible yet - create cluster immediately and wait for followers
          this.log(`${entity.label} - no peers, creating cluster`);
          const clusterId = this.createCluster(event.entityId);
          state.clusterId = clusterId;
          state.isClusterLeader = true;
          state.waitingForFollowers = true;
          state.followerWaitStartTime = this.currentTime;

          // JITTERY WAIT
          const jitteryWait = this.getJitteryWait();
          this.log(`${entity.label} - waiting ${jitteryWait}ms for followers (jittery)`);

          this.scheduleEvent({
            time: this.currentTime + jitteryWait,
            type: 'follower_wait_ends',
            entityId: event.entityId,
            data: { clusterId },
          });
        } else {
          // Check if any peer has a cluster
          const clusteredPeer = this.findClusteredPeer(peers);

          if (clusteredPeer) {
            // Join existing cluster
            this.log(`${entity.label} - found cluster via ${clusteredPeer.peerId}, joining`);
            this.joinCluster(event.entityId, clusteredPeer.clusterId);
            state.processing = false;
          } else {
            // No clustered peers yet - schedule recheck
            this.log(`${entity.label} - no clustered peers, scheduling recheck`);
            this.scheduleEvent({
              time: this.currentTime + this.config.recheckDelayMs,
              type: 'entity_rechecks',
              entityId: event.entityId,
              data: { peers: peers.map(p => p.peerId) },
            });
          }
        }
        break;
      }

      case 'entity_rechecks': {
        const peers = this.getVisiblePeers(event.entityId, entity._kg_layer);
        this.log(`${entity.label} rechecks, finds ${peers.length} visible peers`);

        const clusteredPeer = this.findClusteredPeer(peers);

        if (clusteredPeer) {
          // Join existing cluster
          this.log(`${entity.label} - found cluster on recheck via ${clusteredPeer.peerId}, joining`);
          this.joinCluster(event.entityId, clusteredPeer.clusterId);
          state.processing = false;
        } else {
          // Still no cluster - create own and wait
          this.log(`${entity.label} - still no cluster, creating own`);
          const clusterId = this.createCluster(event.entityId);
          state.clusterId = clusterId;
          state.isClusterLeader = true;
          state.waitingForFollowers = true;
          state.followerWaitStartTime = this.currentTime;

          // JITTERY WAIT
          const jitteryWait = this.getJitteryWait();
          this.log(`${entity.label} - waiting ${jitteryWait}ms for followers (jittery)`);

          this.scheduleEvent({
            time: this.currentTime + jitteryWait,
            type: 'follower_wait_ends',
            entityId: event.entityId,
            data: { clusterId },
          });
        }
        break;
      }

      case 'follower_wait_ends': {
        const clusterId = event.data?.clusterId as string;
        const cluster = this.clusters.get(clusterId);
        state.waitingForFollowers = false;
        state.processing = false;

        if (cluster) {
          const memberCount = cluster.members.size;
          if (memberCount > 1) {
            this.log(`${entity.label} - cluster ${clusterId} has ${memberCount} members, keeping`);
          } else {
            this.log(`${entity.label} - cluster ${clusterId} is solo, running fallback`);
            this.runFallback(event.entityId, clusterId, entity._kg_layer);
          }
        }
        break;
      }
    }
  }

  /**
   * Improved fallback with semantic search first, then lexicographic
   */
  private runFallback(entityId: string, myClusterId: string, layer: number) {
    const myState = this.entityStates.get(entityId)!;
    const entity = this.entities.find(e => e.id === entityId)!;

    // =========================================================================
    // STEP 1: SEMANTIC FALLBACK (entities should be indexed by now)
    // =========================================================================
    this.log(`Fallback step 1: semantic search for ${entity.label}`);

    // Get ALL visible peers (not limited by K) since we're in fallback
    const allSims = this.similarities[entityId] || [];
    const visibleSemanticPeers = allSims.filter(s => {
      const peer = this.entities.find(e => e.id === s.peerId);
      if (!peer || peer._kg_layer !== layer) return false;
      const peerState = this.entityStates.get(s.peerId);
      return peerState?.indexed === true;
    });

    this.log(`  Found ${visibleSemanticPeers.length} semantically similar peers (indexed)`);

    // Check if any semantically similar peer has a cluster (that's not mine)
    for (const peer of visibleSemanticPeers) {
      const peerState = this.entityStates.get(peer.peerId);
      if (peerState?.clusterId && peerState.clusterId !== myClusterId) {
        // Found semantically similar peer with different cluster - join them
        this.log(`  Found similar peer ${peer.peerId} in cluster ${peerState.clusterId}, joining`);

        // Remove from my cluster
        const myCluster = this.clusters.get(myClusterId);
        if (myCluster) {
          myCluster.members.delete(entityId);
          if (myCluster.members.size === 0) {
            this.clusters.delete(myClusterId);
          }
        }

        // Join their cluster
        this.joinCluster(entityId, peerState.clusterId);
        myState.isClusterLeader = false;
        return;
      }
    }

    this.log(`  No semantically similar clustered peers found`);

    // =========================================================================
    // STEP 2: LEXICOGRAPHIC FALLBACK (last resort)
    // =========================================================================
    this.log(`Fallback step 2: lexicographic check for ${entity.label}`);

    // Get all entities at same layer, sorted by ID
    const layerEntities = this.entities
      .filter(e => e._kg_layer === layer)
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const ent of layerEntities) {
      // If we reach ourselves first, we're the leader
      if (ent.id === entityId) {
        this.log(`  Reached self in lex order, staying leader`);
        return;
      }

      // Skip cluster_leader type (if any got through)
      if (ent.type === 'cluster_leader') continue;

      const peerState = this.entityStates.get(ent.id);
      if (peerState?.clusterId && peerState.clusterId !== myClusterId) {
        // Found a peer with a different cluster - join theirs
        this.log(`  Lex fallback: joining ${peerState.clusterId} via ${ent.id}`);

        // Remove from my cluster
        const myCluster = this.clusters.get(myClusterId);
        if (myCluster) {
          myCluster.members.delete(entityId);
          if (myCluster.members.size === 0) {
            this.clusters.delete(myClusterId);
          }
        }

        // Join their cluster
        this.joinCluster(entityId, peerState.clusterId);
        myState.isClusterLeader = false;
        return;
      }
    }

    // If we're the only one at this layer, dissolve
    const soloAtLayer = layerEntities.length === 1;
    if (soloAtLayer) {
      this.log(`  Truly alone at layer ${layer}, dissolving`);
      this.clusters.delete(myClusterId);
      myState.clusterId = null;
      myState.isClusterLeader = false;
    }
  }

  run(): void {
    // Schedule entity arrivals spread over time
    const shuffled = shuffle(this.entities, this.random);

    for (let i = 0; i < shuffled.length; i++) {
      const arrivalTime = Math.floor((i / shuffled.length) * this.config.arrivalSpreadMs);
      this.scheduleEvent({
        time: arrivalTime,
        type: 'entity_arrives',
        entityId: shuffled[i].id,
      });
    }

    // Process events
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift()!;
      this.currentTime = event.time;
      this.processEvent(event);
    }
  }

  getResults() {
    // Collect cluster stats
    const clusterSizes: number[] = [];
    for (const cluster of this.clusters.values()) {
      clusterSizes.push(cluster.members.size);
    }

    // Count unclustered
    let unclustered = 0;
    for (const state of this.entityStates.values()) {
      if (!state.clusterId) unclustered++;
    }

    // Distribution
    const distribution: Record<number, number> = {};
    for (const size of clusterSizes) {
      distribution[size] = (distribution[size] || 0) + 1;
    }

    return {
      config: this.config,
      totalEntities: this.entities.length,
      totalClusters: this.clusters.size,
      unclustered,
      avgClusterSize: clusterSizes.length > 0
        ? clusterSizes.reduce((a, b) => a + b, 0) / clusterSizes.length
        : 0,
      maxClusterSize: Math.max(0, ...clusterSizes),
      minClusterSize: clusterSizes.length > 0 ? Math.min(...clusterSizes) : 0,
      singletons: clusterSizes.filter(s => s === 1).length,
      distribution,
      clusters: Array.from(this.clusters.values()).map(c => ({
        id: c.id,
        size: c.members.size,
        members: Array.from(c.members),
      })),
    };
  }
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): SimConfig {
  const args = process.argv.slice(2);
  const config: SimConfig = {
    k: 5,
    arrivalSpreadMs: 5000,
    indexDelayMs: 1000,
    recheckDelayMs: 10000,
    followerWaitMinMs: 30000,
    followerWaitMaxMs: 90000,
    seed: Date.now(),
    verbose: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--k=')) {
      config.k = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--arrival-spread=')) {
      config.arrivalSpreadMs = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--index-delay=')) {
      config.indexDelayMs = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--recheck-delay=')) {
      config.recheckDelayMs = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--follower-wait-min=')) {
      config.followerWaitMinMs = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--follower-wait-max=')) {
      config.followerWaitMaxMs = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--seed=')) {
      config.seed = parseInt(arg.split('=')[1]);
    } else if (arg === '--verbose' || arg === '-v') {
      config.verbose = true;
    }
  }

  return config;
}

function main() {
  const config = parseArgs();

  // Load simulation data
  const dataPath = path.join(__dirname, 'data', 'simulation-data.json');
  if (!fs.existsSync(dataPath)) {
    console.error(`Simulation data not found at: ${dataPath}`);
    console.error('Run setup.ts first to fetch entities and compute similarities.');
    process.exit(1);
  }

  const data: SimulationData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`Loaded ${data.entities.length} entities from ${data.collectionId}`);
  console.log(`Config:`, config);
  console.log('');

  // Run simulation
  const sim = new ClusterSimulation(data, config);
  sim.run();

  // Print results
  const results = sim.getResults();

  console.log('\n' + '='.repeat(60));
  console.log('SIMULATION RESULTS');
  console.log('='.repeat(60));
  console.log(`Total entities: ${results.totalEntities}`);
  console.log(`Total clusters: ${results.totalClusters}`);
  console.log(`Unclustered: ${results.unclustered}`);
  console.log(`Singletons (size=1): ${results.singletons}`);
  console.log(`Avg cluster size: ${results.avgClusterSize.toFixed(2)}`);
  console.log(`Max cluster size: ${results.maxClusterSize}`);
  console.log(`Min cluster size: ${results.minClusterSize}`);

  console.log('\nSize distribution:');
  const sortedSizes = Object.keys(results.distribution).map(Number).sort((a, b) => a - b);
  for (const size of sortedSizes) {
    const count = results.distribution[size];
    const bar = '#'.repeat(Math.min(count, 50));
    console.log(`  Size ${size.toString().padStart(3)}: ${count.toString().padStart(3)} ${bar}`);
  }

  // Show largest clusters
  const sortedClusters = results.clusters.sort((a, b) => b.size - a.size);
  console.log('\nLargest clusters:');
  for (const cluster of sortedClusters.slice(0, 5)) {
    const entity = data.entities.find(e => e.id === cluster.members[0]);
    console.log(`  ${cluster.id}: ${cluster.size} members (first: "${entity?.label}")`);
  }
}

main();
