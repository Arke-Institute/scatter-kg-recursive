# Scatter KG Recursive Workflow

Recursive version of the scatter-kg workflow that builds hierarchical knowledge graph clusters.

## Overview

This workflow extends the standard scatter-kg workflow with recursive clustering:

1. **scatter** - Dispatches entity IDs in parallel
2. **extract** - KG extractor processes entities (creates layer 0 entities)
3. **dedupe** - Deduplicates extracted entities
4. **cluster** - Groups similar entities into clusters (layer N+1)
5. **describe** - Describes each cluster
6. **recurse** - Clusters go back to step 4, creating a hierarchy

The recursion continues until clusters have no peers at their layer, forming a hierarchical tree structure.

## Flow

```
scatter → extract → dedupe → cluster → describe ⟲
                                ↑          ↓
                                └── cluster ┘
```

Each layer of clusters is described before being clustered into the next level.

## Example Hierarchy

```
Layer 0: A, B, C, D (original entities)
         ↓ cluster
Layer 1: X, Y (clusters with 2 members each)
         ↓ describe → recurse → cluster
Layer 2: Z (single cluster containing X and Y)
         ↓ describe → recurse → cluster
         Z has no peers → terminates
```

## Commands

```bash
npm install              # Install dependencies
npm run type-check       # TypeScript validation

# Registration (requires ARKE_USER_KEY and klados IDs in .env)
npm run register         # Register workflow to test network

# Testing
npm test                 # Run E2E tests
```

## Environment Variables

Create a `.env` file with:

```
ARKE_USER_KEY=uk_...
SCATTER_KLADOS=...
KG_EXTRACTOR_KLADOS=...
KG_DEDUPE_RESOLVER_KLADOS=...
KG_CLUSTER_KLADOS=...
DESCRIBE_KLADOS=...
```

## Termination Conditions

- **No peers at layer**: Cluster finds no similar entities → returns `[]` → branch terminates
- **Joined existing cluster**: Entity joins another cluster → returns `[]` → branch terminates
- **Max depth reached**: Safety limit of 10 recursion levels

## Differences from scatter-kg

| Feature | scatter-kg | scatter-kg-recursive |
|---------|------------|---------------------|
| Clustering | Single layer | Hierarchical (multi-layer) |
| Describe | Once per cluster | Once per cluster per layer |
| Termination | After describe | When no peers to cluster |
