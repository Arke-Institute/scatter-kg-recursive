#!/usr/bin/env npx tsx
/**
 * Rhiza Workflow Registration Script
 *
 * Registers the scatter-kg workflow to Arke.
 *
 * Usage:
 *   ARKE_USER_KEY=uk_... npm run register              # Test network
 *   ARKE_USER_KEY=uk_... npm run register -- --prod    # Main network
 *   ARKE_USER_KEY=uk_... npm run register -- --dry-run # Preview only
 */

import * as fs from 'fs';
import * as path from 'path';
import { ArkeClient } from '@arke-institute/sdk';
import {
  syncRhiza,
  readState,
  writeState,
  getStateFilePath,
  findWorkspaceConfig,
  resolveWorkspaceCollection,
  type RhizaConfig,
  type RhizaRegistrationState,
  type DryRunResult,
  type SyncResult,
} from '@arke-institute/rhiza/registration';

// =============================================================================
// Configuration
// =============================================================================

const ARKE_USER_KEY = process.env.ARKE_USER_KEY;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Recursively substitute environment variables in workflow definitions.
 * Values starting with $ are replaced with the corresponding env var.
 */
function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    if (obj.startsWith('$')) {
      const envVar = obj.slice(1);
      const value = process.env[envVar];
      if (!value) {
        throw new Error(`Environment variable ${envVar} is not set`);
      }
      return value;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars);
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey =
        typeof key === 'string' && key.startsWith('$')
          ? (process.env[key.slice(1)] ?? key)
          : key;
      result[newKey] = substituteEnvVars(value);
    }
    return result;
  }

  return obj;
}

