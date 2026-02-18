/**
 * Diagnostic script to analyze why waitForWorkflowTree thinks workflow is incomplete
 *
 * Run with: npx tsx scripts/diagnose-tree.ts <job_collection_id>
 */

const JOB_COLLECTION = process.argv[2] || 'IIKHQ31B4VBAYK77SZAE1F9RXG';

interface LogEntry {
  id: string;
  properties: {
    status: string;
    klados_id: string;
    log_data: {
      entry: {
        handoffs?: Array<{
          type: string;
          outputs?: string[];
          invocations?: Array<unknown>;
          delegated?: boolean;
        }>;
      };
      messages?: Array<{ metadata?: { numCopies?: number } }>;
    };
  };
  relationships?: Array<{ predicate: string; peer: string }>;
}

interface TreeNode {
  id: string;
  status: string;
  kladosId: string;
  expectedChildren: number;
  actualChildren: number;
  children: TreeNode[];
  isTerminal: boolean;
  isLeaf: boolean;
  problem?: string;
}

const API_BASE = 'https://arke-v1.arke.institute';
const API_KEY = process.env.ARKE_USER_KEY!;

async function fetchEntity(id: string): Promise<LogEntry> {
  const res = await fetch(`${API_BASE}/entities/${id}`, {
    headers: { Authorization: `ApiKey ${API_KEY}` },
  });
  return res.json();
}

// Replicate the exact algorithm from logs.ts
function getExpectedChildrenCount(log: LogEntry): number {
  // Check log messages for numCopies
  const messages = log.properties.log_data.messages ?? [];
  for (const msg of messages) {
    if (msg.metadata?.numCopies !== undefined) {
      return msg.metadata.numCopies;
    }
  }

  const handoffs = log.properties.log_data.entry.handoffs ?? [];
  if (handoffs.length === 0) {
    return 0;
  }

  let total = 0;
  for (const handoff of handoffs) {
    if (handoff.type === 'invoke' || handoff.type === 'pass') {
      total += 1;
    } else if (handoff.type === 'scatter') {
      if (handoff.outputs && handoff.outputs.length > 0) {
        total += handoff.outputs.length;
      } else if (handoff.invocations && handoff.invocations.length > 0) {
        total += handoff.invocations.length;
      } else if (handoff.delegated) {
        total = -1;
        break;
      } else {
        total += 1;
      }
    } else if (handoff.type === 'gather') {
      total += 1;
    }
  }
  return total;
}

async function buildTreeNode(logId: string, visited: Set<string>): Promise<TreeNode | null> {
  if (visited.has(logId)) return null;
  visited.add(logId);

  const log = await fetchEntity(logId);
  const sentTo = (log.relationships ?? []).filter(r => r.predicate === 'sent_to');
  const actualChildren = sentTo.length;
  const expectedChildren = getExpectedChildrenCount(log);
  const isTerminal = log.properties.status === 'done' || log.properties.status === 'error';
  const isLeaf = log.properties.status === 'error' || (isTerminal && expectedChildren === 0);

  // Detect problems
  let problem: string | undefined;
  if (expectedChildren < 0) {
    problem = 'UNKNOWN_EXPECTED (-1)';
  } else if (isTerminal && actualChildren < expectedChildren) {
    problem = `MISSING_CHILDREN (expected=${expectedChildren}, actual=${actualChildren})`;
  } else if (!isTerminal) {
    problem = `NOT_TERMINAL (status=${log.properties.status})`;
  }

  // Recurse
  const children: TreeNode[] = [];
  for (const rel of sentTo) {
    const child = await buildTreeNode(rel.peer, visited);
    if (child) children.push(child);
  }

  return {
    id: logId,
    status: log.properties.status,
    kladosId: log.properties.klados_id,
    expectedChildren,
    actualChildren,
    children,
    isTerminal,
    isLeaf,
    problem,
  };
}

function collectProblems(node: TreeNode, depth = 0): Array<{ node: TreeNode; depth: number }> {
  const problems: Array<{ node: TreeNode; depth: number }> = [];
  if (node.problem) {
    problems.push({ node, depth });
  }
  for (const child of node.children) {
    problems.push(...collectProblems(child, depth + 1));
  }
  return problems;
}

function collectLeaves(node: TreeNode): TreeNode[] {
  if (node.children.length === 0) return [node];
  return node.children.flatMap(collectLeaves);
}

function checkAllChildrenDiscovered(node: TreeNode): { ok: boolean; reason?: string; nodeId?: string } {
  if (!node.isTerminal) {
    return { ok: true }; // Running nodes assumed OK
  }
  if (node.expectedChildren < 0) {
    return { ok: false, reason: 'expectedChildren is -1', nodeId: node.id };
  }
  if (node.children.length < node.expectedChildren) {
    return {
      ok: false,
      reason: `children.length (${node.children.length}) < expectedChildren (${node.expectedChildren})`,
      nodeId: node.id
    };
  }
  for (const child of node.children) {
    const result = checkAllChildrenDiscovered(child);
    if (!result.ok) return result;
  }
  return { ok: true };
}

