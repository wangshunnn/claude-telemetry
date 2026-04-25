import { describe, expect, it } from 'vitest';
import { dashboardTaskMatchesFilter } from '../scripts/dashboard.mjs';

const baseTask = {
  sessionId: 'session-1',
  displayId: 'session-1#1',
  prompt: 'Review dashboard telemetry',
  status: 'success',
  knowledgeCount: 1,
  approvalCount: 0,
  knowledgeTargets: [{ label: 'docs/guide.md', kindLabel: 'Docs' }],
  events: [{ label: 'read', detail: 'docs/guide.md', key: 'tool_read' }],
};

describe('dashboardTaskMatchesFilter', () => {
  it('matches hit and miss tasks by knowledge count', () => {
    expect(dashboardTaskMatchesFilter(baseTask, 'hit')).toBe(true);
    expect(dashboardTaskMatchesFilter(baseTask, 'miss')).toBe(false);
    expect(dashboardTaskMatchesFilter({ ...baseTask, knowledgeCount: 0 }, 'miss')).toBe(true);
  });

  it('matches approval and attention filters', () => {
    expect(dashboardTaskMatchesFilter({ ...baseTask, approvalCount: 2 }, 'approval')).toBe(true);
    expect(dashboardTaskMatchesFilter(baseTask, 'approval')).toBe(false);
    expect(dashboardTaskMatchesFilter({ ...baseTask, status: 'failure' }, 'attention')).toBe(true);
    expect(dashboardTaskMatchesFilter({ ...baseTask, status: 'open' }, 'attention')).toBe(true);
    expect(dashboardTaskMatchesFilter(baseTask, 'attention')).toBe(false);
  });

  it('searches session, prompt, target, and event text', () => {
    expect(dashboardTaskMatchesFilter(baseTask, 'all', 'session-1')).toBe(true);
    expect(dashboardTaskMatchesFilter(baseTask, 'all', 'telemetry')).toBe(true);
    expect(dashboardTaskMatchesFilter(baseTask, 'all', 'guide.md')).toBe(true);
    expect(dashboardTaskMatchesFilter(baseTask, 'all', 'tool_read')).toBe(true);
    expect(dashboardTaskMatchesFilter(baseTask, 'all', 'not-present')).toBe(false);
  });
});