function isDryRunResult(
  result: SyncResult<RhizaRegistrationState> | DryRunResult
): result is DryRunResult {
  return (
    result.action === 'would_create' ||
    result.action === 'would_update' ||
    (result.action === 'unchanged' && !('state' in result))
  );
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  if (!ARKE_USER_KEY) {
    console.error('Error: ARKE_USER_KEY environment variable is required');
    process.exit(1);
  }

  // Get workflow name from args or default to scatter-kg
  const workflowArg = process.argv[2];
  const workflowName = workflowArg && !workflowArg.startsWith('--')
    ? workflowArg.replace(/\.json$/, '')
    : 'scatter-kg';

  const isProduction =
    process.argv.includes('--production') || process.argv.includes('--prod');
  const isDryRun = process.argv.includes('--dry-run');
  const migrateCollection = process.argv.includes('--migrate-collection');
  const network = isProduction ? 'main' : 'test';

  // Resolve workflow file
  const workflowFile = path.join('workflows', `${workflowName}.json`);

  if (!fs.existsSync(workflowFile)) {
    console.error(`Error: Workflow file not found: ${workflowFile}`);
    process.exit(1);
  }

  console.log(`\nScatter KG Registration (${network} network)${isDryRun ? ' [DRY RUN]' : ''}${migrateCollection ? ' [MIGRATE]' : ''}\n`);
  console.log(`Workflow: ${workflowName}`);

  // Load and parse workflow definition
  const rawContent = fs.readFileSync(workflowFile, 'utf-8');
  const rawWorkflow = JSON.parse(rawContent);

  // Substitute environment variables
  let config: RhizaConfig;
  try {
    config = substituteEnvVars(rawWorkflow) as RhizaConfig;
  } catch (error) {
    console.error(`\nError: ${(error as Error).message}`);
    console.error('Make sure all required environment variables are set.');
    console.error('Required: SCATTER_KLADOS, KG_EXTRACTOR_KLADOS, KG_DEDUPE_RESOLVER_KLADOS, KG_CLUSTER_KLADOS, DESCRIBE_KLADOS');
    process.exit(1);
  }

  console.log(`Label: ${config.label}`);
  console.log(`Version: ${config.version}`);
  console.log(`Entry: ${config.entry}`);
  console.log(`Steps: ${Object.keys(config.flow).length}`);
  for (const [stepName, step] of Object.entries(config.flow)) {
    console.log(`  - ${stepName}: ${step.klados.id}`);
  }
  console.log('');

  // Load existing state
  const stateFile = getStateFilePath(`.rhiza-state-${workflowName}`, network);
  const state = readState<RhizaRegistrationState>(stateFile);

  if (state) {
    console.log(`Found existing rhiza: ${state.rhiza_id}`);
  } else {
    console.log('Creating new rhiza...\n');
  }

  // Create client
  const client = new ArkeClient({ authToken: ARKE_USER_KEY, network });

  // Check for workspace config (shared collection across rhizai)
  const workspace = findWorkspaceConfig();
  let collectionId: string | undefined;
  let updatedState = state;

  if (workspace) {
    console.log(`Found workspace config: ${workspace.path}`);
    if (!isDryRun) {
      const resolved = await resolveWorkspaceCollection(client, network, workspace.path);
      collectionId = resolved.collectionId;
      if (!resolved.created) {
        console.log(`Using workspace collection: ${collectionId}`);
      }

      // Handle --migrate-collection: move existing rhiza to workspace collection
      if (migrateCollection && state && state.collection_id !== collectionId) {
        console.log(`\nMigrating rhiza from ${state.collection_id} to ${collectionId}...`);

        // Get current tip for CAS
        const { data: tipData, error: tipError } = await client.api.GET('/entities/{id}/tip', {
          params: { path: { id: state.rhiza_id } },
        });

        if (tipError || !tipData) {
          throw new Error(`Failed to get entity tip: ${tipError?.error || 'Unknown error'}`);
        }

        // Update rhiza with new collection using relationship changes
        const { error: updateError } = await client.api.PUT('/entities/{id}', {
          params: { path: { id: state.rhiza_id } },
          body: {
            expect_tip: tipData.cid,
            relationships_remove: [{ peer: state.collection_id, predicate: 'collection' }],
            relationships_add: [{ peer: collectionId, peer_type: 'collection', predicate: 'collection' }],
          } as any,
        });

        if (updateError) {
          throw new Error(`Failed to migrate rhiza: ${updateError.error || 'Unknown error'}`);
        }

        console.log(`  Migrated rhiza ${state.rhiza_id} to collection ${collectionId}`);
        updatedState = { ...state, collection_id: collectionId, updated_at: new Date().toISOString() };
        writeState(stateFile, updatedState);
        console.log(`  Updated local state`);
      } else if (migrateCollection && state && state.collection_id === collectionId) {
        console.log(`Rhiza already in workspace collection`);
      }
    } else {
      const networkConfig = workspace.config[network];
      if (networkConfig.collection_id) {
        collectionId = networkConfig.collection_id;
        console.log(`Would use workspace collection: ${collectionId}`);
        if (migrateCollection && state && state.collection_id !== collectionId) {
          console.log(`Would migrate rhiza from ${state.collection_id} to ${collectionId}`);
        }
      } else {
        console.log(`Would create workspace collection: ${networkConfig.collection_label}`);
      }
    }
    console.log('');
  } else if (migrateCollection) {
    console.warn('Warning: --migrate-collection requires a workspace config (.arke-workspace.json)');
    console.log('');
  }

  try {
    // Sync rhiza
    const result = await syncRhiza(client, config, updatedState, {
      network,
      dryRun: isDryRun,
      collectionId,
      collectionLabel: `Rhiza: ${config.label}`,
    });

    // Handle dry run result
    if (isDryRunResult(result)) {
      console.log(`\nWould: ${result.action}`);
      if (result.changes && result.changes.length > 0) {
        console.log('\nChanges:');
        for (const change of result.changes) {
          console.log(`  ${change.field}: ${change.from ?? '(none)'} -> ${change.to}`);
        }
      }
      console.log('\nRun without --dry-run to apply changes.');
      return;
    }

    // Handle actual sync result
    const { action, state: newState } = result;

    // Save state
    if (action !== 'unchanged') {
      writeState(stateFile, newState);
    }

    // Print result
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Rhiza ${action}!`);
    console.log(`${'='.repeat(60)}`);
    console.log(`   ID: ${newState.rhiza_id}`);
    console.log(`   Collection: ${newState.collection_id}`);
    console.log(`   Version: ${newState.version}`);
    console.log(`${'='.repeat(60)}\n`);

    if (action === 'created') {
      console.log(`Add to .env: SCATTER_KG_RHIZA=${newState.rhiza_id}`);
    }
  } catch (error) {
    console.error('\nRegistration failed:');
    console.error(`   ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main();
