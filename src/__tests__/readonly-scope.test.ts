import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authenticate } from '../auth.js';
import { tools, toolsForScope, handleToolCall } from '../tools/index.js';

const FULL = 'full-key-for-tests';
const RO = 'readonly-key-for-tests';

describe('authenticate', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.MCP_API_KEY = FULL;
    process.env.MCP_READONLY_API_KEY = RO;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('maps each key to its scope', () => {
    expect(authenticate({ 'x-api-key': FULL })).toBe('full');
    expect(authenticate({ 'x-api-key': RO })).toBe('readonly');
  });

  it('rejects missing, empty, wrong, and array-valued keys', () => {
    expect(authenticate({})).toBeNull();
    expect(authenticate({ 'x-api-key': '' })).toBeNull();
    expect(authenticate({ 'x-api-key': 'nope' })).toBeNull();
    expect(authenticate({ 'x-api-key': [FULL] })).toBeNull();
  });

  it('has no read-only scope when MCP_READONLY_API_KEY is unset', () => {
    delete process.env.MCP_READONLY_API_KEY;
    expect(authenticate({ 'x-api-key': RO })).toBeNull();
    expect(authenticate({ 'x-api-key': FULL })).toBe('full');
  });

  it('fails closed when MCP_API_KEY is unset, even for the read-only key', () => {
    delete process.env.MCP_API_KEY;
    expect(authenticate({ 'x-api-key': RO })).toBeNull();
  });

  it('never downgrades the full key when both keys are the same', () => {
    process.env.MCP_READONLY_API_KEY = FULL;
    expect(authenticate({ 'x-api-key': FULL })).toBe('full');
  });
});

describe('read-only tool scope', () => {
  // Every tool that changes state somewhere. Pinned here so reclassifying one is a visible diff.
  const WRITE_TOOLS = [
    'restart_deployment', 'reconcile_flux', 'refresh_secret', 'trigger_backup',
    'fix_jellyfin_metadata', 'touch_nas_path', 'update_pihole_gravity',
    'import_mealie_recipe_url', 'parse_mealie_recipe_ingredients',
    'retry_sabnzbd_download', 'pause_resume_sabnzbd',
    'search_radarr_movie', 'search_sonarr_episode', 'search_subtitles', 'reject_and_search',
  ];

  it('classifies exactly the pinned write tools as not read-only', () => {
    const writes = tools.filter((t) => !t.readOnly).map((t) => t.name).sort();
    expect(writes).toEqual([...WRITE_TOOLS].sort());
  });

  it('lists every tool for full scope and only read tools for read-only scope', () => {
    expect(toolsForScope('full')).toHaveLength(tools.length);
    const ro = toolsForScope('readonly').map((t) => t.name);
    expect(ro).toContain('get_cluster_health');
    for (const w of WRITE_TOOLS) expect(ro).not.toContain(w);
  });

  it('refuses a write tool called with read-only scope, the same way as an unknown tool', async () => {
    const res = await handleToolCall('restart_deployment', { namespace: 'x', name: 'y' }, 'readonly');
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: true, code: 'UNKNOWN_TOOL' });
  });
});