async function main() {
  console.log('='.repeat(60));
  console.log('WORKFLOW TREE DIAGNOSTIC');
  console.log('='.repeat(60));
  console.log(`Job Collection: ${JOB_COLLECTION}`);
  console.log('');

  // Get root
  const collection = await fetchEntity(JOB_COLLECTION);
  const firstLogRel = (collection.relationships ?? []).find(r => r.predicate === 'first_log');
  if (!firstLogRel) {
    console.log('ERROR: No first_log relationship found');
    return;
  }

  console.log(`Root Log: ${firstLogRel.peer}`);
  console.log('');

  // Build tree
  console.log('Building tree...');
  const visited = new Set<string>();
  const root = await buildTreeNode(firstLogRel.peer, visited);

  if (!root) {
    console.log('ERROR: Could not build tree');
    return;
  }

  console.log(`Total logs discovered: ${visited.size}`);
  console.log('');

  // Analyze
  const leaves = collectLeaves(root);
  const allLeavesTerminal = leaves.every(l => l.isTerminal);
  const childrenCheck = checkAllChildrenDiscovered(root);
  const isComplete = allLeavesTerminal && childrenCheck.ok;

  console.log('='.repeat(60));
  console.log('COMPLETION ANALYSIS');
  console.log('='.repeat(60));
  console.log(`isComplete: ${isComplete}`);
  console.log(`allLeavesTerminal: ${allLeavesTerminal}`);
  console.log(`allChildrenDiscovered: ${childrenCheck.ok}`);
  if (!childrenCheck.ok) {
    console.log(`  -> Reason: ${childrenCheck.reason}`);
    console.log(`  -> Node: ${childrenCheck.nodeId}`);
  }
  console.log('');

  // Show non-terminal leaves
  const nonTerminalLeaves = leaves.filter(l => !l.isTerminal);
  if (nonTerminalLeaves.length > 0) {
    console.log('='.repeat(60));
    console.log(`NON-TERMINAL LEAVES (${nonTerminalLeaves.length})`);
    console.log('='.repeat(60));
    for (const leaf of nonTerminalLeaves) {
      console.log(`  ${leaf.id}: status=${leaf.status}, klados=${leaf.kladosId}`);
    }
    console.log('');
  }

  // Show all problems
  const problems = collectProblems(root);
  if (problems.length > 0) {
    console.log('='.repeat(60));
    console.log(`ALL PROBLEMS FOUND (${problems.length})`);
    console.log('='.repeat(60));
    for (const { node, depth } of problems) {
      const indent = '  '.repeat(depth);
      console.log(`${indent}${node.id}:`);
      console.log(`${indent}  status: ${node.status}`);
      console.log(`${indent}  klados: ${node.kladosId}`);
      console.log(`${indent}  expected: ${node.expectedChildren}, actual: ${node.actualChildren}`);
      console.log(`${indent}  PROBLEM: ${node.problem}`);
    }
    console.log('');
  }

  // Show tree structure summary
  console.log('='.repeat(60));
  console.log('TREE STRUCTURE (first 3 levels)');
  console.log('='.repeat(60));

  function printTree(node: TreeNode, depth: number, maxDepth: number) {
    if (depth > maxDepth) return;
    const indent = '  '.repeat(depth);
    const status = node.isTerminal ? '✓' : '○';
    const warn = node.problem ? ' ⚠️' : '';
    console.log(`${indent}${status} ${node.id.slice(-8)} [${node.status}] exp=${node.expectedChildren} act=${node.actualChildren}${warn}`);
    for (const child of node.children.slice(0, 3)) {
      printTree(child, depth + 1, maxDepth);
    }
    if (node.children.length > 3) {
      console.log(`${indent}  ... and ${node.children.length - 3} more children`);
    }
  }

  printTree(root, 0, 3);

  // Proposed simple algorithm
  console.log('');
  console.log('='.repeat(60));
  console.log('SIMPLE ALGORITHM CHECK');
  console.log('='.repeat(60));

  const allLogsTerminal = [...visited].every(async id => {
    // We already have this data from building the tree
    return true; // placeholder
  });

  let terminalCount = 0;
  let runningCount = 0;

  function countStatus(node: TreeNode) {
    if (node.isTerminal) terminalCount++;
    else runningCount++;
    node.children.forEach(countStatus);
  }
  countStatus(root);

  console.log(`Terminal logs: ${terminalCount}`);
  console.log(`Running logs: ${runningCount}`);
  console.log(`Simple isComplete (all terminal): ${runningCount === 0}`);
}

main().catch(console.error);
