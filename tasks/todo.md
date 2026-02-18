# Add JSON Retry with Error Feedback to Describe Worker

## Problem

When Gemini returns malformed JSON, the describe worker:
1. Tries to parse it
2. On failure, silently degrades to using raw content as description
3. This produces garbage output (raw JSON text as description)

**Example error:**
```
[Gemini] Failed to parse JSON response: SyntaxError: Expected ',' or '}' after property value in JSON at position 1407
```

## Solution

Add retry logic that:
1. Catches JSON parsing errors
2. Retries up to 3 times
3. Includes the error AND previous response in retry prompt so model can correct itself

## Implementation

### Files to Modify

#### 1. `core/describe/src/gemini.ts`

**Add new function** `callGeminiWithJsonRetry`:

```typescript
const JSON_PARSE_MAX_RETRIES = 3;

/**
 * Call Gemini and parse JSON response with retry on parse failure
 *
 * If JSON parsing fails, retries with error context appended to prompt
 * so the model can correct its output.
 */
export async function callGeminiWithJsonRetry(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ response: GeminiResponse; result: DescribeResult }> {
  let lastResponse: GeminiResponse | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < JSON_PARSE_MAX_RETRIES; attempt++) {
    // Build prompt - append error context if retrying
    let effectiveUserPrompt = userPrompt;
    if (lastResponse && lastError) {
      effectiveUserPrompt += `

## RETRY - JSON PARSE ERROR

Your previous response could not be parsed as valid JSON.

**Error:** ${lastError}

**Your response was:**
\`\`\`
${lastResponse.content.slice(0, 2000)}${lastResponse.content.length > 2000 ? '...[truncated]' : ''}
\`\`\`

Please provide a valid JSON response with the required fields: title, description${config.update_label ? ', label' : ''}.`;
    }

    // Call Gemini (has its own retry for HTTP errors)
    const response = await callGemini(apiKey, systemPrompt, effectiveUserPrompt);

    // Try to parse JSON
    try {
      const parsed = JSON.parse(response.content);

      // Validate required fields
      if (typeof parsed.description !== 'string') {
        throw new Error('Missing or invalid "description" field');
      }

      console.log(`[Gemini] JSON parsed successfully${attempt > 0 ? ` (after ${attempt + 1} attempts)` : ''}`);

      return {
        response,
        result: {
          description: parsed.description,
          title: parsed.title,
          label: parsed.label,
        }
      };
    } catch (e) {
      lastResponse = response;
      lastError = e instanceof Error ? e.message : String(e);

      console.error(`[Gemini] JSON parse failed (attempt ${attempt + 1}/${JSON_PARSE_MAX_RETRIES}):`, lastError);

      if (attempt < JSON_PARSE_MAX_RETRIES - 1) {
        console.log('[Gemini] Retrying with error feedback...');
      }
    }
  }

  // All retries exhausted - throw error
  throw new Error(
    `Failed to get valid JSON after ${JSON_PARSE_MAX_RETRIES} attempts. ` +
    `Last error: ${lastError}. ` +
    `Last response preview: ${lastResponse?.content.slice(0, 200)}...`
  );
}
```

**Keep existing functions** for backwards compatibility:
- `callGemini` - unchanged (HTTP-level retry)
- `parseDescribeResult` - can be removed or kept for other uses

#### 2. `core/describe/src/job.ts`

**Update GENERATE phase** to use new function:

```typescript
// Before:
const geminiResponse = await callGemini(env.GEMINI_API_KEY, systemPrompt, userPrompt);
const result = parseDescribeResult(geminiResponse.content);

// After:
const { response: geminiResponse, result } = await callGeminiWithJsonRetry(
  env.GEMINI_API_KEY,
  systemPrompt,
  userPrompt
);
```

**Update import:**
```typescript
import { callGeminiWithJsonRetry } from './gemini';
```

### Design Decisions

1. **Why append to user prompt instead of system prompt?**
   - System prompt defines behavior; user prompt is the "conversation"
   - The error context is like saying "try again, here's what went wrong"
   - Keeps system prompt stable across retries

2. **Why truncate the previous response in retry?**
   - Avoid doubling token usage
   - 2000 chars is enough for model to see the issue
   - Prevents context overflow on multiple retries

3. **Why throw error instead of fallback to raw content?**
   - Silent degradation produces garbage descriptions
   - Better to fail loudly so workflow marks as error
   - User can investigate and fix root cause

4. **Why 3 retries?**
   - Matches existing HTTP retry count
   - Usually first retry with error context fixes it
   - Balances cost vs reliability

### Testing

1. Deploy updated describe worker
2. Run scatter-kg tests
3. If JSON errors occur, logs should show retry attempts
4. All tests should pass (no more silent degradation)

## Verification

After implementation:
```bash
cd /Users/chim/Working/arke_institute/rhiza-klados/arke-kladoi/core/describe
npm run deploy
cd /Users/chim/Working/arke_institute/rhiza-klados/arke-kladoi/rhizai/scatter-kg
npm test
```

Expected: Any JSON parse errors should retry with feedback and either succeed or fail loudly.
